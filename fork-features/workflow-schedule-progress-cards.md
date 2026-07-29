# Workflow and Schedule Progress Cards

## Purpose

Display live progress for externally orchestrated workflows and scheduled jobs in the legacy session timeline.

Workflow and schedule cards share the same visual language and interaction model.

## Reference Behavior

Use the existing fork implementation as the canonical reference for:

- Layout and styling.
- Workflow phases and schedule stages.
- Status presentation.
- Agent and model labels.
- Child-session navigation.
- Schedule dates.
- Live progress updates.
- Working-state indicators.
- Cancellation behavior.
- Mouse and keyboard interactions.

Reimplementation may change internal structure but should preserve the existing user experience.

## Required Behavior

- Workflow and schedule cards remain visually aligned.
- Cards update in place as work progresses.
- Their latest state survives reloads and reconnects.
- Child agents link to their sessions.
- Agent model and variant labels remain visible.
- Active cards and descendants contribute to parent working state.
- Cancellation eventually produces a terminal card state.
- Card state never enters model context or causes prompt continuation.
- Card-update failures do not fail the underlying work.
- Equivalent v2 UI support is not required.

## Persistence Constraints

- Follow `fork-features/README.md`.
- Introduce no database schema changes or migrations.
- Reuse upstream-compatible session records and optional metadata.
- Keep fork metadata optional and safe for upstream to ignore.
- External execution state may remain in feature-owned storage.
- Cards are durable UI projections, not authoritative execution records.

## Implementation Guidance

- Prefer the simplest maintainable implementation that reproduces the reference behavior.
- Stable card identity must allow updates to target the same card.
- Validate that updates and cancellations target the correct session.
- The UI submits cancellation intent rather than directly terminating external processes.
- External producers own execution and report terminal state.
- Internal APIs and component structure may change without affecting documented behavior.

## Validation

- Compare workflow and schedule cards with the existing fork behavior.
- Verify supported statuses and transitions.
- Verify model labels and child-session navigation.
- Verify live updates and reload persistence.
- Verify cancellation through terminal settlement.
- Verify UI-only records are excluded from model context and continuation.
- Verify parent working state includes active cards and descendants.
- Verify upstream can use the same database.
- Verify no schema or migration changes are introduced.

## Non-Goals

- Executing workflows or schedules in the UI.
- Making OpenCode storage authoritative for external execution.
- Reimplementing cards for v2.
- Prescribing the current internal implementation.
