# Claude CLI External Model Runtime

## Purpose

Expose Claude CLI-backed models through the normal OpenCode model and session experience while keeping all Claude-specific execution behavior inside the fork.

The workflow plugin selects these models like any other model and remains unaware that execution uses a local CLI process.

## Scope

Initial support is limited to one-shot workflow child sessions.

The implementation uses a private, model-neutral external-agent runtime, with Claude CLI as its first adapter. It does not need to become a public plugin extension point.

Equivalent v2 support is out of scope.

## Model Experience

- Claude CLI models appear in the normal model catalog under a dedicated provider.
- Models have human-readable names.
- Supported effort levels appear through the normal variant contract.
- Availability reflects whether the Claude executable and authentication are available.
- Sessions persist the provider, model, and variant through ordinary OpenCode fields.
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
- Transcript content becomes normal model-visible history.
- Executing a Claude turn does not invoke an HTTP model provider.

The existing fork's external-session presentation is the behavioral reference during migration.

## External Runtime Boundary

The fork owns a private external-agent runtime selected by model execution type.

The shared runtime is responsible for:

- Starting one external execution for a provider turn.
- Converting external output into normal OpenCode model events.
- Preserving event ordering and stable identities.
- Connecting cancellation to process lifetime.
- Producing exactly one terminal settlement.
- Preventing events after settlement.
- Reporting failures through normal session behavior.

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
```

The runtime also preserves these restrictions:

- Strict MCP configuration with no MCP servers.
- Slash commands disabled.
- Chrome integration disabled.
- Claude session persistence disabled.
- No Claude subagent-launching tool.
- One-shot prompt execution.
- Workflow-provided system instructions appended to the Claude prompt.
- Optional JSON schema supplied for structured-output requests.

No additional environment restrictions, permission disclosures, or security policy are required beyond preserving this behavior.

## Claude-Owned Tools

Claude retains ownership of its internal tool loop.

- Tool calls appear as provider-executed activity.
- OpenCode persists and displays the original tool name, arguments, output, and status.
- OpenCode does not execute the tool a second time.
- Original Claude input shapes remain available.
- Tool calls work with expandable tool-call details.
- The explicit Claude tool allowlist controls what the external agent may use.

## Structured Output

Claude CLI models support workflow structured-output requests through the normal OpenCode result contract.

- The workflow plugin supplies the same schema it supplies to other models.
- Claude-specific extraction remains inside the runtime adapter.
- Valid output is delivered through normal structured-output handling.
- Invalid or missing output follows normal retry and failure behavior.
- The workflow plugin contains no Claude-specific extraction logic.

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

## Recovery

- Graceful server shutdown terminates active Claude processes and settles their turns.
- An incomplete turn remains readable after restart.
- Initial support does not automatically resume execution after a hard crash.
- Claude external session IDs and `--resume` are not used.
- OpenCode remains authoritative for the persisted transcript.
- Multi-turn Claude continuation remains out of scope until history semantics can be reconciled.

## Persistence Compatibility

- Follow `fork-features/README.md`.
- Introduce no database schema changes or migrations.
- Persist ordinary messages, parts, provider/model identifiers, usage, and optional metadata.
- Keep Claude metadata optional and safe for upstream to ignore.
- Upstream OpenCode can open and display the resulting sessions.
- Continuing upstream may require selecting an upstream-supported model.
- Remove the external-transcript API only after all consumers migrate.

## Migration

1. Introduce the private external-agent runtime.
2. Register Claude CLI provider and model catalog entries.
3. Implement one-shot Claude execution and event translation.
4. Preserve the existing Claude tool and feature restrictions.
5. Integrate process cancellation.
6. Bridge structured output through normal OpenCode handling.
7. Validate ordinary sessions while retaining the old transcript path as rollback.
8. Switch workflow profiles to the generic model path.
9. Remove Claude-specific workflow code.
10. Remove the external-transcript API and its process-local coordination.
11. Replace hard-coded UI labels with catalog-provided names.

## Validation

- Claude models appear through normal model discovery.
- A workflow selects Claude through the generic model path.
- Text and reasoning stream normally.
- Tool calls retain stable identity and original data.
- Only the documented Claude tools are available.
- MCP, slash commands, Chrome integration, session persistence, and subagent launching remain disabled.
- Provider-executed tools are not dispatched by OpenCode.
- Structured output follows normal success and failure contracts.
- Stop terminates execution and settles the turn.
- Timeout, nonzero exit, malformed output, and missing completion settle safely.
- Parallel Claude child sessions remain isolated.
- Reloading preserves completed and incomplete transcripts.
- The workflow plugin contains no Claude process or transcript logic.
- Upstream can open the same database.
- No database schema changes are introduced.

## Non-Goals

- Supporting arbitrary external runtimes through a public plugin API.
- Supporting Claude multi-turn resume.
- Recovering in-flight execution after a hard crash.
- Implementing v2 execution or presentation.
- Requiring exact CLI-reported cost accounting.
- Adding restrictions beyond the current workflow plugin's Claude execution policy.
