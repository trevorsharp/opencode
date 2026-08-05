import { Effect, Schema } from "effect"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { McpActivation } from "@/mcp/activation"
import { Permission } from "@/permission"
import { Session } from "@/session/session"
import * as Tool from "./tool"

/**
 * The activation permission action. Its pattern is the configured server name,
 * so a ruleset can allow, ask for, or deny each server on its own.
 */
const ACTIVATION_PERMISSION = "mcp_enable"

const LIST_DESCRIPTION = [
  "List the MCP servers that can be activated for this conversation.",
  "Returns configured server names only, with no descriptions, statuses, or tool schemas.",
  "Their tools are not available until you activate them with mcp_enable.",
].join("\n")

const ENABLE_DESCRIPTION = [
  "Activate one or more MCP servers for this conversation so their tools, resources, and instructions become available.",
  "Pass every server you need in one call; the whole batch is authorized together.",
  "Names must come from mcp_list. Activation is idempotent and does not change any configuration file.",
].join("\n")

export const ListParameters = Schema.Struct({})

export const McpListTool = Tool.define(
  "mcp_list",
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const agents = yield* Agent.Service
    const sessions = yield* Session.Service

    return {
      description: LIST_DESCRIPTION,
      parameters: ListParameters,
      execute: (_params: Schema.Schema.Type<typeof ListParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const names = (yield* eligible(mcp, agents, sessions, ctx)).toSorted((left, right) =>
            left.localeCompare(right),
          )
          return {
            title: `${names.length} MCP servers`,
            metadata: { servers: names },
            output: JSON.stringify(names),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const Parameters = Schema.Struct({
  names: Schema.Array(Schema.String).annotate({
    description: "MCP server names to activate, exactly as returned by mcp_list",
  }),
})

export const McpEnableTool = Tool.define(
  "mcp_enable",
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const agents = yield* Agent.Service
    const sessions = yield* Session.Service

    return {
      description: ENABLE_DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          // Validation comes first: an unknown name never reaches authorization,
          // a connection, or the activation set. A configured name the ruleset
          // denies is not unknown — the permission below refuses it as a denial.
          const requested = [...new Set(params.names)]
          if (requested.length === 0) return yield* Effect.die(new Error("mcp_enable requires at least one name"))
          const configured = Object.keys(yield* mcp.status())
          const unknown = requested.filter((name) => !configured.includes(name))
          if (unknown.length)
            return yield* Effect.die(
              new Error(
                `Unknown MCP server${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Call mcp_list for the available names.`,
              ),
            )

          // The complete batch is authorized before any side effect: a denial
          // fails the whole call and leaves nothing activated or connected.
          yield* ctx.ask({
            permission: ACTIVATION_PERMISSION,
            patterns: requested,
            always: requested,
            metadata: { servers: requested },
          })

          // Activation is recorded before connecting, so an already-connected
          // server is available to the session tree immediately.
          const rootID = yield* McpActivation.root(sessions, ctx.sessionID)
          McpActivation.activate(rootID, requested)

          yield* Effect.forEach(
            requested,
            // Each server settles independently: one failure never blocks the
            // rest of the authorized batch, and an already-connected server is
            // left exactly as it is.
            (name) => mcp.connect(name, { ifNeeded: true }).pipe(Effect.ignore),
            { concurrency: "unbounded" },
          )

          const after = yield* mcp.status()
          // Reported names are the ones the session would actually materialize:
          // the tree's whole active set decides public-name collisions, and the
          // agent's and session's rulesets decide visibility.
          const agent = yield* agents.get(ctx.agent)
          const session = yield* sessions.get(ctx.sessionID)
          const ruleset = Permission.merge(agent.permission, session.permission ?? [])
          const visible = Permission.visibleTools(yield* mcp.tools(McpActivation.active(rootID)), ruleset)
          const servers = yield* Effect.forEach(requested, (name) =>
            Effect.gen(function* () {
              const status = after[name] ?? { status: "failed" as const, error: "server is no longer configured" }
              const tools = Object.keys(yield* mcp.tools(new Set([name])))
                .filter((tool) => tool in visible)
                .toSorted((left, right) => left.localeCompare(right))
              return {
                name,
                ...status,
                ...(tools.length ? { tools } : {}),
                ...(status.status === "needs_auth" || status.status === "needs_client_registration"
                  ? { hint: `Authentication is user-driven. Ask the user to run: opencode mcp auth ${name}` }
                  : {}),
              }
            }),
          )

          const connected = servers.filter((server) => server.status === "connected")
          return {
            title: `Activated ${connected.length}/${servers.length} MCP servers`,
            metadata: { servers },
            output: JSON.stringify({ servers }, null, 2),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

/** Configured server names the current agent and session are allowed to activate. */
const eligible = Effect.fnUntraced(function* (
  mcp: MCP.Interface,
  agents: Agent.Interface,
  sessions: Session.Interface,
  ctx: Tool.Context,
) {
  const agent = yield* agents.get(ctx.agent)
  const session = yield* sessions.get(ctx.sessionID)
  const ruleset = Permission.merge(agent.permission, session.permission ?? [])
  return Object.keys(yield* mcp.status()).filter(
    (name) => Permission.evaluate(ACTIVATION_PERMISSION, name, ruleset).action !== "deny",
  )
})
