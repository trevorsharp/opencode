# Expandable Tool Call Details

## Purpose

Provide labeled raw input and output for otherwise unrecognized tool calls without changing registered tool presentations.

## Required Behavior

- The labeled Input/Output treatment applies only to `BasicTool.GenericTool`, whose title is `Called {tool}` and which is selected only when `ToolRegistry` has no registered renderer.
- Generic calls can be manually expanded while pending, running, completed, failed, or interrupted, and streaming output updates while expanded.
- Every named or registered renderer retains its established custom display and receives no `ToolDetails`, `ToolSection`, `ToolArguments`, `ToolResponse`, generic borders, or duplicated raw data solely from this feature.
- This includes bash/shell, read/list/glob/grep/web/task, edit/write/apply_patch, question, skill, `ToolErrorCard`, context groups, and all other registered tools.
- TodoWrite remains hidden from timeline and session turns because todos render elsewhere.
- Workflow and schedule render only their dedicated progress card block, with no generic wrapper or details; semantic status icons remain inside those cards.
- Ordinary tool-call headers, including generic `Called {tool}` and task rows, do not show a completed checkmark or status marker.
- Running shell tools remain manually expandable without changing their established visual body.
- The "expand shell tools" setting controls default expansion only. It must never prevent manual expansion.
- Manual expansion state should survive tool status and output updates.

## Shared UI Design

- `BasicTool` continues to own shared disclosure behavior, accessibility, expansion state, and pending/running support.
- `GenericTool` provides the standard raw arguments-and-response fallback only for tools without registered views.
- Generic expanded content uses labels spelled exactly `Input` and `Output`, with bounded visible overflow for long text and code.
- All new Input/Output CSS is scoped beneath `[data-component=generic-tool-details]` so named tools are visually untouched.
- Expansion policy must be separate from expansion capability. Settings may choose the initial state but cannot disable the control.

## State Expectations

- **Pending:** Arguments are visible; no response is available yet.
- **Running:** Arguments and partial response are visible and update live.
- **Completed:** Final arguments and response are available.
- **Failed:** Arguments and error response are available.
- **Interrupted:** Arguments and any partial response remain available.

## Validation

- Unregistered `Called {tool}` rows expose complete labeled input and output.
- Running shell calls can be expanded when automatic shell expansion is disabled.
- Streaming output does not reset manual expansion state.
- Registered tools retain their specialized presentation without generic details or duplicated raw data.
- TodoWrite remains absent from timeline/session turns.
- Workflow and schedule show only their dedicated cards and preserve card-internal status icons.
- Ordinary generic and task headers have no completed status marker.
- Expansion works with keyboard navigation.
- Large arguments and responses remain usable without disrupting the timeline.

## Non-Goals

- Automatically expanding every tool call.
- Replacing custom tool views with generic JSON.
- Changing tool execution or persistence.
- Requiring a setting before tool details can be inspected.
