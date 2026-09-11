# Claude CLI External Model Runtime

## Purpose

Expose Claude CLI-backed models through the normal OpenCode model and session experience while keeping all Claude-specific execution behavior inside the fork.

The workflow plugin selects these models like any other model and remains unaware that execution uses a local CLI process.

## Scope

Support includes ordinary multi-prompt sessions when OpenCode can prove an exact durable Claude continuation boundary.

The implementation uses a private, model-neutral external-agent runtime, with Claude CLI as its first adapter. It does not need to become a public plugin extension point.

Equivalent v2 support is out of scope.

## Model Experience

- Claude CLI models appear in the normal model catalog under a dedicated provider.
- Models have human-readable names.
- Supported effort levels appear through the normal variant contract.
- Models advertise image attachment support for JPEG, PNG, GIF, and WebP input.
- Availability reflects whether the Claude executable and authentication are available.
- Sessions persist the provider, model, and variant through ordinary OpenCode fields.
- Models advertise no context or output limit, and OpenCode does not track their token usage or cost. Claude owns its context management.
- OpenCode does not compact Claude CLI sessions or prune their persisted tool output. A context overflow fails visibly rather than creating a compaction turn that would break Claude's durable continuation boundary.
- Claude CLI uses the Anthropic provider icon through the shared provider-icon resolver.
- UI labels come from model catalog data rather than hard-coded mappings.

## Session Experience

Claude CLI sessions should feel as close to native OpenCode sessions as practical:

- Sessions are created through the normal session API.
- Prompts are admitted through the normal prompt API.
- User messages appear normally.
- Assistant text and reasoning stream into the timeline.
- Tool activity uses the standard tool-call presentation.
- Working state remains accurate while Claude is active.
- Stop interrupts execution.
- Completion, failure, interruption, and timeout settle normally.
- Reloading restores the transcript.
- A later user prompt resumes the immediately preceding completed Claude CLI conversation when its durable identity still matches.
- Transcript content becomes normal model-visible history.
- Text and image blocks retain their order within each user prompt.
- Executing a Claude turn does not invoke an HTTP model provider.

The existing fork's external-session presentation is the behavioral reference during migration.

## External Runtime Boundary

The fork owns a private external-agent runtime selected by model execution type.

The shared runtime is responsible for:

- Starting one external execution for a provider turn.
- Converting external output into normal OpenCode model events.
- Preserving event ordering and stable identities.
- Connecting cancellation to process lifetime.
- Settling a turn whose execution stops producing output.
- Producing exactly one terminal settlement.
- Preventing events after settlement.
- Reporting failures through normal session behavior.
- Preserving ordered text and file prompt content for the selected adapter.

Claude-specific arguments, event parsing, variants, structured output, and tool translation remain inside the Claude adapter.

## Claude Execution Policy

Preserve the current workflow plugin's Claude CLI execution policy.

Claude runs with skipped permission prompts and an explicit tool allowlist:

```text
Read
Glob
Grep
Edit
Write
Bash
WebFetch
WebSearch
StructuredOutput
TodoWrite
TaskCreate
TaskGet
TaskUpdate
TaskList
Skill
ToolSearch
```

`Skill` and `ToolSearch` are Claude's own discovery tools. Claude-native skills run through the tools above, and Claude finds the OpenCode tool facade's tools by searching for them, because a CLI-side MCP server's tools are loaded on demand rather than listed up front. The allowlist governs Claude's built-in tools only: what the facade exposes is decided by the facade, not by `--tools`.

The runtime also preserves these restrictions:

- Strict MCP configuration naming exactly one server: OpenCode's own tool facade.
- Chrome integration disabled.
- No Claude subagent-launching tool.
- Bundled Claude skills, auto memory, and the `thrifty_sonic` experiment disabled through the child process environment; user and project skills remain available.
- Claude session persistence enabled so later OpenCode prompts can resume an exact completed turn.
- Workflow-provided system instructions appended to the Claude prompt.
- Optional JSON schema supplied for structured-output requests.
- Image turns use one newline-terminated `stream-json` user message on stdin; text-only turns retain plain-text stdin.
- Partial message output enabled so text and readable thinking reach OpenCode as Claude produces them.

No additional environment restrictions, permission disclosures, or security policy are required beyond preserving this behavior. The runtime sets `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, and `CLAUDE_CODE_THRIFTY_SONIC=0` directly, so this policy does not depend on any user's Claude settings file.

A turn that produces no output for five minutes is treated as stuck: the runtime terminates the process group and settles the turn as failed. Installations can widen or narrow that window with `provider["claude-cli"].options.chunkTimeout`, the same option other providers use for silent streams. A facade call cannot trip that window: the watchdog measures output OpenCode is waiting for, and while OpenCode is running a tool for Claude it is not waiting for any.

## Claude-Native Skills

The legacy web composer does not expose slash commands. This does not affect Claude-native skills: Claude discovers a mapped skill through its own `system/init` catalog, loads it with its `Skill` tool, and performs the work with its own tools. OpenCode's own skill tool is never exposed to Claude, so a skill runs exactly once, in Claude's loop.

## OpenCode Tool Facade

Claude reaches the OpenCode tools it has no equivalent for through one fork-private MCP server that OpenCode itself runs. The facade is what makes those tools available; it is not a general MCP bridge, and it never re-exposes work Claude can already do.

What the facade exposes for a turn:

- `notify`.
- `workflow_run`, `workflow_status`, and `workflow_cancel`.
- `schedule_create`, `schedule_list`, `schedule_status`, and `schedule_cancel`.
- `question`, and only for a session with no parent: a child session has no user watching it to answer.
- Every tool the currently connected OpenCode MCP servers provide, under the same public name OpenCode gives it, with case preserved end to end.

What it never exposes:

- Anything Claude has natively — reading, writing, editing, searching, fetching, running commands, its own bookkeeping, structured output, and skills.
- MCP resources and resource templates. Proxying MCP tools is the first version's scope; resource tools remain OpenCode-side only.
- A tool the prompt or the agent's permissions disabled. The tool filtering the HTTP model path applies also decides the facade's catalog, so a workflow child session still cannot start workflows and a schedule session still sees only what it is allowed.
- A name that both the fixed catalog and an MCP server claim. Provenance is read from the resolved tool map itself, where MCP tools are the dynamic ones, so the facade judges the map that actually runs rather than a second snapshot of it. Which implementation such a map holds was decided by assembly order, so neither is offered and the collision is logged.

Claude Code caps each MCP tool description at 2,048 UTF-8 bytes. The Claude adapter declares that limit and the shared facade applies it to every tool in the permission-filtered catalog:

- Descriptions within the limit pass through unchanged.
- An oversized description is retained for the current execution and replaced in `tools/list` by a byte-bounded prefix that directs Claude to `tool_help` before using the tool.
- `tool_help` is added only when at least one exposed tool needs it. Its `name` schema enumerates only those oversized tools, and its result is the complete original description.
- Help lookup runs through the same facade call path and appears as ordinary provider-executed tool activity.
- A tool excluded by permissions cannot appear in the help map, so its description cannot be recovered through `tool_help`.
- Existing tools named `tool_help` are not exposed because the name is reserved for the facade helper, and the collision is logged.
- Every oversized description and its byte length are logged rather than relying on Claude Code's silent truncation.

This keeps large dynamic contracts such as `workflow_run` available on demand without injecting them into every system prompt or changing their descriptions for non-Claude models.

Public MCP tool names are unique by construction, which the facade depends on and every model benefits from: sanitizing a server name and a tool name can collapse two distinct tools onto one public name, so OpenCode drops a public name more than one tool claims and logs it, rather than letting listing order pick a winner.

How a facade call behaves:

- Claude finds facade tools with `ToolSearch` and calls them over MCP. The token authorizing the call reaches Claude only through its environment, expanded from the MCP configuration, so it never appears in argv.
- Claude's own tool-call id is the canonical OpenCode call id. One facade call is one OpenCode tool call with one result, and Claude's own `tool_result` block adds nothing to the transcript.
- Claude's reported tool call, not the MCP request, is what causes execution. A call OpenCode never observed in Claude's output is refused rather than run as invisible activity, as is a call whose reported name or arguments disagree with the request, or a name the facade never offered. The reported arguments are the ones OpenCode runs, compared as canonical JSON so key order alone decides nothing, and a request that disagrees with them is treated as a different call wearing an observed call's id.
- A call id identifies exactly one call. A repeated id is refused rather than executed again, and the repeat is not reported as activity of its own, because OpenCode cannot tell which report a request belongs to. Each observed call is taken for execution once.
- A refusal is final. Once Claude has read an error for a call — because it was uncorrelated, because Claude cancelled it, or because the turn ended — output arriving afterwards never runs that tool, since running it then would be a second attempt Claude cannot see. Cancelling a call already running only ends Claude's wait: the call is already in OpenCode's transcript, and abandoning a half-applied tool is worse than finishing it.
- The call runs through the already-resolved OpenCode tool closure, so plugin hooks, permission prompts, session context, and attachment handling behave exactly as they do for any other model. A permission prompt appears normally and the call waits for it.
- The call is recorded before it runs, so a slow facade tool appears as running work and the metadata it reports while running reaches the timeline.
- Facade activity is presented as provider-executed, like Claude's own tools: Claude already has the result and continues its own loop, so the turn never schedules another provider round for it.
- Results carry text and images. OpenCode keeps the full settlement — title, metadata, and original attachment records — in its own transcript either way.
- One process-global loopback listener owns every registration and outlives all of them, and each Claude execution gets a fresh MCP server and stateful transport. A released registration is unreachable: a late call from a settled turn is answered as unauthorized, exactly like a call that was never registered, rather than by a refused connection.
- A long call keeps its connection warm with MCP progress notifications, or with log messages when the agent asked for no progress, so a slow tool or a waiting permission prompt does not lose the connection carrying its result. The tool's own timeout still applies: a proxied MCP tool is bounded by the timeout its server is configured with, exactly as it is for any other model.
- If Claude never connects to the facade, the turn still runs with Claude's native tools and the missed connection is logged. Claude cannot fake facade activity: only structured tool calls from a registered catalog are executed, never rendered text.

## Asking the User

`question` is the one facade tool OpenCode keeps running after Claude's execution ends, because a user answers in their own time and no MCP request may be held open for that.

- The facade answers Claude immediately, telling it to end its turn and await the answers.
- The question tool call stays running, so the normal question dock appears and the OpenCode assistant turn stays open.
- Claude's execution ends at an ordinary completed boundary. Nothing holds a process or a request open while the user reads.
- After a reply or a dismissal, the tool call settles normally and the same assistant turn continues by resuming Claude's completed conversation with the answers as its prompt. Each execution contributes its own step; only the last one ends the turn, and the last step is the one that owns the resume boundary for later prompts.
- Cancelling the turn takes the question back: the pending request is rejected, the dock closes, and the call settles as interrupted like any other cancelled tool. This holds while the turn is waiting for the answer, which is where a cancelled question spends most of its life.
- A turn spends at most four executions, so an agent that keeps asking still settles.
- A turn that could not deliver an answer even if it had one — no Claude boundary to resume, or its executions spent — takes the question back immediately instead of asking the user for something nothing will read.

## Claude-Owned Tools

Claude retains ownership of its internal tool loop.

- Claude `stream_event` text and thinking blocks use the provider message ID plus content block index as their stable OpenCode stream identity. Starts, deltas, and stops map to the corresponding OpenCode text or reasoning lifecycle.
- Completed assistant events remain authoritative for tool calls. Their text and thinking blocks are omitted only when a matching partial lifecycle was observed, and otherwise provide the compatibility fallback for output without partial events.
- Provider message and result boundaries close any still-open text or thinking lifecycle. Cancellation may instead leave an open lifecycle for the session processor's ordinary interrupted-part cleanup.
- Tool calls appear as provider-executed activity.
- OpenCode persists and displays the original tool name, arguments, output, and status.
- Task bookkeeping tools are the one exception and become native todos.
- OpenCode does not execute a tool Claude already ran a second time.
- Original Claude input shapes remain available.
- Tool calls work with expandable tool-call details.
- The explicit Claude tool allowlist controls which of Claude's built-in tools it may use; the facade catalog controls which OpenCode tools it may reach.

## Claude Task Bookkeeping

Claude's bookkeeping tools describe the same thing OpenCode already models as session todos, so their activity becomes native todos instead of tool calls.

- `TodoWrite`, `TaskCreate`, `TaskUpdate`, `TaskGet`, and `TaskList` are translated into ordinary OpenCode todo updates through the existing todo tool and `todo.updated` event.
- The app and TUI render the resulting list with their native todo presentation.
- A successful bookkeeping call produces no generic timeline tool call.
- A call that changes nothing produces no todo update.
- All other Claude tools keep ordinary tool-call presentation.
- A translated update is provider-executed activity: Claude already applied it to its own list, so OpenCode owes it no result and the update never keeps the turn running for another step. OpenCode still runs its own todo tool, which is the only way the session list changes.
- The translation requires `todowrite` to be reachable in the turn's resolved tool map. An agent that denies it, permissions that would prompt for it, or a prompt that disables the tool all keep bookkeeping as ordinary provider-executed tool calls and write no todos, rather than asking for work Claude already performed or failing an update the turn could never run. The Claude tool allowlist is the same either way.

Translation rules:

- Mutations are applied only after a result, never from the call alone.
- Whole-list results are authoritative: `TodoWrite` reports `newTodos`, and `TaskList` reports every task's id, subject, and status, which is everything an OpenCode todo needs.
- Single-task results are applied in place, keyed by task id, so Claude's creation order survives later edits.
- A task's subject becomes the todo content.
- `pending`, `in_progress`, and `completed` map directly; any other status is treated as not started.
- Deletion is `TaskUpdate` with status `deleted`, which removes the todo.
- Descriptions, active forms, owners, and `blocks`/`blockedBy` dependencies have no OpenCode equivalent and are ignored.
- Priority is always `medium` because Claude reports none.

Failure handling reflects the CLI's contract that domain errors arrive as ordinary results:

- A structured payload reporting `success: false` (`TaskUpdate`) or a null task (`TaskGet`) is a failure even though the result is not marked as an error.
- A failed bookkeeping call is reported as the tool call Claude actually made, so the timeline shows what went wrong.
- A failed call never mutates the todo list.
- An edit naming an unknown task without describing it is dropped rather than inventing a todo.

Continuity across turns, because OpenCode's todo tool replaces the whole list while a resumed Claude conversation still owns tasks from earlier turns:

- Claude's task feature modes are mutually exclusive: an installation exposes either `TodoWrite` or the `Task*` tools, so the translation handles both without assuming both are present.
- Each Claude execution starts a translator seeded with the session's current todos, so a result about one task never drops the others.
- A seeded todo carries no Claude task id until a result names it. The first result whose text matches one adopts that row, so a task OpenCode already renders is updated in place instead of appearing twice.
- A result naming a task the turn has not observed appends a row: `TaskCreate` on a resumed turn adds to the rendered list rather than replacing it.
- A whole-list result — `TaskList` or `TodoWrite` — reconciles the list completely and is the only thing that removes rows the turn never observed.
- A status-only edit or a deletion of a task from an earlier turn carries no text to match, so it changes nothing and leaves the previously rendered todo in place.
- Todos already persisted for the session survive a turn that performs no bookkeeping, and survive a restart because the seed is OpenCode's own list rather than remembered translator state.

## Structured Output

Claude CLI models support workflow structured-output requests through the normal OpenCode result contract.

- The workflow plugin supplies the same schema it supplies to other models.
- Claude-specific extraction remains inside the runtime adapter.
- Valid output is delivered through normal structured-output handling.
- Invalid or missing output follows normal retry and failure behavior.
- Structured-output retries start a fresh CLI execution rather than resuming the completed attempt, and resend only the original current prompt plus retry instructions.
- The workflow plugin contains no Claude-specific extraction logic.

## Multi-Prompt Continuation

Claude's `system/init` session ID is persisted as optional metadata on streamed assistant parts and on the completed OpenCode step. A later prompt passes `--resume` with `--fork-session` only when all of these conditions hold:

- The selected model is the same Claude CLI provider and model.
- The metadata belongs to the immediately preceding completed assistant message.
- No failed or newer assistant turn intervenes; an immediately preceding user-aborted turn is resumable only when one of its streamed parts retained the Claude session ID.
- The newest user message is a real user prompt rather than synthetic continuation state, with one exception below.
- The turn is not a structured-output retry.

Resumed executions fork the preceding Claude session so every completed OpenCode turn owns an immutable Claude continuation boundary, while a user-aborted turn may continue from the interrupted CLI session itself. Undo resumes a surviving earlier completed turn without retaining the reverted messages in Claude's history. Resumed executions send only the newest ordered user content because Claude owns the durable conversation history. Historical requests without an exact resume boundary remain rejected rather than silently losing assistant or tool history. First prompts and structured-output retries retain fresh-execution behavior, and Claude-owned same-turn tool activity never triggers another OpenCode provider turn.

The one synthetic exception is a workflow completion. A run the model started itself reports back as an all-synthetic message carrying the workflow plugin's run marker, and refusing it would leave the model unable to read its own result, so a marked completion may resume an otherwise exact boundary. The marker is a designation rather than proof — any client that can prompt the session can already drive it — so every other boundary condition still has to hold, and an unmarked all-synthetic message is still refused. When the boundary is not exact, that turn fails visibly with the same boundary error as any other historical request rather than silently losing history.

## Image Attachments

- User images remain ordinary persisted file parts and require no additional database state.
- The external runtime preserves ordered text and file blocks; Claude-specific MIME validation and wire encoding stay in the Claude adapter.
- The adapter accepts base64 data URLs for JPEG, PNG, GIF, and WebP images and rejects unsupported media, malformed base64, and MIME mismatches rather than silently dropping content.
- Image-only prompts are valid.
- A resumed turn sends images from only its newest user prompt. Images from earlier completed turns remain available through Claude's durable conversation.

## Workflow Plugin Boundary

After migration, the workflow plugin only:

- Selects a model and variant.
- Creates an ordinary child session.
- Submits an ordinary prompt.
- Supplies optional system instructions and output schema.
- Waits for the ordinary session result.
- Manages phases, concurrency, cards, cancellation, and journals.

The workflow plugin does not:

- Select a Claude-specific execution path.
- Spawn or terminate Claude processes.
- Construct Claude arguments.
- Parse Claude output.
- Translate Claude tools.
- Post external transcript entries.
- Track Claude session identifiers.
- Implement Claude-specific retries or settlement.

## Cancellation

- OpenCode owns the Claude process lifecycle.
- Session Stop interrupts the execution scope that owns the process.
- An already-cancelled request does not start a process.
- Cancellation terminates the complete process group.
- Late output is ignored after cancellation or settlement.
- Workflow cancellation uses ordinary session cancellation behavior.
- Cancellation produces a normal interrupted or terminal assistant turn.
- Streamed assistant parts retain the Claude session ID, so a later prompt can fork-resume an immediately preceding user-aborted turn just as Claude CLI resumes after an interactive interruption. Other failed turns remain non-resumable.
- An interruption before Claude reports its session ID has no exact boundary, so the next prompt fails with the boundary error rather than starting a fresh conversation that would silently lose the history Claude owns. Cancelling a question before its completed execution boundary has the same limit.
- Undo does not resume the interrupted Claude state. It uses OpenCode's ordinary snapshot revert to restore tracked file changes, removes the reverted messages when the replacement prompt is admitted, and forks the surviving earlier completed Claude boundary. Undoing the first turn starts the replacement prompt as a fresh Claude session because no earlier boundary exists.
- Cancelling releases the turn's facade registrations, so an in-flight facade call is answered with an error and a later call from the dead execution is refused.
- A question the turn was still waiting on is rejected, so the dock closes instead of outliving the turn that asked.

## Recovery

- Graceful server shutdown terminates active Claude processes and settles their turns.
- An incomplete turn remains readable after restart; a user-aborted turn is resumable when its persisted parts contain the Claude session ID.
- Initial support does not automatically resume execution after a hard crash.
- Completed turns persist distinct forked Claude session IDs and use `--resume` only at an exact later-user boundary.
- OpenCode remains authoritative for the persisted transcript.
- In-flight provider work is not recovered after a crash, and a crash-incomplete turn cannot become a resume boundary.

## Persistence Compatibility

- Follow `fork-features/README.md`.
- Introduce no database schema changes or migrations.
- Persist ordinary messages, parts, provider/model identifiers, zero-valued compatibility usage fields, and optional metadata.
- Keep all facade state in memory: registrations, tokens, and pending calls last no longer than the turn that created them.
- Keep Claude metadata optional and safe for upstream to ignore.
- Upstream OpenCode can open and display the resulting sessions.
- Continuing upstream may require selecting an upstream-supported model.
- Remove the external-transcript API only after all consumers migrate.

## Migration

1. Introduce the private external-agent runtime.
2. Register Claude CLI provider and model catalog entries.
3. Implement one-process-per-turn Claude execution and event translation.
4. Preserve the existing Claude tool and feature restrictions.
5. Integrate process cancellation.
6. Bridge structured output through normal OpenCode handling.
7. Validate ordinary sessions while retaining the old transcript path as rollback.
8. Switch workflow profiles to the generic model path.
9. Remove Claude-specific workflow code.
10. Remove the external-transcript API and its process-local coordination.
11. Replace hard-coded UI labels with catalog-provided names.
12. Persist exact completed-turn Claude identities and enable safe later-user resume.
13. Expose the OpenCode tool facade, enable Claude-native skills, and continue a turn across executions for questions.

## Validation

- Claude models appear through normal model discovery.
- A workflow selects Claude through the generic model path.
- Claude models advertise no context window, output limit, or pricing.
- Completed Claude turns persist zero token counts and zero cost even when the CLI reports usage.
- Claude CLI sessions do not create OpenCode compaction turns or prune persisted tool output, and a reported context overflow fails visibly.
- Text and reasoning stream normally.
- First, resumed, and image-only prompts deliver supported images to Claude in their original content order.
- Unsupported image formats, malformed data URLs, and MIME mismatches fail visibly instead of degrading to text-only prompts.
- Structured-output image retries do not resend unrelated images from older turns.
- Tool calls retain stable identity and original data.
- Only the documented Claude tools are available.
- Claude task bookkeeping renders as native todos in the app and TUI.
- Successful bookkeeping calls produce no generic timeline tool call, and failed ones do.
- Deleted tasks disappear from the todo list, and unknown task ids change nothing.
- A turn that updates todos settles idle without starting another step.
- A resumed turn's task activity keeps the todos earlier turns rendered.
- An agent that does not allow `todowrite`, or a prompt that disables it, produces bookkeeping tool calls instead of todos, with no permission prompt and no failed update.
- Chrome integration and subagent launching remain disabled, and the only MCP server Claude sees is OpenCode's facade.
- Tools Claude ran itself are not dispatched again by OpenCode.
- A mapped skill is discovered and executed by Claude, using Claude's own tools.
- Every facade tool round-trips as exactly one call/result pair carrying Claude's own call id, with its OpenCode name and case intact.
- A facade description of at most 2,048 UTF-8 bytes passes through unchanged.
- Every oversized facade description is detected and logged, its listed description stays within 2,048 UTF-8 bytes, and `tool_help` returns the complete original description.
- `tool_help` cannot retrieve a tool excluded from the turn or collide silently with another tool of that name.
- A facade tool a prompt or an agent's permissions disabled is not offered, so a workflow child session cannot start workflows.
- A name claimed by both the fixed catalog and an MCP server is offered to neither and logged.
- A public name more than one MCP tool claims is offered to no model and logged.
- A permission prompt raised by a facade call appears normally and the call waits for it.
- A facade call longer than the connection's idle window and longer than the silent-execution watchdog still returns its result, and the call it belongs to appears as running work while it runs.
- A refused or uncorrelated facade call reports an error to Claude and executes nothing, including when Claude's output reports the call after the refusal.
- A facade request whose arguments differ from the ones Claude reported is refused, and only the reported arguments ever run.
- A repeated call id runs nothing a second time and adds no second call to the transcript.
- The facade address answers a released token as unauthorized for as long as the process lives.
- `question` is offered to a root session and never to a child session.
- Asking a question keeps the dock, the running tool call, and the assistant turn open across two Claude executions, then completes the call with the answers and continues the same turn.
- Cancelling a pending question clears it, closes the dock, and settles the turn interrupted, whether the turn was still executing or already waiting for the answer.
- A question a turn cannot deliver an answer to is withdrawn without waiting for the user.
- A marked workflow completion resumes an otherwise exact Claude boundary; an unmarked all-synthetic message still does not.
- A later real user prompt forks the matching completed Claude CLI session with only the new ordered text and image content.
- Undoing a later turn resumes the surviving earlier Claude boundary without the reverted messages.
- An immediately preceding user-aborted turn resumes when Claude reported a session ID before termination; interruption before that point fails safely, and undo still resumes only a surviving completed boundary.
- Model switches, non-interruption failures, stale metadata, same-turn activity, and structured-output retries do not resume a Claude session.
- Structured output follows normal success and failure contracts.
- Stop terminates execution and settles the turn.
- Timeout, nonzero exit, malformed output, and missing completion settle safely.
- Parallel Claude child sessions remain isolated.
- Reloading preserves completed and incomplete transcripts.
- The workflow plugin contains no Claude process or transcript logic.
- Upstream can open the same database.
- No database schema changes are introduced.

## Non-Goals

- Exposing OpenCode tools Claude already has natively.
- Proxying MCP resources or resource templates through the facade.
- Treating the facade's token as an isolation boundary: a local agent that can run commands can read its own environment, so the token is loopback routing, not a sandbox.
- Supporting arbitrary external runtimes through a public plugin API.
- Recovering or resuming a crash-incomplete Claude turn, including a question a restart interrupted: pending questions stay process-local, exactly as they are for OpenCode's own models.
- Recovering in-flight execution after a hard crash.
- Implementing v2 execution or presentation.
- Tracking or displaying Claude CLI token usage, context occupancy, or cost.
- Adding restrictions beyond the current workflow plugin's Claude execution policy.
