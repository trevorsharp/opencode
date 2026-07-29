import type { AppProcess } from "@opencode-ai/core/process"
import { errorMessage } from "@/util/error"
import type { Provider } from "@/provider/provider"
import { ClaudeCLI } from "@/provider/claude-cli"
import type { ModelMessage, Tool } from "ai"
import { Duration, Effect } from "effect"
import * as Stream from "effect/Stream"
import { LLMEvent, ToolRuntime } from "@opencode-ai/llm"
import type { ChildProcess } from "effect/unstable/process"
import { LLMNativeRuntime } from "./native-runtime"
import { LLMRequestPrep } from "./request"
import { LLMExternalClaudeCLI } from "./external-claude-cli"

/** One external execution: a single prompt handed to a local agent process. */
export type Turn = {
  readonly model: Provider.Model
  readonly variant?: string
  readonly directory: string
  readonly prompt: string
  readonly system?: string
  readonly schema?: Record<string, any>
}

export interface Translator {
  /** Ordered model events for one line of external output. */
  readonly line: (line: string) => ReadonlyArray<LLMEvent>
  /** True once the output has reported the end of the turn. */
  readonly complete: () => boolean
  /** Terminal events for an execution that exited successfully. */
  readonly settle: () => ReadonlyArray<LLMEvent>
}

export interface Adapter {
  readonly id: string
  readonly command: (turn: Turn) => ChildProcess.Command
  readonly translate: () => Translator
  /** Milliseconds of silence after which the execution is considered stuck. */
  readonly idleTimeout: number
}

/**
 * Diagnostics kept from a failed execution. Stderr is buffered until the process
 * exits, so a noisy agent must not be able to grow that buffer without bound.
 */
const MAX_ERROR_BYTES = 64 * 1024

const ADAPTERS: Record<string, Adapter> = {
  [ClaudeCLI.EXECUTION]: LLMExternalClaudeCLI.adapter,
}

/** The external runtime owns models whose execution type names a local agent. */
export function select(model: Provider.Model): Adapter | undefined {
  return ADAPTERS[model.api.npm]
}

export type StreamInput = {
  readonly adapter: Adapter
  readonly turn: Omit<Turn, "prompt">
  readonly messages: ModelMessage[]
  readonly tools: Record<string, Tool>
  readonly process: AppProcess.Interface
  readonly abort: AbortSignal
  /** Overrides the adapter's idle timeout; a non-positive value disables it. */
  readonly idleTimeout?: number
}

const messageText = (message: ModelMessage) => {
  if (typeof message.content === "string") return message.content
  if (!Array.isArray(message.content)) return ""
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim()
}

/**
 * External agents accept one prompt per execution, so the request collapses into
 * the text of its user messages. History that only a previous external turn could
 * explain is rejected instead of being silently dropped, because multi-turn
 * continuation is out of scope.
 *
 * A structured-output request is exempt: its retries re-ask the same question,
 * appending the retry instruction as another user turn, so the collapse re-prompts
 * the agent rather than continuing the turn that failed to produce output.
 */
function prompt(messages: ModelMessage[], structured: boolean) {
  const continued =
    LLMRequestPrep.hasToolCalls(messages) ||
    messages.some((message) => message.role === "assistant" && messageText(message))
  if (continued && !structured) {
    throw new Error("external models support a single prompt per session; continuing an earlier turn is unsupported")
  }
  const text = messages
    .filter((message) => message.role === "user")
    .map(messageText)
    .filter((value) => value)
    .join("\n\n")
  if (!text) throw new Error("external models require a text prompt")
  return text
}

/**
 * Run one external execution as a normal model event stream.
 *
 * The runtime owns process lifetime, event ordering, settlement, and dispatch of
 * the tools opencode still executes itself. Everything about the external agent
 * — arguments, output format, tool naming, structured output — lives in its
 * adapter. Cancellation flows from `abort`: the spawner kills the process group
 * when the stream scope closes, and no events are admitted after settlement. A
 * silent execution settles the same way once its idle timeout expires.
 */
export function stream(input: StreamInput): Stream.Stream<LLMEvent, unknown> {
  return Stream.unwrap(
    Effect.gen(function* () {
      if (input.abort.aborted) return yield* Effect.fail(new Error("request was cancelled before it started"))
      const translator = input.adapter.translate()
      const tools = LLMNativeRuntime.nativeTools(input.tools, input)
      const command = yield* Effect.try({
        try: () =>
          input.adapter.command({
            ...input.turn,
            prompt: prompt(input.messages, input.turn.schema !== undefined),
          }),
        catch: (error) => new Error(errorMessage(error)),
      })

      let settled = false
      const admit = (event: LLMEvent) => {
        if (settled) return false
        if (LLMEvent.is.finish(event)) settled = true
        return true
      }
      // Tools the external agent ran itself are already settled; anything else it
      // asks for is executed by opencode, in order, before the stream continues.
      const expand = (events: ReadonlyArray<LLMEvent>) =>
        Effect.gen(function* () {
          const admitted: LLMEvent[] = []
          for (const event of events) {
            if (!admit(event)) continue
            admitted.push(event)
            if (!LLMEvent.is.toolCall(event) || event.providerExecuted) continue
            const dispatched = yield* ToolRuntime.dispatch(tools, event)
            for (const result of dispatched.events) if (admit(result)) admitted.push(result)
          }
          return admitted
        })
      const translate = (produce: () => ReadonlyArray<LLMEvent>) =>
        Effect.try({ try: produce, catch: (error) => new Error(errorMessage(error)) }).pipe(Effect.flatMap(expand))

      // An execution that neither speaks nor exits is stuck, and nothing else
      // will end the turn, so the runtime stops waiting and fails it.
      const idleTimeout = input.idleTimeout ?? input.adapter.idleTimeout
      const output = input.process.runStream(command, {
        signal: input.abort,
        okExitCodes: [0],
        maxErrorBytes: MAX_ERROR_BYTES,
      })
      const watched =
        idleTimeout > 0
          ? output.pipe(
              Stream.timeoutOrElse({
                duration: Duration.millis(idleTimeout),
                orElse: () =>
                  Stream.fail(
                    new Error(
                      `${input.adapter.id} produced no output for ${Duration.format(Duration.millis(idleTimeout))}`,
                    ),
                  ),
              }),
            )
          : output

      return Stream.make(LLMEvent.stepStart({ index: 0 })).pipe(
        Stream.concat(
          watched.pipe(
            Stream.mapEffect((line) => translate(() => translator.line(line))),
            // Once the output reports the end of the turn there is nothing left to
            // read: waiting for the process to exit would let a lingering agent
            // stall a finished turn until its idle timeout.
            Stream.takeUntil(() => translator.complete()),
            Stream.flatMap((events) => Stream.fromIterable(events)),
          ),
        ),
        Stream.concat(Stream.unwrap(translate(() => translator.settle()).pipe(Effect.map(Stream.fromIterable)))),
      )
    }),
  )
}

export * as LLMExternalRuntime from "./external-runtime"
