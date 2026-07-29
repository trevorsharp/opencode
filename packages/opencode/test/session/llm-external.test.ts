import { describe, expect } from "bun:test"
import { mkdtempSync, readFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { AppProcess } from "@opencode-ai/core/process"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LLMEvent } from "@opencode-ai/llm"
import { tool, type ModelMessage } from "ai"
import { Effect, Exit, Fiber, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import z from "zod"
import { ClaudeCLI } from "@/provider/claude-cli"
import { LLMExternalClaudeCLI } from "@/session/llm/external-claude-cli"
import { LLMExternalRuntime } from "@/session/llm/external-runtime"

import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(AppProcess.node))

const model = ClaudeCLI.catalog().models["claude-opus-5"]!

const turn = {
  model,
  variant: "high",
  directory: "/tmp",
  system: "workflow instructions",
}

const standard = (command: ChildProcess.Command) => {
  if (command._tag !== "StandardCommand") throw new Error("expected a standard command")
  return command
}

/** A claude adapter whose process replays canned stream-json output. */
const replay = (lines: unknown[], options?: { exit?: number; stderr?: string; sleep?: number }) => ({
  ...LLMExternalClaudeCLI.adapter,
  command: () => {
    const script = [
      ...lines.map((line) => `process.stdout.write(${JSON.stringify(JSON.stringify(line) + "\n")})`),
      ...(options?.stderr ? [`process.stderr.write(${JSON.stringify(options.stderr)})`] : []),
      ...(options?.sleep ? [`setTimeout(() => {}, ${options.sleep})`] : []),
      `process.exitCode = ${options?.exit ?? 0}`,
    ].join(";")
    return ChildProcess.make(process.execPath, ["-e", script])
  },
})

const run = (input: {
  adapter: LLMExternalRuntime.Adapter
  messages?: ModelMessage[]
  tools?: Record<string, any>
  abort?: AbortSignal
  idleTimeout?: number
  schema?: Record<string, any>
}) =>
  Effect.gen(function* () {
    const appProcess = yield* AppProcess.Service
    return Array.from(
      yield* LLMExternalRuntime.stream({
        adapter: input.adapter,
        turn: { ...turn, schema: input.schema },
        messages: input.messages ?? [{ role: "user", content: "hello" }],
        tools: input.tools ?? {},
        process: appProcess,
        abort: input.abort ?? new AbortController().signal,
        idleTimeout: input.idleTimeout,
      }).pipe(Stream.runCollect),
    )
  })

const assistant = (...content: unknown[]) => ({ type: "assistant", message: { id: "msg_1", content } })
const user = (...content: unknown[]) => ({ type: "user", message: { content } })
const result = (extra: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 },
  ...extra,
})

describe("ClaudeCLI catalog", () => {
  it.effect(
    "publishes models with effort variants and no npm package",
    Effect.sync(() => {
      const catalog = ClaudeCLI.catalog()
      expect(Object.keys(catalog.models)).toEqual(["claude-fable-5", "claude-opus-5"])
      expect(catalog.models["claude-fable-5"]!.name).toBe("Fable 5")
      expect(Object.keys(catalog.models["claude-opus-5"]!.variants ?? {})).toEqual([...ClaudeCLI.EFFORTS])
      expect(model.api.npm).toBe(ClaudeCLI.EXECUTION)
      expect(model.api.url).toBe("")
    }),
  )

  it.effect(
    "routes only execution-typed models to the external runtime",
    Effect.sync(() => {
      expect(LLMExternalRuntime.select(model)).toBe(LLMExternalClaudeCLI.adapter)
      expect(LLMExternalRuntime.select({ ...model, api: { ...model.api, npm: "@ai-sdk/anthropic" } })).toBeUndefined()
      expect(LLMExternalClaudeCLI.adapter.idleTimeout).toBe(ClaudeCLI.IDLE_TIMEOUT)
    }),
  )

  it.effect(
    "requires the executable to be on PATH",
    Effect.sync(() => {
      expect(ClaudeCLI.available({ PATH: "/nonexistent", ANTHROPIC_API_KEY: "key" })).toBe(false)
    }),
  )
})

describe("ClaudeCLI command", () => {
  it.effect(
    "preserves the documented execution policy",
    Effect.sync(() => {
      const command = standard(LLMExternalClaudeCLI.adapter.command({ ...turn, prompt: "do the thing" }))
      expect(command.command).toBe(ClaudeCLI.EXECUTABLE)
      expect(command.args).toEqual([
        "-p",
        "--model",
        "claude-opus-5",
        "--effort",
        "high",
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--dangerously-skip-permissions",
        "--tools",
        "Read,Glob,Grep,Edit,Write,Bash,WebFetch,WebSearch,StructuredOutput,TodoWrite,TaskCreate,TaskGet,TaskUpdate,TaskList",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--disable-slash-commands",
        "--no-chrome",
        "--append-system-prompt",
        "workflow instructions",
      ])
      expect(command.options.cwd).toBe("/tmp")
      expect(command.args).not.toContain("--resume")
      expect(command.args.join(" ")).not.toContain("Task(")
    }),
  )

  it.effect(
    "passes a structured output schema and omits absent options",
    Effect.sync(() => {
      const schema = { type: "object", properties: { ok: { type: "boolean" } } }
      const command = standard(
        LLMExternalClaudeCLI.adapter.command({ ...turn, variant: undefined, system: undefined, schema, prompt: "hi" }),
      )
      expect(command.args).not.toContain("--effort")
      expect(command.args).not.toContain("--append-system-prompt")
      expect(command.args.slice(-2)).toEqual(["--json-schema", JSON.stringify(schema)])
    }),
  )

  it.effect(
    "rejects an effort the catalog does not offer",
    Effect.sync(() => {
      expect(() => LLMExternalClaudeCLI.adapter.command({ ...turn, variant: "turbo", prompt: "hi" })).toThrow(
        /effort "turbo" is not supported/,
      )
    }),
  )
})

describe("LLMExternalRuntime", () => {
  it.effect(
    "streams text, reasoning and settlement for a completed turn",
    Effect.gen(function* () {
      const events = yield* run({
        adapter: replay([
          { type: "system", subtype: "init", session_id: "ignored" },
          assistant({ type: "thinking", thinking: "planning" }, { type: "text", text: "done" }),
          result(),
        ]),
      })
      expect(events.map((event) => event.type)).toEqual([
        "step-start",
        "reasoning-start",
        "reasoning-delta",
        "reasoning-end",
        "text-start",
        "text-delta",
        "text-end",
        "step-finish",
        "finish",
      ])
      const finish = events.at(-1)!
      if (finish.type !== "finish") throw new Error("expected a finish event")
      expect(finish.reason).toBe("stop")
      expect(finish.usage).toMatchObject({
        inputTokens: 15,
        nonCachedInputTokens: 10,
        cacheReadInputTokens: 2,
        cacheWriteInputTokens: 3,
        outputTokens: 4,
      })
    }),
  )

  it.effect(
    "reports claude tool activity as provider-executed without dispatching it",
    Effect.gen(function* () {
      let dispatched = 0
      const events = yield* run({
        adapter: replay([
          assistant({ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/tmp/a.txt" } }),
          user({ type: "tool_result", tool_use_id: "toolu_1", content: "file body" }),
          result(),
        ]),
        tools: {
          read: tool({
            description: "read",
            inputSchema: z.object({ filePath: z.string() }),
            execute: async () => {
              dispatched++
              return { output: "", title: "", metadata: {} }
            },
          }),
        },
      })
      expect(dispatched).toBe(0)
      const call = events.find(LLMEvent.is.toolCall)!
      expect(call).toMatchObject({
        id: "toolu_1",
        name: "read",
        input: { filePath: "/tmp/a.txt" },
        providerExecuted: true,
        providerMetadata: { [ClaudeCLI.EXECUTION]: { tool: "Read", input: { file_path: "/tmp/a.txt" } } },
      })
      expect(events.find(LLMEvent.is.toolResult)).toMatchObject({
        id: "toolu_1",
        name: "read",
        result: { type: "text", value: "file body" },
        providerExecuted: true,
      })
    }),
  )

  it.effect(
    "surfaces a failed claude tool call as a tool error",
    Effect.gen(function* () {
      const events = yield* run({
        adapter: replay([
          assistant({ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "false" } }),
          user({ type: "tool_result", tool_use_id: "toolu_1", content: "exit 1", is_error: true }),
          result(),
        ]),
      })
      expect(events.find(LLMEvent.is.toolError)).toMatchObject({ id: "toolu_1", name: "bash", message: "exit 1" })
    }),
  )

  it.effect(
    "replays structured output through opencode's own tool",
    Effect.gen(function* () {
      const captured: unknown[] = []
      const events = yield* run({
        adapter: replay([
          assistant({ type: "tool_use", id: "toolu_1", name: "StructuredOutput", input: { answer: "42" } }),
          user({ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }),
          result({ structured_output: { answer: "42" } }),
        ]),
        tools: {
          StructuredOutput: tool({
            description: "structured output",
            inputSchema: z.object({ answer: z.string() }),
            execute: async (input) => {
              captured.push(input)
              return { output: "", title: "", metadata: {} }
            },
          }),
        },
      })
      // The CLI's own call is suppressed; only the replayed one reaches opencode.
      const calls = events.filter(LLMEvent.is.toolCall)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ name: "StructuredOutput", input: { answer: "42" } })
      expect(calls[0]!.providerExecuted).toBeUndefined()
      expect(captured).toEqual([{ answer: "42" }])
      expect(events.at(-1)!.type).toBe("finish")
    }),
  )

  it.effect(
    "fails the turn when the process exits nonzero",
    Effect.gen(function* () {
      const exit = yield* run({ adapter: replay([], { exit: 3, stderr: "boom" }) }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(exit)).toContain("boom")
    }),
  )

  it.effect(
    "fails the turn when the CLI reports an error result",
    Effect.gen(function* () {
      const exit = yield* run({
        adapter: replay([result({ is_error: true, result: "rate limited" })]),
      }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(exit)).toContain("rate limited")
    }),
  )

  it.effect(
    "fails the turn when the CLI never reports a result",
    Effect.gen(function* () {
      const exit = yield* run({ adapter: replay([assistant({ type: "text", text: "hi" })]) }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(exit)).toContain("no result event")
    }),
  )

  it.effect(
    "fails the turn on malformed output",
    Effect.gen(function* () {
      const adapter = {
        ...LLMExternalClaudeCLI.adapter,
        command: () => ChildProcess.make(process.execPath, ["-e", `process.stdout.write("not json\\n")`]),
      }
      const exit = yield* run({ adapter }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(exit)).toContain("invalid Claude CLI stream event")
    }),
  )

  it.effect(
    "drops output that arrives after settlement",
    Effect.gen(function* () {
      const events = yield* run({
        adapter: replay([result(), assistant({ type: "text", text: "too late" })]),
      })
      expect(events.at(-1)!.type).toBe("finish")
      expect(events.filter(LLMEvent.is.textDelta)).toHaveLength(0)
    }),
  )

  it.effect(
    "does not start a process for an already-cancelled request",
    Effect.gen(function* () {
      let started = false
      const adapter = {
        ...LLMExternalClaudeCLI.adapter,
        command: () => {
          started = true
          return ChildProcess.make(process.execPath, ["-e", "0"])
        },
      }
      const controller = new AbortController()
      controller.abort()
      const exit = yield* run({ adapter, abort: controller.signal }).pipe(Effect.exit)
      expect(started).toBe(false)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(exit)).toContain("cancelled before it started")
    }),
  )

  it.live(
    "cancellation ends the turn and kills the whole process group",
    Effect.gen(function* () {
      // Reports its own pid and a child's, then hangs like an unfinished turn.
      const script = [
        `const child = require("child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" })`,
        `process.stdout.write(JSON.stringify({ type: "assistant", message: { id: "m", content: [{ type: "text", text: process.pid + ":" + child.pid }] } }) + "\\n")`,
        `setTimeout(() => {}, 60000)`,
      ].join(";")
      const adapter = {
        ...LLMExternalClaudeCLI.adapter,
        command: () => ChildProcess.make(process.execPath, ["-e", script]),
      }
      const controller = new AbortController()
      const collected: LLMEvent[] = []
      const appProcess = yield* AppProcess.Service
      const fiber = yield* LLMExternalRuntime.stream({
        adapter,
        turn,
        messages: [{ role: "user", content: "hello" }],
        tools: {},
        process: appProcess,
        abort: controller.signal,
      }).pipe(
        Stream.tap((event) => Effect.sync(() => void collected.push(event))),
        Stream.runDrain,
        Effect.exit,
        Effect.forkScoped,
      )

      const delta = yield* pollWithTimeout(
        Effect.sync(() => collected.find(LLMEvent.is.textDelta)),
        "external process never produced output",
      )
      const pids = delta.text.split(":").map(Number)
      controller.abort()
      yield* awaitWithTimeout(Fiber.await(fiber), "cancellation did not settle the turn", "10 seconds")
      expect(collected.some(LLMEvent.is.finish)).toBe(false)

      const dead = (pid: number) => {
        try {
          process.kill(pid, 0)
          return false
        } catch {
          return true
        }
      }
      yield* pollWithTimeout(
        Effect.sync(() => (pids.every(dead) ? true : undefined)),
        `process group survived cancellation: ${pids.join(", ")}`,
      )
    }),
    20_000,
  )

  it.live(
    "settles a silent turn on the idle timeout and kills the process group",
    Effect.gen(function* () {
      const pids = path.join(mkdtempSync(path.join(tmpdir(), "llm-external-")), "pids")
      // Hangs without ever speaking, like a stuck CLI that no one aborts.
      const script = [
        `const child = require("child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" })`,
        `require("fs").writeFileSync(${JSON.stringify(pids)}, process.pid + ":" + child.pid)`,
        `setTimeout(() => {}, 60000)`,
      ].join(";")
      const adapter = {
        ...LLMExternalClaudeCLI.adapter,
        command: () => ChildProcess.make(process.execPath, ["-e", script]),
      }
      const exit = yield* run({ adapter, idleTimeout: 1_000 }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(exit)).toContain("claude-cli produced no output for 1s")

      const dead = (pid: number) => {
        try {
          process.kill(pid, 0)
          return false
        } catch {
          return true
        }
      }
      const group = readFileSync(pids, "utf8").split(":").map(Number)
      yield* pollWithTimeout(
        Effect.sync(() => (group.every(dead) ? true : undefined)),
        `process group survived the idle timeout: ${group.join(", ")}`,
      )
    }),
    20_000,
  )

  it.live(
    "keeps a slow turn running while the external agent keeps talking",
    Effect.gen(function* () {
      // Four quiet gaps, each shorter than the timeout, add up to longer than it.
      const lines = [
        assistant({ type: "text", text: "still working" }),
        assistant({ type: "text", text: "still working" }),
        assistant({ type: "text", text: "still working" }),
        result(),
      ].map((line) => JSON.stringify(JSON.stringify(line) + "\n"))
      const script = lines
        .map((line, index) => `setTimeout(() => process.stdout.write(${line}), ${(index + 1) * 300})`)
        .join(";")
      const adapter = {
        ...LLMExternalClaudeCLI.adapter,
        command: () => ChildProcess.make(process.execPath, ["-e", script]),
      }
      const events = yield* run({ adapter, idleTimeout: 600 })
      expect(events.filter(LLMEvent.is.textDelta)).toHaveLength(3)
      expect(events.at(-1)!.type).toBe("finish")
    }),
    20_000,
  )

  it.live(
    "settles on the result even when the process keeps running",
    Effect.gen(function* () {
      const pids = path.join(mkdtempSync(path.join(tmpdir(), "llm-external-")), "pids")
      // Reports a complete turn and then lingers, like a CLI that never exits.
      const lines = [assistant({ type: "text", text: "done" }), result()].map((line) =>
        JSON.stringify(JSON.stringify(line) + "\n"),
      )
      const script = [
        `const child = require("child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" })`,
        `require("fs").writeFileSync(${JSON.stringify(pids)}, process.pid + ":" + child.pid)`,
        ...lines.map((line) => `process.stdout.write(${line})`),
        `setTimeout(() => {}, 60000)`,
      ].join(";")
      const adapter = {
        ...LLMExternalClaudeCLI.adapter,
        command: () => ChildProcess.make(process.execPath, ["-e", script]),
      }
      const events = yield* run({ adapter, idleTimeout: 1_000 })
      expect(events.filter(LLMEvent.is.textDelta)).toHaveLength(1)
      expect(events.at(-1)!.type).toBe("finish")

      const dead = (pid: number) => {
        try {
          process.kill(pid, 0)
          return false
        } catch {
          return true
        }
      }
      const group = readFileSync(pids, "utf8").split(":").map(Number)
      yield* pollWithTimeout(
        Effect.sync(() => (group.every(dead) ? true : undefined)),
        `process group survived settlement: ${group.join(", ")}`,
      )
    }),
    20_000,
  )

  it.effect(
    "re-prompts a structured-output retry instead of refusing it",
    Effect.gen(function* () {
      // What the retry path sends: the original ask, the turn that produced no
      // structured output, and the instruction to try again.
      const messages: ModelMessage[] = [
        { role: "user", content: "summarise the repo" },
        { role: "assistant", content: [{ type: "text", text: "prose instead of a tool call" }] },
        { role: "user", content: "Retry now and call StructuredOutput." },
      ]
      let prompt: string | undefined
      const replayed = replay([result({ structured_output: { answer: "42" } })])
      const adapter = {
        ...replayed,
        command: (turn: LLMExternalRuntime.Turn) => {
          prompt = turn.prompt
          return replayed.command()
        },
      }
      const events = yield* run({ adapter, messages, schema: { type: "object" } })
      expect(prompt).toBe("summarise the repo\n\nRetry now and call StructuredOutput.")
      expect(prompt).not.toContain("prose instead of a tool call")
      const calls = events.filter(LLMEvent.is.toolCall)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ name: "StructuredOutput", input: { answer: "42" } })
      expect(events.at(-1)!.type).toBe("finish")
    }),
  )

  it.effect(
    "bounds the stderr it keeps from a failed execution",
    Effect.gen(function* () {
      const adapter = {
        ...LLMExternalClaudeCLI.adapter,
        command: () =>
          ChildProcess.make(process.execPath, [
            "-e",
            `for (let i = 0; i < 512; i++) process.stderr.write("x".repeat(1024)); process.exitCode = 3`,
          ]),
      }
      const exit = yield* run({ adapter }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(exit).length).toBeLessThan(512 * 1024)
    }),
  )

  it.effect(
    "refuses to continue an earlier external turn",
    Effect.gen(function* () {
      const messages: ModelMessage[] = [
        { role: "user", content: "first" },
        { role: "assistant", content: [{ type: "text", text: "answer" }] },
        { role: "user", content: "second" },
      ]
      const exit = yield* run({ adapter: replay([result()]), messages }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(exit)).toContain("continuing an earlier turn is unsupported")
    }),
  )

  it.effect(
    "requires prompt text",
    Effect.gen(function* () {
      const exit = yield* run({ adapter: replay([result()]), messages: [{ role: "user", content: "" }] }).pipe(
        Effect.exit,
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(exit)).toContain("require a text prompt")
    }),
  )
})
