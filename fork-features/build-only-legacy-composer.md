# Build-Only Legacy Composer

## Purpose

Remove primary-agent selection from the legacy web UI and always submit interactive composer prompts through the built-in `build` agent.

## Required Behavior

- The legacy prompt composer does not render an agent selector.
- Agent cycling commands and keyboard shortcuts are not exposed.
- Desktop and command-palette agent cycling actions are removed.
- Every prompt submitted through the legacy composer uses `build`.
- Saved agent selections from previous versions are ignored.
- The configured `default_agent` does not override `build` for legacy composer submissions.
- Switching sessions does not change the composer's agent.
- User and assistant message headers do not show an agent label beside the model name. With one primary agent there is nothing to distinguish, so the label is noise.
- Subagent provenance that identifies a distinct child session remains visible.
- Subagents launched through task tools remain supported.
- Backend, plugin, SDK, and v2 agent-selection capabilities remain unchanged.

## Shared Design

- Resolve the legacy composer agent in one place as `build`.
- Do not retain hidden cycling state or inactive UI control models.
- Hiding the message agent label is display-only. Persisted agent metadata is still written and read unchanged.
- Keep primary-agent selection available outside the legacy composer.
- Keep subagent selection and task delegation independent from composer-agent selection.

## Validation

- No agent selector appears anywhere in the legacy composer.
- No agent cycling command or keybinding is available.
- Every legacy composer submission records `build` as its agent.
- No user or assistant message header renders an agent label next to its model name.
- Persisted agent metadata on historical messages is unchanged.
- Persisted selections and `default_agent` do not affect submissions.
- Session navigation does not change this behavior.
- Task delegation can still select subagents.
- External/API-created prompts retain their requested agents.

## Non-Goals

- Removing agents from the runtime or SDK.
- Removing subagents or task delegation.
- Rewriting historical agent metadata.
- Changing v2 behavior.
