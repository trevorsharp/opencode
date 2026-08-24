# On-Demand MCP Activation

## Purpose

Keep configured MCP servers discoverable without placing every MCP tool definition in every model request.

OpenCode includes a small server-name list in the model's instructions and lets the model activate only the MCP servers needed for the current session tree. Underlying MCP clients remain reusable at directory scope, while tool definitions, resources, and server instructions are visible only to the root session and its nested sessions after activation.

This feature applies to the legacy session runtime. Equivalent v2 support is out of scope until the v2 runtime owns MCP connection and tool registration.

## Terminology

- A configured server is an MCP server present in the merged OpenCode configuration.
- A connected server has a live directory-scoped MCP client.
- An activated server is selected for one root session and its nested sessions.
- A session tree is a root session together with every session that descends from it through the existing parent-session relationship.
- A materialized capability is an MCP tool definition, resource capability, or server instruction included in a model request.

Configuration, credentials, client processes, transport connections, and the fetched MCP catalog remain directory-scoped. Activation and materialization are session-tree-scoped.

## Required Behavior

- Configured MCP servers do not contribute tool definitions to a session until that session tree activates them.
- Connecting a server does not by itself activate that server for every session in the directory.
- Activating a server makes its capabilities available to the root session and every nested session in that tree.
- Activating a server from a nested session makes it active for the entire session tree.
- Separate root session trees in the same directory may activate different MCP servers while sharing the same underlying clients.
- Agents and sessions continue to apply their own tool permissions after activation. Activation never grants permission to call an MCP tool.
- Configured server names eligible for activation are included in each model request without requiring a discovery tool call.
- MCP server instructions are included only for servers active in the requesting session tree.
- MCP resources and resource templates are discoverable and readable only from servers active in the requesting session tree.
- The feature introduces no database schema changes.

## Agent Discovery And Tools

One small built-in tool is always eligible for the normal OpenCode tool catalog and the Claude CLI facade.

### Server List

Each provider request includes the configured MCP server names that the current agent is allowed to activate. Normal providers receive the list in the system prompt. Claude CLI receives it through the private facade registration's MCP instructions.

Example list:

```json
["Carvana Publish", "Chrome DevTools", "Datadog", "Fastlane", "Google Drive", "Jira", "Slack", "Snowflake", "Splunk"]
```

- Names match the configured names shown by the existing MCP status UI, including servers configured as disabled.
- The list contains no descriptions, statuses, tool names, or tool schemas.
- A server denied by the activation permission, in either the agent's or the session's ruleset, is omitted.
- Constructing the list performs no connection or activation side effect and requires no permission prompt.
- The list is rebuilt whenever the turn resolves its tools and instructions, including after Claude CLI activation refreshes the facade.

### `mcp_enable`

`mcp_enable` accepts one or more names from the available server list.

Example input:

```json
{
  "names": ["Datadog", "Splunk"]
}
```

- The input is a batch so one workflow can activate related servers together and Claude does not spend one execution per server.
- Every name is validated against the configured servers before any connection or activation side effect. A configured name the ruleset denies is not an unknown name; it is refused by the activation permission instead.
- The complete requested set is authorized before any server is connected. A denial causes no partial activation.
- Activation uses a dedicated permission action with each configured server name as its pattern.
- Allowed servers are added to the session tree's activation set.
- A server without a live directory-scoped client is connected through the existing MCP connection path.
- Connection transitions for one server are serialized so concurrent activation cannot start duplicate clients.
- Repeated activation is idempotent.
- The result reports the final status of every requested server, including connected, failed, needs authentication, and needs client registration.
- A failed server does not prevent independently successful servers in the same authorized batch from becoming available.
- A successful result may report newly available public tool names, but those names are not part of the available server list.
- Authentication remains user-driven through the existing MCP authentication UI and endpoints.

The tool name describes session activation rather than persisted configuration. `mcp_enable` does not write `enabled: true` to an OpenCode configuration file.

## Connection And Activation Ownership

Directory-scoped connection ownership avoids duplicate local processes, authentication sessions, remote transports, startup work, and catalog fetches.

Session-tree-scoped activation prevents one conversation from adding MCP schemas and instructions to every other conversation in the same directory.

Conceptually:

```text
Directory clients:
  Chrome DevTools: connected
  Datadog: connected
  Snowflake: connected

Session tree A:
  Chrome DevTools
  Datadog

Session tree B:
  Snowflake
```

Tool resolution intersects the connected catalog, the session tree's activation set, prompt-level tool selection, and agent/session permissions. A capability must pass every boundary before it is materialized or callable.

Activation state is process-local and requires no new persisted record. It remains available to later turns and nested sessions while the process retains that root session's activation state. Restarting OpenCode clears activation state; a resumed session receives the available server list again and can call `mcp_enable`. Directory disposal closes the underlying MCP clients through the existing lifecycle.

No automatic disconnect occurs when a session or nested session becomes idle. Disconnecting a shared client at a session boundary could interrupt another session tree using the same directory-scoped connection.

## Normal OpenCode Provider Flow

For an ordinary provider turn:

1. The model reads the available server names from its system instructions or follows skill guidance that names a server directly.
2. The model calls `mcp_enable` with the required names.
3. OpenCode validates and authorizes the complete batch, updates session-tree activation, and connects missing clients.
4. The tool result settles normally.
5. The existing session loop resolves tools and the available server list again before the next provider request.
6. Only capabilities from activated servers are materialized for that session tree.

The first version activates at server granularity. Every permitted tool from an activated server may be materialized for ordinary providers. Fine-grained tool search or per-tool materialization may be added separately if one activated server still contributes excessive context.

## Skills

Skills may instruct the agent to enable known MCP dependencies, but skill metadata does not own connection lifecycle.

Examples:

```text
Enable Chrome DevTools before following this skill.
```

```text
Enable Datadog and Splunk before monitoring the release.
```

This keeps skill invocation, command-injected skill guidance, and general MCP discovery on the same activation path. Invoking a skill does not silently bypass the activation permission.

## Claude CLI Flow

Claude CLI receives the available server list through OpenCode's private MCP facade instructions and discovers `mcp_enable` through Claude's native `ToolSearch` behavior.

The facade catalog is rebuilt after activation changes available capabilities:

1. Claude calls `mcp_enable` through the facade.
2. OpenCode records and executes the call through the normal tool settlement path, including activation permission and plugin hooks.
3. OpenCode connects the requested servers and determines whether the session tree's available catalog changed.
4. When the catalog changed, the facade result tells Claude to end the current execution immediately without commentary because OpenCode will resume it with refreshed tools.
5. Claude completes the execution at an ordinary resumable boundary.
6. OpenCode resolves the session's tools and MCP instructions again.
7. OpenCode creates a fresh facade catalog, rendezvous, MCP registration, and token for the next execution.
8. OpenCode resumes the same Claude conversation with `--resume` and `--fork-session` inside the same OpenCode assistant turn.
9. The continuation prompt tells Claude that activation completed and to continue the original task. Claude finds newly available MCP tools through `ToolSearch`.

The refreshed catalog is per execution rather than frozen for the entire external-runtime stream. An execution never mutates the catalog of its existing facade registration.

The activation continuation follows the same external-runtime boundary used for questions, with these differences:

- Activation waits for no user response.
- The activation tool settles before the current execution ends.
- OpenCode resumes only when activation changed the available catalog and Claude supplied an exact resumable session boundary.
- An idempotent activation or a result that made no tools available does not require a refresh execution.
- A turn that cannot resume reports that activation will be visible on the next user turn instead of claiming same-turn availability.
- Questions and activation requested during one execution are combined into one subsequent execution after the question settles and the catalog refresh completes.
- Activation continuations count toward the existing per-turn execution limit. Batch input minimizes that cost.

Each Claude execution contributes its own step, while only the final execution ends the OpenCode assistant turn. The final execution owns the durable Claude resume boundary used by later user prompts.

## Facade Refresh Boundary

Supporting Claude activation requires the external runtime to refresh more than its transport:

- Tool resolution must be callable again after an activation settles.
- The facade catalog and reserved-name collision checks must run against the refreshed tool map.
- The facade rendezvous must accept exactly the names offered by the refreshed catalog.
- A fresh MCP registration and token must be created for the resumed Claude process.
- The available server list and active MCP server instructions must be rebuilt for the session tree. Claude receives them as the facade registration's own MCP instructions, because an external execution carries only the workflow-supplied system prompt.
- The previous execution's registration must be released and remain unauthorized.

Reusing a fresh transport with the previous execution's frozen tool array is not a valid refresh.

## Permissions And Safety

- The model instructions reveal only configured server names eligible for the current agent and session.
- `mcp_enable` can activate only configured servers and never exposes dynamic server creation.
- Activation permission is checked before starting a process or network connection.
- Batch authorization completes before any side effect.
- Existing per-tool permission checks still run when an activated MCP tool is called.
- Prompt-level and agent-level tool disabling still remove tools from both ordinary provider catalogs and the Claude facade.
- Public MCP tool-name collision handling remains unchanged.
- OAuth and client registration cannot be completed silently by the model.

## UI Behavior

The existing MCP status UI continues to show and control directory-scoped connection status.

- The UI does not display the process-local activation set in the first version.
- Connecting a server from the UI does not activate it for every session tree.
- Disconnecting from the UI removes the shared client, so an activated server contributes no capabilities until it reconnects.
- A later successful connection makes the server eligible again for session trees that still have it activated.
- Agent-driven connection, authentication, failure, and disconnection transitions refresh the existing MCP status UI through one coherent MCP catalog/status event path: the existing `mcp.tools.changed` event, which every connection transition now publishes and the UI invalidates both MCP status and MCP resources on.
- The MCP-only status popover remains governed by `mcp-only-status-popover.md`.

## Failure Handling

- Unknown names fail validation before authorization or connection.
- Permission denial produces no activation or connection side effect.
- Connection failure is returned as a per-server result rather than failing unrelated authorized servers.
- Authentication-required and client-registration-required states are returned explicitly.
- Concurrent operations for the same server settle through one serialized transition.
- Cancellation stops waiting for activation and prevents a Claude refresh continuation from starting.
- A cancelled or interrupted Claude execution does not become a resume boundary.
- If Claude ignores the instruction to end its execution, no new tool is injected into the already-running facade catalog.
- If catalog refresh or Claude resume fails, the turn settles visibly and the successfully established directory connection remains available for a later activation attempt.

## Persistence Compatibility

- Introduce no database tables, columns, indexes, migrations, or constraints.
- Keep activation state process-local.
- Persist `mcp_enable` and MCP tool activity as ordinary session tool calls and results.
- Keep Claude execution identities in the existing optional metadata described by `claude-cli-external-model-runtime.md`.
- Upstream OpenCode can open and display the same session database while ignoring fork-only tool semantics.

## Implementation Boundaries

- Keep directory-scoped MCP client ownership in the existing MCP service.
- Add session-tree activation as a separate filter rather than cloning MCP clients into sessions.
- Resolve a session tree through existing parent-session relationships; do not add persisted ownership fields.
- Keep Claude continuation and facade regeneration inside the private external-agent runtime.
- Keep Claude-specific end-and-resume instructions out of the generic MCP service.
- Reuse the existing MCP connection, authentication, catalog conversion, permission, plugin-hook, and tool-settlement paths.
- Do not introduce a second MCP implementation in a plugin or skill subsystem.

## Validation

- Each model request includes only configured, activation-eligible server names, and building the list performs no side effect.
- `mcp_enable` accepts a batch, authorizes the complete batch first, and connects allowed servers idempotently.
- Unknown names and permission denial cause no partial connection or activation.
- Successful and failed servers in one authorized batch report independent final statuses.
- Two root sessions in one directory can expose different MCP catalogs while sharing connected clients.
- A nested session inherits its root session's activated servers.
- Activation by a nested session becomes visible to its root and sibling sessions on their next provider turns.
- Inactive servers contribute no tool schemas, resources, or MCP instructions to a session.
- Activated MCP tools still enforce their individual permissions.
- Restarting OpenCode clears activation without requiring database repair or migration.
- UI connection status refreshes after agent-driven MCP transitions.
- Claude receives the available server list through facade instructions and discovers `mcp_enable` through `ToolSearch`.
- A catalog-changing Claude activation ends one execution, rebuilds the tool and instruction catalogs, and resumes the same conversation in the same OpenCode assistant turn.
- The resumed Claude execution receives a new facade registration and can find the newly activated MCP tools through `ToolSearch`.
- An idempotent or unsuccessful activation that changes no catalog does not spend another Claude execution.
- Claude activation and a pending question continue through one refreshed execution when both occur in the same turn.
- Cancellation and the execution limit prevent unbounded or orphaned Claude continuations.
- No database schema changes are introduced.
- The package build succeeds through `./packages/opencode/script/build.ts --single`.

## Non-Goals

- Persisting activation across OpenCode restarts.
- Persisting MCP configuration changes from `mcp_enable`.
- Starting one MCP client per session or nested session.
- Automatically disconnecting shared MCP clients when a session becomes idle.
- Adding descriptions, statuses, tool names, or schemas to the available server list.
- Allowing an agent to add or modify MCP server configuration.
- Automatically activating a server merely because it connected through the UI.
- Fine-grained per-tool search or materialization for ordinary providers in the first version.
- Exposing MCP resources or resource templates through the Claude facade.
- Implementing v2 MCP activation before v2 owns MCP connection and tool registration.
