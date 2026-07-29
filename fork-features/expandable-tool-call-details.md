# Expandable Tool Call Details

## Purpose

Provide visibility into every tool call from the session UI.

## Required Behavior

- Every tool call can be manually expanded.
- Expanded calls expose both arguments and responses.
- Calls remain expandable while pending or running.
- Streaming responses update while expanded.
- Failed and interrupted calls expose available output and errors.
- Custom tool views, such as bash, retain their specialized presentation.
- The "expand shell tools" setting controls default expansion only. It must never prevent manual expansion.
- Manual expansion state should survive tool status and output updates.

## Shared UI Design

- Use one shared expandable tool container across generic and specialized tool views.
- The shared container owns disclosure behavior, accessibility, expansion state, and pending/running support.
- It accepts custom argument and response content from specialized renderers.
- It provides a standard arguments-and-response fallback for tools without custom views.
- Specialized renderers may customize presentation but must expose equivalent access to both arguments and responses.
- Expansion policy must be separate from expansion capability. Settings may choose the initial state but cannot disable the control.

## State Expectations

- **Pending:** Arguments are visible; no response is available yet.
- **Running:** Arguments and partial response are visible and update live.
- **Completed:** Final arguments and response are available.
- **Failed:** Arguments and error response are available.
- **Interrupted:** Arguments and any partial response remain available.

## Validation

- Every tool type can be expanded.
- Running shell calls can be expanded when automatic shell expansion is disabled.
- Streaming output does not reset manual expansion state.
- Generic tools display complete arguments and responses.
- Custom views retain their specialized presentation.
- Expansion works with keyboard navigation.
- Large arguments and responses remain usable without disrupting the timeline.

## Non-Goals

- Automatically expanding every tool call.
- Replacing custom tool views with generic JSON.
- Changing tool execution or persistence.
- Requiring a setting before tool details can be inspected.
