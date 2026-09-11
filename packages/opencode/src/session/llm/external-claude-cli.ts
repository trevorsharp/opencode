import { ClaudeCLI } from "@/provider/claude-cli"
import { errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"
import { Stream } from "effect"
import { LLMEvent, Usage, type FinishReason } from "@opencode-ai/llm"
import { ChildProcess } from "effect/unstable/process"
import type { Adapter, Translator, Turn } from "./external-runtime"

/**
 * Tools the CLI may use. Claude owns this loop, so these calls are reported as
 * provider-executed activity and opencode never runs them a second time.
 *
 * `Skill` and `ToolSearch` are Claude's own discovery tools: skills are
 * Claude-native and reach their work through the tools above, and Claude finds the
 * opencode facade's deferred MCP tools by searching for them. Neither the facade's
 * tools nor opencode's own skill tool belong in this list — MCP availability is
 * decided by what the facade exposes, not by `--tools`.
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
  "Skill",
  "ToolSearch",
]

/** Name shared by the CLI's structured-output tool and opencode's own. */
const STRUCTURED_OUTPUT = "StructuredOutput"

const TOOL_DESCRIPTION_LIMIT = 2 * 1024

const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])

/**
 * The CLI's bookkeeping tools. Claude exposes either the legacy todo list or the
 * task list, never both, and both describe the same thing opencode already models
 * as session todos, so their successful calls become opencode todo updates instead
 * of timeline tool calls.
 */
const BOOKKEEPING = new Set(["TodoWrite", "TaskCreate", "TaskUpdate", "TaskGet", "TaskList"])

/** opencode's todo tool, which owns the session todo list. */
const TODO_WRITE = "todowrite"

/** Statuses opencode shares with the CLI; anything else is treated as not started. */
const TODO_STATUSES = new Set(["pending", "in_progress", "completed"])

/** Claude deletes a task through a status the todo list has no equivalent for. */
const TASK_DELETED = "deleted"

/** Claude reports no priority, and opencode requires one. */
const TODO_PRIORITY = "medium"

type Todo = { content: string; status: string; priority: string }

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

/**
 * Claude's view of its own task list, rebuilt from bookkeeping results on top of the
 * todos opencode already holds for the session.
 *
 * The seeded rows matter because opencode's todo tool replaces the whole list: a
 * resumed Claude conversation still owns tasks from earlier turns, and a result about
 * one of them must not drop the rest. Seeded rows carry no task id until Claude names
 * them, and are then adopted by matching content so an already rendered task is
 * updated in place instead of appearing twice.
 *
 * Whole-list results (TodoWrite, TaskList) are authoritative and replace the list.
 * Single-task results (TaskCreate, TaskUpdate, TaskGet) are applied in place, keyed
 * by task id so Claude's creation order survives later edits. Fields opencode's todo
 * list cannot express — descriptions, active forms, owners, dependencies — are
 * ignored, and an edit that names an unknown task without describing it is dropped
 * rather than inventing an entry.
 */
function bookkeeping(seed: ReadonlyArray<Todo>) {
  let entries: { id?: string; todo: Todo }[] = seed.map((item) => ({ todo: { ...item } }))

  const todo = (content: string, status: unknown): Todo => ({
    content,
    status: typeof status === "string" && TODO_STATUSES.has(status) ? status : "pending",
    priority: TODO_PRIORITY,
  })

  const replace = (items: unknown, field: string) => {
    if (!Array.isArray(items)) return
    const next: { id?: string; todo: Todo }[] = []
    for (const item of items) {
      if (!isRecord(item)) continue
      const content = item[field]
      if (typeof content !== "string" || !content) continue
      next.push({
        id: typeof item.id === "string" && item.id ? item.id : undefined,
        todo: todo(content, item.status),
      })
    }
    entries = next
  }

  const upsert = (id: unknown, content: unknown, status: unknown) => {
    if (typeof id !== "string" || !id) return
    const text = typeof content === "string" && content ? content : undefined
    const current =
      entries.find((entry) => entry.id === id) ??
      (text ? entries.find((entry) => !entry.id && entry.todo.content === text) : undefined)
    if (!current) {
      if (text) entries.push({ id, todo: todo(text, status) })
      return
    }
    current.id = id
    current.todo = todo(text ?? current.todo.content, status ?? current.todo.status)
  }

  const apply = (tool: string, input: Record<string, any>, payload: Record<string, any>) => {
    switch (tool) {
      case "TodoWrite":
        return replace(payload.newTodos ?? input.todos, "content")
      case "TaskList":
        return replace(payload.tasks, "subject")
      case "TaskCreate": {
        const task = isRecord(payload.task) ? payload.task : {}
        return upsert(task.id, task.subject ?? input.subject, task.status)
      }
      case "TaskGet": {
        if (!isRecord(payload.task)) return
        return upsert(payload.task.id, payload.task.subject, payload.task.status)
      }
      case "TaskUpdate": {
        const id = typeof payload.taskId === "string" ? payload.taskId : input.taskId
        const change = isRecord(payload.statusChange) ? payload.statusChange : {}
        const status = change.to ?? input.status
        if (status === TASK_DELETED) {
          if (typeof id === "string" && id) entries = entries.filter((entry) => entry.id !== id)
          return
        }
        return upsert(id, input.subject, status)
      }
    }
  }

  return {
    /**
     * A result whose payload reports a semantic failure. Claude reports these as
     * ordinary results, so the payload is the only evidence that nothing changed.
     */
    failed(tool: string, payload: Record<string, any>) {
      if (tool === "TaskUpdate") return payload.success === false
      if (tool === "TaskGet") return payload.task === null
      return false
    },
    /** The updated list, or undefined when the result changed nothing. */
    update(tool: string, input: Record<string, any>, payload: Record<string, any>) {
      const before = JSON.stringify(entries.map((entry) => entry.todo))
      apply(tool, input, payload)
      const todos = entries.map((entry) => entry.todo)
      return JSON.stringify(todos) === before ? undefined : todos
    },
  }
}

function command(turn: Turn): ChildProcess.Command {
  const effort = turn.variant
  if (effort !== undefined && !ClaudeCLI.EFFORTS.includes(effort as (typeof ClaudeCLI.EFFORTS)[number])) {
    throw new Error(`Claude CLI effort "${effort}" is not supported`)
  }
  const files = turn.prompt.filter((part) => part.type === "file")
  const content = turn.prompt.map((part) => {
    if (part.type === "text") return part
    if (!IMAGE_MIMES.has(part.mediaType)) throw new Error(`Claude CLI does not support ${part.mediaType} attachments`)
    if (typeof part.data !== "string") throw new Error("Claude CLI image attachments must use base64 data URLs")
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(part.data)
    if (!match) throw new Error("Claude CLI image attachments must use valid base64 data URLs")
    if (match[1] !== part.mediaType)
      throw new Error("Claude CLI image attachment MIME type does not match its data URL")
    if (Buffer.from(match[2], "base64").toString("base64").replace(/=+$/, "") !== match[2].replace(/=+$/, ""))
      throw new Error("Claude CLI image attachment contains invalid base64 data")
    return {
      type: "image" as const,
      source: { type: "base64" as const, media_type: part.mediaType, data: match[2] },
    }
  })
  const args = [
    "-p",
    "--model",
    turn.model.api.id,
    ...(effort ? ["--effort", effort] : []),
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    ...(files.length ? ["--input-format", "stream-json"] : []),
    ...(turn.resumeSessionID ? ["--resume", turn.resumeSessionID, "--fork-session"] : []),
    "--dangerously-skip-permissions",
    "--tools",
    TOOLS.join(","),
    // Strict configuration keeps Claude pointed at opencode's own facade and
    // nothing else. The facade's token stays out of argv: the configuration only
    // names the environment variable the child expands it from.
    "--strict-mcp-config",
    "--mcp-config",
    turn.facade ? turn.facade.config : '{"mcpServers":{}}',
    "--no-chrome",
    ...(turn.system ? ["--append-system-prompt", turn.system] : []),
    ...(turn.schema ? ["--json-schema", JSON.stringify(turn.schema)] : []),
  ]
  return ChildProcess.make(ClaudeCLI.EXECUTABLE, args, {
    cwd: turn.directory,
    extendEnv: true,
    env: {
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1",
      CLAUDE_CODE_THRIFTY_SONIC: "0",
      ...(turn.facade ? { [turn.facade.env]: turn.facade.token } : {}),
    },
    stdin: Stream.make(
      new TextEncoder().encode(
        files.length
          ? JSON.stringify({
              type: "user",
              message: { role: "user", content },
              parent_tool_use_id: null,
            }) + "\n"
          : content.map((part) => (part.type === "text" ? part.text : "")).join(""),
      ),
    ),
    forceKillAfter: "3 seconds",
  })
}

function translate(turn: Omit<Turn, "prompt">): Translator {
  const tools = new Map<string, string>()
  const structured = new Set<string>()
  const deferred = new Map<string, { tool: string; input: Record<string, any> }>()
  /** Facade calls by Claude's own call id, which opencode adopts as its call id. */
  const facades = new Map<string, string>()
  // Without a todo list to project onto — the agent's permissions forbid writing
  // one — bookkeeping stays ordinary provider-executed tool activity.
  const projected = turn.todos !== undefined
  const todos = bookkeeping(turn.todos ?? [])
  let result: Record<string, any> | undefined
  let sessionID: string | undefined
  let blocks = 0
  let streamMessageID: string | undefined
  const streamBlocks = new Map<
    string,
    { id: string; messageID: string; type: "text" | "thinking"; open: boolean; completed: boolean }
  >()

  const metadata = (value: Record<string, any> = {}) => ({
    [ClaudeCLI.EXECUTION]: {
      ...value,
      ...(sessionID ? { claudeSessionID: sessionID } : {}),
    },
  })

  const toolInput = (input: unknown): Record<string, any> => {
    if (!isRecord(input)) return { value: input }
    return Object.fromEntries(Object.entries(input).map(([key, value]) => [INPUT_ALIASES[key] ?? key, value]))
  }

  const toolCall = (id: string, name: string, input: unknown) =>
    LLMEvent.toolCall({
      id,
      name: name.toLowerCase(),
      input: toolInput(input),
      providerExecuted: true,
      providerMetadata: metadata({ tool: name, input }),
    })

  const closeStreamBlocks = (messageID: string, index?: number) => {
    const events: LLMEvent[] = []
    for (const [key, block] of streamBlocks) {
      if (block.messageID !== messageID || !block.open) continue
      if (index !== undefined && key !== `${messageID}:${index}`) continue
      block.open = false
      events.push(block.type === "text" ? LLMEvent.textEnd({ id: block.id }) : LLMEvent.reasoningEnd({ id: block.id }))
    }
    return events
  }

  const stream = (event: Record<string, any>) => {
    const value = event.event
    if (!isRecord(value)) return []
    if (value.type === "message_start") {
      if (!isRecord(value.message) || typeof value.message.id !== "string") return []
      const events = streamMessageID ? closeStreamBlocks(streamMessageID) : []
      streamMessageID = value.message.id
      return events
    }
    if (!streamMessageID) return []
    if (value.type === "message_stop") {
      const events = closeStreamBlocks(streamMessageID)
      streamMessageID = undefined
      return events
    }
    if (typeof value.index !== "number") return []
    const key = `${streamMessageID}:${value.index}`
    if (value.type === "content_block_stop") return closeStreamBlocks(streamMessageID, value.index)
    if (value.type === "content_block_start" && isRecord(value.content_block)) {
      const type = value.content_block.type
      if (type !== "text" && type !== "thinking") return []
      const block = { id: key, messageID: streamMessageID, type, open: true, completed: false }
      streamBlocks.set(key, block)
      const text = type === "text" ? value.content_block.text : value.content_block.thinking
      return [
        type === "text"
          ? LLMEvent.textStart({ id: block.id, providerMetadata: metadata() })
          : LLMEvent.reasoningStart({ id: block.id, providerMetadata: metadata() }),
        ...(typeof text !== "string" || !text
          ? []
          : [
              type === "text"
                ? LLMEvent.textDelta({ id: block.id, text })
                : LLMEvent.reasoningDelta({ id: block.id, text }),
            ]),
      ]
    }
    if (value.type !== "content_block_delta" || !isRecord(value.delta)) return []
    const block = streamBlocks.get(key)
    if (!block?.open) return []
    if (block.type === "text" && value.delta.type === "text_delta" && typeof value.delta.text === "string") {
      return value.delta.text ? [LLMEvent.textDelta({ id: block.id, text: value.delta.text })] : []
    }
    if (
      block.type === "thinking" &&
      value.delta.type === "thinking_delta" &&
      typeof value.delta.thinking === "string"
    ) {
      return value.delta.thinking ? [LLMEvent.reasoningDelta({ id: block.id, text: value.delta.thinking })] : []
    }
    return []
  }

  const assistant = (message: Record<string, any>) => {
    const events: LLMEvent[] = []
    for (const block of message.content as any[]) {
      const streamed = Array.from(streamBlocks.values()).find(
        (candidate) =>
          candidate.messageID === message.id && candidate.type === block?.type && candidate.completed === false,
      )
      if (streamed) streamed.completed = true
      const id = `${typeof message.id === "string" ? message.id : "message"}:${blocks++}`
      if (block?.type === "text" && typeof block.text === "string" && block.text) {
        if (streamed) continue
        events.push(
          LLMEvent.textStart({ id, providerMetadata: metadata() }),
          LLMEvent.textDelta({ id, text: block.text }),
          LLMEvent.textEnd({ id }),
        )
        continue
      }
      // Thinking blocks usually carry only a signature, with no readable text.
      if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
        if (streamed) continue
        events.push(
          LLMEvent.reasoningStart({ id, providerMetadata: metadata() }),
          LLMEvent.reasoningDelta({ id, text: block.thinking }),
          LLMEvent.reasoningEnd({ id }),
        )
        continue
      }
      if (block?.type !== "tool_use" || typeof block.id !== "string" || typeof block.name !== "string") continue
      // A facade call is an opencode tool call Claude made: it keeps opencode's own
      // name and arguments exactly, and opencode runs and settles it once.
      const opencodeTool = turn.facade?.resolve(block.name)
      if (turn.facade && opencodeTool) {
        const input = isRecord(block.input) ? block.input : {}
        // A call id opencode can no longer tie to exactly one call is dropped rather
        // than reported: the runtime refuses it, and Claude reads that refusal.
        if (!turn.facade.called(block.id, opencodeTool, input)) continue
        facades.set(block.id, opencodeTool)
        events.push(
          LLMEvent.toolCall({
            id: block.id,
            name: opencodeTool,
            input,
            // Claude already has the result and continues its own loop, so the
            // turn must not schedule another provider round for this call.
            providerExecuted: true,
            providerMetadata: metadata({ tool: block.name }),
          }),
        )
        continue
      }
      // The CLI's own structured-output call is replaced by opencode's tool once
      // the result event reports the extracted value.
      if (block.name === STRUCTURED_OUTPUT) {
        structured.add(block.id)
        continue
      }
      // A bookkeeping call is held back until its result says whether it worked:
      // a successful one becomes a todo update, and only a failed one is reported.
      if (projected && BOOKKEEPING.has(block.name)) {
        deferred.set(block.id, { tool: block.name, input: isRecord(block.input) ? block.input : {} })
        continue
      }
      tools.set(block.id, block.name.toLowerCase())
      events.push(toolCall(block.id, block.name, block.input))
    }
    return events
  }

  /**
   * Settle one bookkeeping call. The list opencode already renders replaces the
   * call itself, so a successful call reaches the timeline only as a todo update
   * that opencode's own todo tool applies. A failed one — including a not-found
   * task, which Claude reports as an ordinary result — is reported as the tool call
   * Claude actually made.
   */
  const bookkeep = (
    block: Record<string, any>,
    event: Record<string, any>,
    call: { tool: string; input: Record<string, any> },
  ) => {
    // These tools describe their outcome beside the block; the block itself only
    // carries the sentence Claude reads.
    const payload = isRecord(event.tool_use_result) ? event.tool_use_result : {}
    if (block.is_error === true || todos.failed(call.tool, payload)) {
      const output = event.tool_use_result ?? block.content
      return [
        toolCall(block.tool_use_id, call.tool, call.input),
        LLMEvent.toolError({
          id: block.tool_use_id,
          name: call.tool.toLowerCase(),
          message: typeof output === "string" ? output : JSON.stringify(output ?? null),
        }),
      ]
    }
    const updated = todos.update(call.tool, call.input, payload)
    if (!updated) return []
    return [
      LLMEvent.toolCall({
        id: `${block.tool_use_id}:todo`,
        name: TODO_WRITE,
        input: { todos: updated },
        // Claude already applied this to its own list, so opencode owes it no
        // result and the turn must not continue on its account. The runtime still
        // runs the todo tool, which is the only way the session list changes.
        providerExecuted: true,
        providerMetadata: metadata({ dispatch: true }),
      }),
    ]
  }

  const user = (event: Record<string, any>) => {
    const events: LLMEvent[] = []
    for (const block of event.message.content as any[]) {
      if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue
      if (structured.delete(block.tool_use_id)) continue
      const opencodeTool = facades.get(block.tool_use_id)
      if (turn.facade && opencodeTool !== undefined) {
        facades.delete(block.tool_use_id)
        // opencode settled this call itself, or still owns it while the user
        // answers; either way a second settlement would duplicate the pair.
        if (turn.facade.owned(block.tool_use_id)) continue
        // The call never reached opencode's dispatch, so the facade's refusal that
        // Claude read is the only settlement this call will ever get.
        const content = block.content ?? event.tool_use_result
        events.push(
          LLMEvent.toolError({
            id: block.tool_use_id,
            name: opencodeTool,
            message: typeof content === "string" ? content : JSON.stringify(content ?? null),
          }),
        )
        continue
      }
      const bookkeeper = deferred.get(block.tool_use_id)
      if (bookkeeper) {
        deferred.delete(block.tool_use_id)
        events.push(...bookkeep(block, event, bookkeeper))
        continue
      }
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
        const events = streamMessageID ? closeStreamBlocks(streamMessageID) : []
        streamMessageID = undefined
        result = event
        if (!sessionID && typeof event.session_id === "string") sessionID = event.session_id
        return events
      }
      if (event?.type === "system" && event.subtype === "init" && typeof event.session_id === "string") {
        sessionID = event.session_id
        return []
      }
      if (event?.type === "stream_event") return stream(event)
      if (!isRecord(event?.message) || !Array.isArray(event.message.content)) return []
      if (event.type === "assistant") return assistant(event.message)
      if (event.type === "user") return user(event)
      return []
    },
    complete() {
      return result !== undefined
    },
    session() {
      return sessionID
    },
    settle() {
      if (!result) throw new Error("Claude CLI returned no result event")
      if (result.is_error) throw new Error(String(result.result || "Claude CLI reported an error"))
      const reason = FINISH_REASONS[result.stop_reason] ?? "stop"
      const usage = new Usage({})
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
        LLMEvent.stepFinish({
          index: turn.step,
          reason,
          usage,
          providerMetadata: sessionID ? { [ClaudeCLI.EXECUTION]: { claudeSessionID: sessionID } } : undefined,
        }),
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

export const adapter: Adapter = {
  id: ClaudeCLI.EXECUTION,
  command,
  translate,
  toolDescriptionLimit: TOOL_DESCRIPTION_LIMIT,
  idleTimeout: ClaudeCLI.IDLE_TIMEOUT,
}

export * as LLMExternalClaudeCLI from "./external-claude-cli"
