import { ClaudeCLI } from "@/provider/claude-cli"
import { errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"
import { Stream } from "effect"
import { LLMEvent, Usage, type FinishReason } from "@opencode-ai/llm"
import { ChildProcess } from "effect/unstable/process"
import type { Adapter, Translator, Turn } from "./external-runtime"

/**
 * Tools the CLI may use. Claude owns this loop, so these calls are reported as
 * provider-executed activity and are never dispatched by opencode.
 */
const TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Edit",
  "Write",
  "Bash",
  "WebFetch",
  "WebSearch",
  "StructuredOutput",
  "TodoWrite",
  "TaskCreate",
  "TaskGet",
  "TaskUpdate",
  "TaskList",
]

/** Name shared by the CLI's structured-output tool and opencode's own. */
const STRUCTURED_OUTPUT = "StructuredOutput"

/** The CLI reports tool inputs in snake_case; opencode tool renderers read camelCase. */
const INPUT_ALIASES: Record<string, string> = {
  file_path: "filePath",
  notebook_path: "filePath",
  old_string: "oldString",
  new_string: "newString",
  replace_all: "replaceAll",
}

// `tool_use` is absent here on purpose: a CLI result event ends Claude's own tool
// loop, so opencode must settle the turn instead of continuing it.
const FINISH_REASONS: Record<string, FinishReason> = {
  end_turn: "stop",
  max_tokens: "length",
  refusal: "content-filter",
}

function command(turn: Turn): ChildProcess.Command {
  const effort = turn.variant
  if (effort !== undefined && !ClaudeCLI.EFFORTS.includes(effort as (typeof ClaudeCLI.EFFORTS)[number])) {
    throw new Error(`Claude CLI effort "${effort}" is not supported`)
  }
  const args = [
    "-p",
    "--model",
    turn.model.api.id,
    ...(effort ? ["--effort", effort] : []),
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--dangerously-skip-permissions",
    "--tools",
    TOOLS.join(","),
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--disable-slash-commands",
    "--no-chrome",
    ...(turn.system ? ["--append-system-prompt", turn.system] : []),
    ...(turn.schema ? ["--json-schema", JSON.stringify(turn.schema)] : []),
  ]
  return ChildProcess.make(ClaudeCLI.EXECUTABLE, args, {
    cwd: turn.directory,
    extendEnv: true,
    stdin: Stream.make(new TextEncoder().encode(turn.prompt)),
    forceKillAfter: "3 seconds",
  })
}

function translate(): Translator {
  const tools = new Map<string, string>()
  const structured = new Set<string>()
  let result: Record<string, any> | undefined
  let blocks = 0

  const toolInput = (input: unknown): Record<string, any> => {
    if (!isRecord(input)) return { value: input }
    return Object.fromEntries(Object.entries(input).map(([key, value]) => [INPUT_ALIASES[key] ?? key, value]))
  }

  const assistant = (message: Record<string, any>) => {
    const events: LLMEvent[] = []
    for (const block of message.content as any[]) {
      const id = `${typeof message.id === "string" ? message.id : "message"}:${blocks++}`
      if (block?.type === "text" && typeof block.text === "string" && block.text) {
        events.push(LLMEvent.textStart({ id }), LLMEvent.textDelta({ id, text: block.text }), LLMEvent.textEnd({ id }))
        continue
      }
      // Thinking blocks usually carry only a signature, with no readable text.
      if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
        events.push(
          LLMEvent.reasoningStart({ id }),
          LLMEvent.reasoningDelta({ id, text: block.thinking }),
          LLMEvent.reasoningEnd({ id }),
        )
        continue
      }
      if (block?.type !== "tool_use" || typeof block.id !== "string" || typeof block.name !== "string") continue
      // The CLI's own structured-output call is replaced by opencode's tool once
      // the result event reports the extracted value.
      if (block.name === STRUCTURED_OUTPUT) {
        structured.add(block.id)
        continue
      }
      tools.set(block.id, block.name.toLowerCase())
      events.push(
        LLMEvent.toolCall({
          id: block.id,
          name: block.name.toLowerCase(),
          input: toolInput(block.input),
          providerExecuted: true,
          providerMetadata: { [ClaudeCLI.EXECUTION]: { tool: block.name, input: block.input } },
        }),
      )
    }
    return events
  }

  const user = (event: Record<string, any>) => {
    const events: LLMEvent[] = []
    for (const block of event.message.content as any[]) {
      if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue
      if (structured.delete(block.tool_use_id)) continue
      const name = tools.get(block.tool_use_id)
      if (!name) continue
      tools.delete(block.tool_use_id)
      // Some tools report their payload beside the block rather than inside it.
      const content = block.content ?? event.tool_use_result
      const output = typeof content === "string" ? content : JSON.stringify(content ?? null)
      if (block.is_error === true) {
        events.push(LLMEvent.toolError({ id: block.tool_use_id, name, message: output }))
        continue
      }
      events.push(
        LLMEvent.toolResult({
          id: block.tool_use_id,
          name,
          result: { type: "text", value: output },
          providerExecuted: true,
        }),
      )
    }
    return events
  }

  return {
    line(line) {
      // The result event ends the turn; anything the CLI prints afterwards is
      // stray output and must not reach the transcript.
      if (result) return []
      const event = parse(line)
      if (event?.type === "result") {
        result = event
        return []
      }
      if (!isRecord(event?.message) || !Array.isArray(event.message.content)) return []
      if (event.type === "assistant") return assistant(event.message)
      if (event.type === "user") return user(event)
      return []
    },
    complete() {
      return result !== undefined
    },
    settle() {
      if (!result) throw new Error("Claude CLI returned no result event")
      if (result.is_error) throw new Error(String(result.result || "Claude CLI reported an error"))
      const reason = FINISH_REASONS[result.stop_reason] ?? "stop"
      const raw = isRecord(result.usage) ? result.usage : {}
      const nonCached = number(raw.input_tokens)
      const cacheRead = number(raw.cache_read_input_tokens)
      const cacheWrite = number(raw.cache_creation_input_tokens)
      const usage = new Usage({
        inputTokens: nonCached + cacheRead + cacheWrite,
        nonCachedInputTokens: nonCached,
        cacheReadInputTokens: cacheRead,
        cacheWriteInputTokens: cacheWrite,
        outputTokens: number(raw.output_tokens),
      })
      return [
        // opencode's own StructuredOutput tool validates and captures the value,
        // so structured output settles exactly like any other model's.
        ...(result.structured_output === undefined
          ? []
          : [
              LLMEvent.toolCall({
                id: "structured-output",
                name: STRUCTURED_OUTPUT,
                input: result.structured_output,
              }),
            ]),
        LLMEvent.stepFinish({ index: 0, reason, usage }),
        LLMEvent.finish({ reason, usage }),
      ]
    },
  }
}

function parse(line: string) {
  try {
    return JSON.parse(line)
  } catch (error) {
    throw new Error(`invalid Claude CLI stream event: ${errorMessage(error)}; output: ${line.slice(0, 500)}`)
  }
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0
}

export const adapter: Adapter = {
  id: ClaudeCLI.EXECUTION,
  command,
  translate,
  idleTimeout: ClaudeCLI.IDLE_TIMEOUT,
}

export * as LLMExternalClaudeCLI from "./external-claude-cli"
