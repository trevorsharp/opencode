import type { AppProcess } from "@opencode-ai/core/process"
import { errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"
import type { Provider } from "@/provider/provider"
import type { Question } from "@/question"
import type { SessionTodo } from "@opencode-ai/schema/session-todo"
import { ClaudeCLI } from "@/provider/claude-cli"
import { asSchema, jsonSchema, tool, type ModelMessage, type Tool } from "ai"
import { Duration, Effect, Fiber, Scope } from "effect"
import * as Stream from "effect/Stream"
import { LLMEvent, ToolRuntime } from "@opencode-ai/llm"
import type { ChildProcess } from "effect/unstable/process"
import { LLMExternalMCP } from "./external-mcp"
import { LLMNativeRuntime } from "./native-runtime"
import { LLMRequestPrep } from "./request"
import { LLMExternalClaudeCLI } from "./external-claude-cli"

/** One external execution: a single prompt handed to a local agent process. */
export type Turn = {
  readonly model: Provider.Model
  readonly variant?: string
  readonly directory: string
  readonly prompt: ReadonlyArray<PromptPart>
  readonly resumeSessionID?: string
  readonly system?: string
  readonly schema?: Record<string, any>
  /**
   * The session todos an adapter may project the external agent's own bookkeeping
   * onto, and the list it has to preserve while doing so. Absent when the agent's
   * permissions do not allow opencode's todo tool to run, in which case
   * bookkeeping stays ordinary tool activity.
   */
  readonly todos?: ReadonlyArray<SessionTodo.Info>
  /** The step of the assistant turn this execution ends; a turn may spend several. */
  readonly step: number
  /** The opencode tools this execution offers the agent, when the turn exposes any. */
  readonly facade?: TurnFacade
}

/**
 * The opencode tool facade one external execution exposes.
 *
 * The adapter points the agent at `config` — a strict MCP configuration naming
 * only the facade, whose token the child expands from `env` so it never appears in
 * argv — and translates the agent's facade calls through the rest. The agent's own
 * call id is the canonical opencode call id, so one facade call is executed once
 * and appears as exactly one call/result pair.
 */
export interface TurnFacade {
  readonly config: string
  readonly token: string
  readonly env: string
  /** The opencode tool a facade tool name refers to, or undefined when it is not one. */
  readonly resolve: (name: string) => string | undefined
  /**
   * Adopts the agent's call id, name, and arguments for a facade call opencode is
   * about to run. False when that id can no longer identify one call, so the report
   * must be dropped instead of executed.
   */
  readonly called: (id: string, name: string, input: unknown) => boolean
  /** True once opencode owns a call's settlement, so the agent's own result is not one. */
  readonly owned: (id: string) => boolean
}

export type PromptPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "file"; readonly mediaType: string; readonly data: unknown }

export interface Translator {
  /** Ordered model events for one line of external output. */
  readonly line: (line: string) => ReadonlyArray<LLMEvent>
  /** True once the output has reported the end of the turn. */
  readonly complete: () => boolean
  /** Terminal events for an execution that exited successfully. */
  readonly settle: () => ReadonlyArray<LLMEvent>
  /** The agent's durable conversation id for this execution, once its output names one. */
  readonly session?: () => string | undefined
}

export interface Adapter {
  readonly id: string
  readonly command: (turn: Turn) => ChildProcess.Command
  readonly translate: (turn: Omit<Turn, "prompt">) => Translator
  readonly toolDescriptionLimit?: number
  /** Milliseconds of silence after which the execution is considered stuck. */
  readonly idleTimeout: number
}

/**
 * A provider-executed tool call an adapter still needs opencode to run: the
 * external agent already performed the work, so opencode owes it no result and
 * the turn must not continue on its account, but the effect only reaches opencode
 * by executing the tool. An adapter asks for that with `dispatch` inside its own
 * `providerMetadata` namespace.
 */
function dispatchRequested(adapter: string, event: Extract<LLMEvent, { type: "tool-call" }>) {
  const metadata = event.providerMetadata?.[adapter]
  return isRecord(metadata) && metadata.dispatch === true
}

/**
 * Diagnostics kept from a failed execution. Stderr is buffered until the process
 * exits, so a noisy agent must not be able to grow that buffer without bound.
 */
const MAX_ERROR_BYTES = 64 * 1024

const TOOL_HELP = "tool_help"

const TOOL_HELP_DESCRIPTION =
  "Get the complete description of a tool whose shorter description directs you here. Call this before using that tool."

/**
 * The opencode tools the facade offers, on top of the tools opencode's own MCP
 * servers provide. Everything the external agent already has natively — reading,
 * editing, searching, running commands, its own bookkeeping and skills — stays
 * native, so the facade only carries what the agent cannot otherwise reach.
 */
const FACADE_TOOLS = [
  "notify",
  "workflow_run",
  "workflow_status",
  "workflow_cancel",
  "schedule_create",
  "schedule_list",
  "schedule_status",
  "schedule_cancel",
]

/** Only a session the user is actually watching has someone to ask. */
const FACADE_ROOT_TOOLS = ["question"]

/**
 * The one facade tool opencode keeps running after the agent's execution ends: a
 * user answers in their own time, and no MCP request may be held open for that.
 */
const DEFERRED_TOOL = "question"

const DEFERRED_RESULT =
  "The questions are now in front of the user. End your turn immediately without any further work or commentary; the user's answers arrive as the next prompt in this same conversation."

/** How long a facade call waits to be matched with the call the agent reported. */
const RENDEZVOUS_MS = 60_000

/** Executions one turn may spend, so a repeatedly asking agent still settles. */
const MAX_EXECUTIONS = 4

/** Facade tool names reach the agent as `mcp__opencode__<name>`, case intact. */
const FACADE_PREFIX = `mcp__${LLMExternalMCP.SERVER}__`

const ADAPTERS: Record<string, Adapter> = {
  [ClaudeCLI.EXECUTION]: LLMExternalClaudeCLI.adapter,
}

/** The external runtime owns models whose execution type names a local agent. */
export function select(model: Provider.Model): Adapter | undefined {
  return ADAPTERS[model.api.npm]
}

export type StreamInput = {
  readonly adapter: Adapter
  readonly turn: Omit<Turn, "prompt" | "step">
  readonly messages: ModelMessage[]
  readonly promptMessages?: ModelMessage[]
  readonly tools: Record<string, Tool>
  readonly process: AppProcess.Interface
  readonly abort: AbortSignal
  /** Overrides the adapter's idle timeout; a non-positive value disables it. */
  readonly idleTimeout?: number
  /** Absent for a session the user is watching directly. */
  readonly parentSessionID?: string
  /** Pending questions a cancelled turn has to take back. */
  readonly questions: Pick<Question.Interface, "list" | "reject">
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
 * External agents accept one prompt per execution. A resumed execution receives
 * only the newest user message because the agent owns its durable history.
 * Otherwise, history that only a previous external turn could explain is rejected
 * instead of being silently dropped.
 *
 * A structured-output request is exempt: its retries re-ask the same question,
 * appending the retry instruction as another user turn, so the collapse re-prompts
 * the agent rather than continuing the turn that failed to produce output.
 */
function prompt(messages: ModelMessage[], structured: boolean, resumeSessionID?: string): ReadonlyArray<PromptPart> {
  const newest = messages.findLast((message) => message.role === "user")
  const selected = resumeSessionID ? (newest ? [newest] : []) : messages.filter((message) => message.role === "user")
  const continued =
    LLMRequestPrep.hasToolCalls(messages) ||
    messages.some((message) => message.role === "assistant" && messageText(message))
  if (!resumeSessionID && continued && !structured) {
    throw new Error("external model history requires an exact resumable conversation boundary")
  }
  const hasFiles = selected.some(
    (message) => Array.isArray(message.content) && message.content.some((part) => part.type === "file"),
  )
  if (!hasFiles) {
    const text = selected
      .map(messageText)
      .filter((value) => value)
      .join("\n\n")
    if (!text) throw new Error("external models require a prompt")
    return [{ type: "text", text }]
  }
  const parts = selected.flatMap((message, index): PromptPart[] => {
    const separator: PromptPart[] = index === 0 ? [] : [{ type: "text", text: "\n\n" }]
    if (typeof message.content === "string") return [...separator, { type: "text", text: message.content }]
    if (!Array.isArray(message.content)) return separator
    return [
      ...separator,
      ...message.content.flatMap((part): PromptPart[] => {
        if (part.type === "text") return part.text ? [{ type: "text", text: part.text }] : []
        if (part.type === "file") return [{ type: "file", mediaType: part.mediaType, data: part.data }]
        return []
      }),
    ]
  })
  if (!parts.some((part) => part.type === "file" || part.text.trim()))
    throw new Error("external models require a prompt")
  return parts
}

/**
 * The opencode tools one turn exposes through the facade, and the names it refuses
 * to expose.
 *
 * Provenance is read from the resolved tool map itself — the map that actually runs
 * — where opencode's MCP tools are the dynamic ones. A fixed-catalog name held by an
 * MCP tool has no provable implementation, since assembly order alone decided which
 * one the map kept, so neither is offered rather than running the wrong tool.
 */
function catalog(input: StreamInput) {
  const mcp = (name: string) => input.tools[name]?.type === "dynamic"
  const reserved = [...FACADE_TOOLS, ...(input.parentSessionID ? [] : FACADE_ROOT_TOOLS), TOOL_HELP]
  const limit = input.adapter.toolDescriptionLimit
  const help = new Map<string, string>()
  const tools = Object.keys(input.tools)
    .filter((name) => name !== TOOL_HELP)
    .filter((name) => (mcp(name) ? !reserved.includes(name) : reserved.includes(name)))
    .flatMap((name) => {
      const item = input.tools[name]
      if (!item?.execute) return []
      const description = item.description ?? ""
      if (limit === undefined || Buffer.byteLength(description) <= limit)
        return [{ name, description, inputSchema: toolSchema(item.inputSchema) }]
      help.set(name, description)
      return [{ name, description: shortDescription(description, limit), inputSchema: toolSchema(item.inputSchema) }]
    })
  if (help.size)
    tools.push({
      name: TOOL_HELP,
      description: TOOL_HELP_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", enum: [...help.keys()] } },
        required: ["name"],
        additionalProperties: false,
      },
    })
  return {
    ambiguous: [...new Set([...reserved.filter(mcp), ...(input.tools[TOOL_HELP] ? [TOOL_HELP] : [])])],
    help,
    tools,
  }
}

function shortDescription(description: string, limit: number) {
  const suffix = `\n\nThis description exceeds Claude Code's MCP limit. You MUST call ${FACADE_PREFIX}${TOOL_HELP} with this tool's name before using it.`
  const budget = Math.max(0, limit - Buffer.byteLength(suffix))
  const bytes = Buffer.from(description)
  const end = (() => {
    if (bytes.length <= budget) return bytes.length
    let index = budget
    while (index > 0 && (bytes[index] & 0xc0) === 0x80) index--
    return index
  })()
  const prefix = bytes.subarray(0, end).toString("utf8").trimEnd()
  return Buffer.byteLength(suffix) > limit ? Buffer.from(suffix).subarray(0, limit).toString("utf8") : prefix + suffix
}

function toolSchema(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return { type: "object", properties: {} }
  if ("jsonSchema" in value && isRecord(value.jsonSchema)) return value.jsonSchema
  const schema = asSchema(value as Parameters<typeof asSchema>[0]).jsonSchema
  return isRecord(schema) ? schema : { type: "object", properties: {} }
}

/**
 * Matches the facade calls the agent makes over MCP with the tool calls opencode
 * reads from its output.
 *
 * Either side can arrive first, so whichever does opens the slot. The agent's
 * output is what actually drives execution: a call opencode never saw reported
 * there is refused instead of run as invisible activity, and so is a call whose
 * reported name or arguments disagree with the request. A call id identifies one
 * call, so a repeated one is refused rather than executed again.
 */
function rendezvous(names: ReadonlySet<string>) {
  type Slot = {
    name?: string
    /** The arguments the agent reported, which are the ones opencode runs. */
    input?: unknown
    /**
     * Why the call can never be executed, once that is decided. The agent has read
     * a refusal by then, so output arriving afterwards must not run the tool: that
     * would be a second, unreported attempt at whatever was refused.
     */
    refused?: string
    /** Set once opencode has taken the call to run, so it can never be taken twice. */
    claimed?: boolean
    readonly called: PromiseWithResolvers<void>
    readonly settled: PromiseWithResolvers<LLMExternalMCP.Result>
  }
  const slots = new Map<string, Slot>()
  const owned = new Set<string>()
  const slot = (id: string) => {
    const existing = slots.get(id)
    if (existing) return existing
    const created: Slot = { called: Promise.withResolvers(), settled: Promise.withResolvers() }
    slots.set(id, created)
    return created
  }
  const refuse = (text: string): LLMExternalMCP.Result => ({ isError: true, content: [{ type: "text", text }] })
  const aborted = (signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve()
      signal.addEventListener("abort", () => resolve(), { once: true })
    })
  // Unreferenced, so a call still waiting to be matched cannot keep the process
  // alive once the turn that would have matched it is over.
  const expire = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref())

  return {
    resolve: (name: string) => {
      if (!name.startsWith(FACADE_PREFIX)) return undefined
      const stripped = name.slice(FACADE_PREFIX.length)
      return names.has(stripped) ? stripped : undefined
    },
    called: (id: string, name: string, input: unknown) => {
      const entry = slot(id)
      // The agent has read a refusal for this call, so it will never run, but the
      // attempt and the error it was answered with still belong in the transcript.
      if (entry.refused) return true
      // A repeated id is not a second call: opencode cannot tell which report a
      // request belongs to, so nothing under that id runs again and the repeat is
      // not reported as activity of its own.
      if (entry.name !== undefined) {
        entry.refused = "opencode observed this call id more than once"
        entry.settled.resolve(refuse(entry.refused))
        return false
      }
      entry.name = name
      entry.input = input
      entry.called.resolve()
      return true
    },
    /** Takes a reported call to run, which only the first observation of it may do. */
    claim: (id: string) => {
      const entry = slots.get(id)
      if (!entry || entry.refused || entry.name === undefined || entry.claimed) return false
      entry.claimed = true
      return true
    },
    owned: (id: string) => owned.has(id),
    settle: (id: string, result: LLMExternalMCP.Result) => {
      owned.add(id)
      slot(id).settled.resolve(result)
    },
    close: () => {
      for (const entry of slots.values()) {
        entry.refused ??= "opencode ended this turn before the call settled"
        entry.called.resolve()
        entry.settled.resolve(refuse(entry.refused))
      }
    },
    call: async (call: LLMExternalMCP.Call) => {
      // A name the facade never offered can never be matched, so it is refused
      // without waiting for output that will never describe it.
      if (!names.has(call.name)) return refuse(`opencode does not offer a tool named "${call.name}"`)
      const entry = slot(call.id)
      await Promise.race([entry.called.promise, expire(RENDEZVOUS_MS), aborted(call.signal)])
      if (entry.refused) return refuse(entry.refused)
      if (entry.name !== call.name) {
        entry.refused = `opencode did not observe a "${call.name}" call with this id in the agent's own output`
        return refuse(entry.refused)
      }
      // The reported arguments are the ones opencode runs, so a request that
      // disagrees with them is a different call wearing an observed call's id.
      if (canonical(entry.input) !== canonical(call.input)) {
        entry.refused = `opencode observed different arguments for this "${call.name}" call in the agent's own output`
        return refuse(entry.refused)
      }
      // Cancellation only ends the agent's wait: the call is already in opencode's
      // transcript, and abandoning a half-applied tool is worse than finishing it.
      return await Promise.race([
        entry.settled.promise,
        aborted(call.signal).then(() => refuse("the agent cancelled this call")),
      ])
    },
  }
}

/**
 * Tool arguments as canonical JSON, so key order alone cannot make two identical
 * inputs look different or two different ones look alike. Absent arguments and an
 * empty object describe the same call.
 */
function canonical(input: unknown) {
  return JSON.stringify(input ?? {}, (_, value) =>
    isRecord(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
      : value,
  )
}

/** What the agent reads back from a settled facade call. */
function resultText(result: { readonly type: string; readonly value: unknown }) {
  if (result.type === "json" && isRecord(result.value) && typeof result.value.output === "string")
    return result.value.output
  if (typeof result.value === "string") return result.value
  return JSON.stringify(result.value) ?? ""
}

/**
 * A settled opencode tool call as MCP content. Text and images are everything the
 * facade carries: opencode keeps the full settlement — title, metadata, and the
 * original attachment records — in its own transcript either way.
 */
function toResult(result: { readonly type: string; readonly value: unknown }): LLMExternalMCP.Result {
  const text = resultText(result)
  if (result.type === "error") return { isError: true, content: [{ type: "text", text }] }
  const attachments = isRecord(result.value) && Array.isArray(result.value.attachments) ? result.value.attachments : []
  const images = attachments.flatMap((item): LLMExternalMCP.Content[] => {
    if (!isRecord(item) || typeof item.url !== "string" || typeof item.mime !== "string") return []
    if (!item.mime.startsWith("image/")) return []
    const match = /^data:[^;,]+;base64,(.+)$/.exec(item.url)
    if (!match) return []
    return [{ type: "image", data: match[1], mimeType: item.mime }]
  })
  return { content: [...(text || images.length === 0 ? [{ type: "text" as const, text }] : []), ...images] }
}

/**
 * Run one turn as a normal model event stream.
 *
 * The runtime owns process lifetime, event ordering, settlement, and dispatch of
 * the tools opencode executes itself. Everything about the external agent —
 * arguments, output format, tool naming, structured output — lives in its adapter.
 * Cancellation flows from `abort`: the spawner kills the process group when the
 * stream scope closes, and no events are admitted after settlement. A silent
 * execution settles the same way once its idle timeout expires.
 *
 * A turn is usually one execution. It becomes two when the agent asks the user a
 * question: opencode keeps that call running, the agent ends its execution, and the
 * turn continues by resuming the agent with the answers — one opencode assistant
 * turn either way.
 */
export function stream(input: StreamInput): Stream.Stream<LLMEvent, unknown> {
  return Stream.unwrap(
    Effect.gen(function* () {
      if (input.abort.aborted) return yield* Effect.fail(new Error("request was cancelled before it started"))
      const scope = yield* Scope.Scope
      const first = yield* Effect.try({
        try: () =>
          prompt(input.promptMessages ?? input.messages, input.turn.schema !== undefined, input.turn.resumeSessionID),
        catch: (error) => new Error(errorMessage(error)),
      })

      const exposed = catalog(input)
      if (exposed.ambiguous.length)
        yield* Effect.logWarning("facade tool names are ambiguous and were not exposed", {
          tools: exposed.ambiguous.join(","),
        })
      if (exposed.help.size)
        yield* Effect.logWarning("facade tool descriptions exceeded the external agent limit", {
          limit: input.adapter.toolDescriptionLimit?.toString(),
          tools: [...exposed.help].map(([name, description]) => `${name}:${Buffer.byteLength(description)}`).join(","),
        })
      const inputTools = exposed.help.size
        ? {
            ...input.tools,
            [TOOL_HELP]: tool({
              description: TOOL_HELP_DESCRIPTION,
              inputSchema: jsonSchema({
                type: "object",
                properties: { name: { type: "string", enum: [...exposed.help.keys()] } },
                required: ["name"],
                additionalProperties: false,
              }),
              async execute(value) {
                if (!isRecord(value) || typeof value.name !== "string") throw new Error("tool_help requires a name")
                const description = exposed.help.get(value.name)
                if (description === undefined)
                  throw new Error(`No extended description is available for "${value.name}"`)
                return description
              },
            }),
          }
        : input.tools
      const tools = LLMNativeRuntime.nativeTools(inputTools, input)
      const facade = exposed.tools.length ? rendezvous(new Set(exposed.tools.map((tool) => tool.name))) : undefined

      // The calls opencode still owns when an execution ends are the user's
      // questions, and a turn that ends without delivering them owes the user no
      // wait: it closes the dock the facade opened instead of leaving it in front of
      // someone whose answer nothing will read. `asked` outlives `deferred`, which is
      // emptied as answers are collected, so cancellation while waiting still closes
      // the dock.
      const deferred: {
        readonly id: string
        readonly join: Effect.Effect<{ readonly events: ReadonlyArray<LLMEvent>; readonly text: string }>
      }[] = []
      const asked: string[] = []
      const withdraw = Effect.gen(function* () {
        const pending = (yield* input.questions.list()).filter(
          (request) => request.tool !== undefined && asked.includes(request.tool.callID),
        )
        // Nothing in `asked` is outstanding afterwards, so a later withdrawal only
        // has to consider the questions asked after this one.
        asked.length = 0
        yield* Effect.forEach(pending, (request) => input.questions.reject(request.id).pipe(Effect.ignore))
      })
      if (facade)
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            facade.close()
            if (asked.length) yield* withdraw
          }),
        )

      let settled = false
      const admit = (event: LLMEvent) => {
        if (settled) return false
        if (LLMEvent.is.finish(event)) settled = true
        return true
      }
      const dispatch = (event: Extract<LLMEvent, { type: "tool-call" }>) =>
        ToolRuntime.dispatch(tools, event).pipe(
          Effect.map((dispatched) => ({
            events: dispatched.events,
            result: toResult(dispatched.result),
            text: resultText(dispatched.result),
          })),
        )
      // Tools the external agent ran itself are already settled; anything else it
      // asks for is executed by opencode, in order, before the stream continues. The
      // call reaches the transcript before it runs, so a slow tool is visible as
      // running work rather than appearing only once it is over.
      const expand = (events: ReadonlyArray<LLMEvent>): Stream.Stream<LLMEvent, never> =>
        Stream.fromIterable(events).pipe(
          Stream.flatMap((event) => {
            if (!admit(event)) return Stream.empty
            if (!LLMEvent.is.toolCall(event)) return Stream.make(event)
            return Stream.make(event).pipe(Stream.concat(Stream.unwrap(settlement(event))))
          }),
        )
      const settlement = (event: Extract<LLMEvent, { type: "tool-call" }>) =>
        Effect.gen(function* () {
          if (facade?.claim(event.id)) {
            // Answering the agent promptly is the whole point: it ends its
            // execution while opencode keeps the question in front of the user.
            if (event.name === DEFERRED_TOOL) {
              const fiber = yield* dispatch(event).pipe(Effect.forkIn(scope))
              deferred.push({ id: event.id, join: Fiber.join(fiber) })
              asked.push(event.id)
              facade.settle(event.id, { content: [{ type: "text", text: DEFERRED_RESULT }] })
              return Stream.empty
            }
            const dispatched = yield* dispatch(event)
            facade.settle(event.id, dispatched.result)
            return Stream.fromIterable(dispatched.events.filter((result) => admit(result)))
          }
          if (event.providerExecuted && !dispatchRequested(input.adapter.id, event)) return Stream.empty
          const dispatched = yield* ToolRuntime.dispatch(tools, event)
          return Stream.fromIterable(dispatched.events.filter((result) => admit(result)))
        })
      const translate = (produce: () => ReadonlyArray<LLMEvent>) =>
        Stream.unwrap(
          Effect.try({ try: produce, catch: (error) => new Error(errorMessage(error)) }).pipe(Effect.map(expand)),
        )

      // An execution that neither speaks nor exits is stuck, and nothing else
      // will end the turn, so the runtime stops waiting and fails it. A facade
      // call cannot trip it: the watchdog only measures output opencode is waiting
      // for, and while opencode runs a tool it is not waiting for any.
      const idleTimeout = input.idleTimeout ?? input.adapter.idleTimeout

      const execution = (
        parts: ReadonlyArray<PromptPart>,
        resumeSessionID: string | undefined,
        index: number,
      ): Stream.Stream<LLMEvent, unknown> =>
        Stream.unwrap(
          Effect.gen(function* () {
            // One MCP server and stateful transport per execution: a released
            // registration is never reachable again, and a new process gets a new
            // handshake rather than reusing a settled one.
            const handle = facade
              ? yield* Effect.acquireRelease(
                  Effect.promise(() => LLMExternalMCP.register({ tools: exposed.tools, call: facade.call })),
                  (registered) => Effect.promise(() => registered.close()),
                )
              : undefined
            const turn = {
              ...input.turn,
              resumeSessionID,
              step: index,
              facade:
                handle && facade
                  ? {
                      config: handle.config,
                      token: handle.token,
                      env: handle.env,
                      resolve: facade.resolve,
                      called: facade.called,
                      owned: facade.owned,
                    }
                  : undefined,
            }
            const translator = input.adapter.translate(turn)
            const command = yield* Effect.try({
              try: () => input.adapter.command({ ...turn, prompt: parts }),
              catch: (error) => new Error(errorMessage(error)),
            })
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
            return watched.pipe(
              Stream.mapEffect((line) =>
                Effect.try({ try: () => translator.line(line), catch: (error) => new Error(errorMessage(error)) }),
              ),
              // Once the output reports the end of the turn there is nothing left
              // to read: waiting for the process to exit would let a lingering
              // agent stall a finished turn until its idle timeout. The check reads
              // one line's events at a time, because the line that ends the turn
              // produces none.
              Stream.takeUntil(() => translator.complete()),
              Stream.flatMap((events) => expand(events)),
              Stream.concat(Stream.unwrap(conclude(translator, index, handle))),
            )
          }),
        )

      const conclude = (
        translator: Translator,
        index: number,
        handle: LLMExternalMCP.Handle | undefined,
      ): Effect.Effect<Stream.Stream<LLMEvent, unknown>, Error> =>
        Effect.gen(function* () {
          if (handle && !handle.connected())
            yield* Effect.logWarning("external agent never connected to the opencode tool facade")
          // An execution that never reported the end of its turn has no boundary to
          // continue from, so the adapter settles it — or fails the turn saying why.
          if (!translator.complete()) return translate(() => translator.settle())

          const pending = deferred.splice(0)
          const resume = translator.session?.()
          const resumable = resume !== undefined && index + 1 < MAX_EXECUTIONS
          // A turn that cannot resume the agent has nowhere to deliver an answer, so
          // the question is taken back now rather than after the user answers it.
          if (pending.length && !resumable) {
            yield* Effect.logWarning("external agent cannot continue with the user's answers", {
              resumable: (resume !== undefined).toString(),
              executions: (index + 1).toString(),
            })
            yield* withdraw
          }
          // Waiting happens here rather than inside the call: the agent's execution
          // has already ended, so nothing holds an MCP request or a process open
          // while the user reads the question.
          const answered = yield* Effect.forEach(pending, (item) => item.join)
          const text = answered
            .map((item) => item.text)
            .filter((value) => value)
            .join("\n\n")
          const continued = resumable && text !== ""
          return expand(answered.flatMap((item) => item.events)).pipe(
            Stream.concat(
              translate(() => {
                const terminal = translator.settle()
                // Every execution ends its own step, but only the last one ends the turn.
                return continued ? terminal.filter((event) => !LLMEvent.is.finish(event)) : terminal
              }),
            ),
            Stream.concat(
              continued && resume !== undefined
                ? expand([LLMEvent.stepStart({ index: index + 1 })]).pipe(
                    Stream.concat(execution([{ type: "text", text }], resume, index + 1)),
                  )
                : Stream.empty,
            ),
          )
        })

      return Stream.make(LLMEvent.stepStart({ index: 0 })).pipe(
        Stream.concat(execution(first, input.turn.resumeSessionID, 0)),
      )
    }),
  )
}

export * as LLMExternalRuntime from "./external-runtime"
