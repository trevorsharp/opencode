import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionSummary } from "../../src/session/summary"
import { MCP } from "../../src/mcp"
import { LSP } from "@/lsp/lsp"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import path from "path"

// Skip tests if no API key is available
const hasApiKey = !!process.env.ANTHROPIC_API_KEY
const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })
const retry = testEffect(
  LayerNode.compile(
    LayerNode.group([
      SessionPrompt.node,
      Session.node,
      SessionProjector.node,
      SessionSummary.node,
      Database.node,
      CrossSpawnSpawner.node,
      MCP.node,
      LSP.node,
      RuntimeFlags.node,
      testLLMServerNode,
    ]),
  ),
)
const it = testEffect(AppNodeBuilder.build(LayerNode.group([SessionPrompt.node, Session.node, Ripgrep.node])))
const live = hasApiKey ? it.instance : it.instance.skip

const providerConfig = (url: string) => ({
  model: "test/test-model",
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "test-key", baseURL: url },
    },
  },
})

describe("StructuredOutput Integration", () => {
  retry.instance(
    "retries missing structured output and reports exhausted retries",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const hasStructuredOutput = (body: Record<string, unknown>) =>
          JSON.stringify(body).includes('"StructuredOutput"')
        const isStructuredRequest = (hit: { body: Record<string, unknown> }) => hasStructuredOutput(hit.body)
        yield* llm.textMatch(isStructuredRequest, "plain response 1")
        yield* llm.textMatch(isStructuredRequest, "plain response 2")
        yield* llm.textMatch(isStructuredRequest, "plain response 3")

        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "Structured Output Retry Test" })
        const result = yield* prompt.prompt({
          sessionID: session.id,
          parts: [{ type: "text", text: "Return a structured answer." }],
          format: new SessionV1.OutputFormatJsonSchema({
            type: "json_schema",
            schema: {
              type: "object",
              properties: { answer: { type: "string" } },
              required: ["answer"],
            },
            retryCount: 2,
          }),
        })

        expect(result.info.role).toBe("assistant")
        if (result.info.role === "assistant") {
          expect(result.info.error).toMatchObject({
            name: "StructuredOutputError",
            data: { retries: 2 },
          })
        }

        const attempts = (yield* llm.inputs).filter(hasStructuredOutput)
        expect(attempts).toHaveLength(3)
        expect(JSON.stringify(attempts[1])).toContain("The previous response did not use the StructuredOutput tool")
        expect(JSON.stringify(attempts[2])).toContain("The previous response did not use the StructuredOutput tool")
      }),
    {
      init: (directory) =>
        Effect.gen(function* () {
          const llm = yield* TestLLMServer
          yield* Effect.promise(() =>
            Bun.write(
              path.join(directory, "opencode.json"),
              JSON.stringify({ $schema: "https://opencode.ai/config.json", ...providerConfig(llm.url) }),
            ),
          )
        }),
    },
  )

  live(
    "produces structured output with simple schema",
    () =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "Structured Output Test" })

        const result = yield* prompt.prompt({
          sessionID: session.id,
          parts: [
            {
              type: "text",
              text: "What is 2 + 2? Provide a simple answer.",
            },
          ],
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: {
                answer: { type: "number", description: "The numerical answer" },
                explanation: { type: "string", description: "Brief explanation" },
              },
              required: ["answer"],
            },
            retryCount: 0,
          },
        })

        // Verify structured output was captured (only on assistant messages)
        expect(result.info.role).toBe("assistant")
        if (result.info.role === "assistant") {
          expect(result.info.structured).toBeDefined()
          expect(typeof result.info.structured).toBe("object")

          const output = result.info.structured as any
          expect(output.answer).toBe(4)

          // Verify no error was set
          expect(result.info.error).toBeUndefined()
        }

        // Clean up
        // Note: Not removing session to avoid race with background SessionSummary.summarize
      }),
    { git: true },
    60000,
  )

  live(
    "produces structured output with nested objects",
    () =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "Nested Schema Test" })

        const result = yield* prompt.prompt({
          sessionID: session.id,
          parts: [
            {
              type: "text",
              text: "Tell me about Anthropic company in a structured format.",
            },
          ],
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: {
                company: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    founded: { type: "number" },
                  },
                  required: ["name", "founded"],
                },
                products: {
                  type: "array",
                  items: { type: "string" },
                },
              },
              required: ["company"],
            },
            retryCount: 0,
          },
        })

        // Verify structured output was captured (only on assistant messages)
        expect(result.info.role).toBe("assistant")
        if (result.info.role === "assistant") {
          expect(result.info.structured).toBeDefined()
          const output = result.info.structured as any

          expect(output.company).toBeDefined()
          expect(output.company.name).toBe("Anthropic")
          expect(typeof output.company.founded).toBe("number")

          if (output.products) {
            expect(Array.isArray(output.products)).toBe(true)
          }

          // Verify no error was set
          expect(result.info.error).toBeUndefined()
        }

        // Clean up
        // Note: Not removing session to avoid race with background SessionSummary.summarize
      }),
    { git: true },
    60000,
  )

  live(
    "works with text outputFormat (default)",
    () =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "Text Output Test" })

        const result = yield* prompt.prompt({
          sessionID: session.id,
          parts: [
            {
              type: "text",
              text: "Say hello.",
            },
          ],
          format: {
            type: "text",
          },
        })

        // Verify no structured output (text mode) and no error
        expect(result.info.role).toBe("assistant")
        if (result.info.role === "assistant") {
          expect(result.info.structured).toBeUndefined()
          expect(result.info.error).toBeUndefined()
        }

        // Verify we got a response with parts
        expect(result.parts.length).toBeGreaterThan(0)

        // Clean up
        // Note: Not removing session to avoid race with background SessionSummary.summarize
      }),
    { git: true },
    60000,
  )

  live(
    "stores outputFormat on user message",
    () =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "OutputFormat Storage Test" })

        yield* prompt.prompt({
          sessionID: session.id,
          parts: [
            {
              type: "text",
              text: "What is 1 + 1?",
            },
          ],
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: {
                result: { type: "number" },
              },
              required: ["result"],
            },
            retryCount: 3,
          },
        })

        // Get all messages from session
        const messages = yield* sessions.messages({ sessionID: session.id })
        const userMessage = messages.find((m) => m.info.role === "user")

        // Verify outputFormat was stored on user message
        expect(userMessage).toBeDefined()
        if (userMessage?.info.role === "user") {
          expect(userMessage.info.format).toBeDefined()
          expect(userMessage.info.format?.type).toBe("json_schema")
          if (userMessage.info.format?.type === "json_schema") {
            expect(userMessage.info.format.retryCount).toBe(3)
          }
        }

        // Clean up
        // Note: Not removing session to avoid race with background SessionSummary.summarize
      }),
    { git: true },
    60000,
  )

  test("unit test: StructuredOutputError is properly structured", () => {
    const error = new SessionV1.StructuredOutputError({
      message: "Failed to produce valid structured output after 3 attempts",
      retries: 3,
    })

    expect(error.name).toBe("StructuredOutputError")
    expect(error.data.message).toContain("3 attempts")
    expect(error.data.retries).toBe(3)

    const obj = error.toObject()
    expect(obj.name).toBe("StructuredOutputError")
    expect(obj.data.retries).toBe(3)
  })
})
