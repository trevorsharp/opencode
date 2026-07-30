import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { randomBytes } from "node:crypto"

/**
 * The fork-private MCP facade an external agent reaches opencode's own tools
 * through.
 *
 * One process-global loopback listener owns every registration and outlives all of
 * them, and each registered execution owns a fresh MCP server and stateful
 * transport: the agent
 * initializes, lists, and calls over one MCP session, and a released registration
 * can never be reused. Registrations are routed by an unguessable per-execution
 * token that reaches the agent only through its environment, never argv. The
 * token is turn routing rather than isolation — a local agent that can run
 * commands can read its own environment — so it protects against remote access
 * and cross-turn mistakes, nothing more.
 */

/** Server name the agent sees; its tools arrive as `mcp__opencode__<name>`. */
export const SERVER = "opencode"

/** Environment variable the agent's MCP configuration expands the token from. */
export const TOKEN_ENV = "OPENCODE_MCP_FACADE_TOKEN"

const PATH = "/mcp"

/**
 * Bun closes an idle socket, and a facade call may legitimately outlive that
 * window while opencode waits on a tool or a permission prompt. The listener uses
 * Bun's maximum idle window and every in-flight call is kept warm below it.
 */
const IDLE_TIMEOUT_SECONDS = 255
const KEEPALIVE_MS = 30_000

/** The agent's own call id, which opencode adopts as the canonical call id. */
const TOOL_USE_ID = "claudecode/toolUseId"

const INSTRUCTIONS =
  "opencode's own tools. Call them exactly as listed; opencode executes them, records them in its transcript, and returns their result."

export type Content =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string }

export type Result = {
  readonly content: ReadonlyArray<Content>
  readonly isError?: boolean
}

export type Tool = {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
}

export type Call = {
  readonly id: string
  readonly name: string
  readonly input: unknown
  /** Aborted when the agent cancels the call or its connection closes. */
  readonly signal: AbortSignal
}

export type Registration = {
  readonly tools: ReadonlyArray<Tool>
  readonly call: (call: Call) => Promise<Result>
}

export type Handle = {
  /** Strict MCP configuration naming only this facade. */
  readonly config: string
  readonly token: string
  readonly env: string
  /** True once the agent actually completed the MCP handshake. */
  readonly connected: () => boolean
  readonly close: () => Promise<void>
}

type Entry = {
  readonly transport: WebStandardStreamableHTTPServerTransport
  connected: boolean
}

const entries = new Map<string, Entry>()
let listener: ReturnType<typeof Bun.serve> | undefined

export async function register(registration: Registration): Promise<Handle> {
  const server = new Server(
    { name: SERVER, version: "1.0.0" },
    { capabilities: { tools: {}, logging: {} }, instructions: INSTRUCTIONS },
  )
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  })
  const entry: Entry = { transport, connected: false }
  server.oninitialized = () => {
    entry.connected = true
  }
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: registration.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as { type: "object" },
    })),
  }))
  server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
    const id = extra._meta?.[TOOL_USE_ID]
    // Only a structured call opencode can tie back to the agent's own transcript
    // is executed: without that identity the call would be invisible activity.
    if (typeof id !== "string" || !id)
      return Promise.resolve({
        isError: true,
        content: [
          { type: "text" as const, text: "opencode could not correlate this call with a tool call it observed" },
        ],
      })
    const beat = keepalive(extra)
    return registration
      .call({ id, name: request.params.name, input: request.params.arguments, signal: extra.signal })
      .then((result) => ({ isError: result.isError, content: [...result.content] }))
      .finally(() => clearInterval(beat))
  })
  await server.connect(transport)

  const token = randomBytes(32).toString("hex")
  entries.set(token, entry)
  const url = start()

  return {
    token,
    env: TOKEN_ENV,
    config: JSON.stringify({
      mcpServers: {
        [SERVER]: {
          type: "http",
          url,
          headers: { Authorization: `Bearer \${${TOKEN_ENV}}` },
        },
      },
    }),
    connected: () => entry.connected,
    // The listener outlives every registration: a released token has to keep
    // answering `401` rather than refusing the connection, and the next turn is
    // reached at the same address.
    close: async () => {
      entries.delete(token)
      await server.close().catch(() => {})
    },
  }
}

function start() {
  listener ??= Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: IDLE_TIMEOUT_SECONDS,
    fetch(request) {
      if (new URL(request.url).pathname !== PATH) return new Response("not found", { status: 404 })
      const token = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1]
      const entry = token ? entries.get(token) : undefined
      // An unknown or already released token says nothing more: a call from a
      // settled turn looks exactly like a call that was never registered.
      if (!entry) return new Response("unauthorized", { status: 401 })
      return entry.transport.handleRequest(request)
    },
  })
  return `http://127.0.0.1:${listener.port}${PATH}`
}

/**
 * Keeps the connection carrying a long call warm. Progress is the notification the
 * agent asked for when it supplied a token; otherwise a debug log message is the
 * only traffic the protocol allows without one.
 */
function keepalive(extra: {
  _meta?: { progressToken?: string | number }
  sendNotification: (notification: any) => Promise<void>
}) {
  const token = extra._meta?.progressToken
  let progress = 0
  return setInterval(() => {
    progress++
    void extra
      .sendNotification(
        token === undefined
          ? { method: "notifications/message", params: { level: "debug", data: "opencode is still running this tool" } }
          : { method: "notifications/progress", params: { progressToken: token, progress } },
      )
      .catch(() => {})
  }, KEEPALIVE_MS)
}

export * as LLMExternalMCP from "./external-mcp"
