# Conditional Reliability and Performance Fixes

## Purpose

Collect fork changes that correct bugs, race conditions, stale state, unnecessary work, or degraded platform behavior.

These fixes are not durable fork product features. Each fix should be evaluated independently during rebasing and dropped when upstream has addressed the underlying problem.

Grouping them here is organizational only; they do not form one implementation dependency.

## Rebase Policy

For each fix:

1. Reproduce the original problem against the rebased upstream branch.
2. Check whether upstream now provides equivalent behavior.
3. Drop the fork change if the problem is no longer reproducible.
4. Reimplement only the smallest remaining correction.
5. Prefer the upstream implementation when behavior is equivalent.
6. Follow the database compatibility rules in `fork-features/README.md`.

## Project Navigation Races

### Problem

Asynchronous project admission can complete after the user has manually navigated elsewhere, replacing the newer selection.

### Expected Behavior

- Only the latest admission request may complete navigation.
- Manual project or session navigation cancels pending admission.
- Every asynchronous boundary verifies that its request is still current.
- Pending projects remain visible while admission is active.
- Delayed session loading cannot overwrite a newer route.
- New-session focus waits until the prompt is ready.
- Focus callbacks recheck that the user is still on the same route.

Workspace-root URL preservation remains part of Workspace Management rather than this fix.

## Project Synchronization Correctness

### Problem

Project lists and events can arrive out of order, overwrite newer state, lose concurrent additions, or apply metadata from the wrong directory.

### Expected Behavior

- Stale project updates are ignored.
- Incoming lists retain newer local records.
- Projects added concurrently with a list request are preserved.
- Projects are deduplicated by canonical worktree identity.
- Metadata is applied only when its worktree matches the local project.
- Subdirectory projects do not inherit parent repository metadata.
- Global project enrichment uses only appropriate global metadata.
- Opening a directory explicitly refreshes the project list.
- Newly opened projects retain stable ordering.

## Bootstrap Query Caching

### Problem

Repeated directory bootstrap performs unnecessary provider and agent requests.

### Expected Behavior

- Provider and agent bootstrap data use the shared query cache.
- Repeated bootstrap within the freshness window reuses cached data.
- Concurrent requests share the same in-flight query.
- Expired data is refreshed normally.
- Different server scopes do not share incompatible cache entries.
- Explicit invalidation still forces refresh.

The current fork's cache duration is the behavioral reference, but the exact duration may follow an equivalent upstream policy.

## MCP Synchronization Reliability

### Problem

MCP authentication and resource state can become stale or require the wrong reconnect path.

### Expected Behavior

- Toggling a server that requires authentication uses the normal connection path.
- Initial bootstrap loads MCP status and resources.
- MCP tool-change events refresh status and resource data.
- Reconnects update the UI without requiring a page reload.
- Status controls continue using shared MCP connection logic.
- Missing-client-registration state has readable fallback text.

The MCP-only status popover remains a separate intentional UI feature.

## Session List and Timeline Hygiene

### Problem

Unloaded session state can be confused with a loaded empty list, and generated placeholder records can clutter the UI.

### Expected Behavior

- Loaded-empty and not-yet-loaded session lists are distinct states.
- Generated empty sessions are hidden after loading.
- A generated session remains visible while it is working.
- Sessions with usage or meaningful content remain visible.
- Synthetic-only timeline rows are hidden when they have no user-visible content.
- Comments or meaningful content prevent a synthetic row from being hidden.
- Filtering does not remove active workflow or external-agent state.

## Session Provider Lifecycle

### Problem

Session-scoped providers can retain stale state across session changes, while remounting the entire tree can destroy active terminals.

### Expected Behavior

- Session-scoped providers remount when the session ID changes.
- Every session route transition renders the active route's session and provider state.
- State from one session does not leak into another.
- Terminal state remains outside the remounted session subtree.
- Switching sessions does not destroy active PTYs.
- Returning to a session reconstructs its session-scoped providers from current data.
- Workspace and server ownership remain keyed independently of the session ID.
- Async session work verifies route ownership before applying delayed results.
- Initial model synchronization waits for destination history restoration.
- An explicit per-session Default variant does not fall through to another session's model-level variant.

## Terminal Creation Selection and Focus

### Problem

The terminal tab strip is a controlled tabs root that coerces its selection back to the first
registered trigger when the controlled value names a key its collection has not seen yet. Registering
a new terminal in the same update that activates it loses that race, so a newly created terminal can
lose selection. Separately, focus was reasserted on timers and applied whenever the panel was open,
rather than only when focus was actually requested.

### Expected Behavior

- A newly created terminal is registered before it is activated.
- Each newly created terminal stays selected across repeated creations.
- Focus is applied in response to an explicit focus request, not to the panel merely being open.
- Focus does not rely on retry timers or animation-frame reattempts.
- Recreating a terminal preserves the active selection when the replaced terminal was active.

## Structured-Output Retry Reliability

### Problem

A model can receive a structured-output schema but complete without invoking the required output tool.

### Expected Behavior

- Missing structured output produces a durable retry instruction.
- Retries are bounded.
- The default retry count remains explicit and testable.
- Successful output on a later attempt completes normally.
- Exhaustion records the actual number of attempts.
- Retry messages remain valid persisted history.
- Plain persisted output-format values remain schema-encodable.
- Normal non-structured turns are unaffected.

This fix should be dropped if upstream provides equivalent bounded retries.

## Cross-Origin Link Handling

### Problem

Links to external origins can be handled as internal application navigation or opened without appropriate browser isolation.

### Expected Behavior

- Cross-origin links use the platform's external-link behavior.
- Same-origin links remain normal application navigation.
- Modified clicks and prevented events retain standard browser behavior.
- New browser contexts use `noopener` and `noreferrer`.
- Link interception does not affect non-anchor interactions.
- The behavior is applied consistently before nested handlers interfere.

## PWA Viewport Correction

### Problem

Installed PWAs can be obscured or shifted incorrectly when the visual viewport changes, especially with mobile keyboards and safe areas.

### Expected Behavior

- The application preserves its full layout height when the mobile keyboard shrinks the visual viewport.
- The visual viewport scrolls over the full layout to keep focused controls visible instead of collapsing the layout.
- The legacy terminal panel derives its maximum height from the full application layout rather than the keyboard-height viewport.
- Focusing the legacy terminal scrolls its visible panel above the mobile keyboard as the keyboard opens.
- Resize, scroll, and focus changes update the layout immediately and again after viewport changes settle.
- Dismissing the mobile keyboard restores the application to its original screen position.
- Safe-area insets are respected.
- Browser-tab behavior remains unchanged when PWA-specific handling is unnecessary.
- Event listeners are cleaned up when the layout unmounts.

## Responsive Sidebar Mounting

### Problem

Mounting desktop and mobile sidebars simultaneously performs duplicate work and can preserve hidden state unexpectedly.

### Expected Behavior

- Only the sidebar appropriate for the active media query is mounted.
- Crossing the breakpoint replaces one sidebar with the other.
- Hidden duplicate sidebar trees do not remain active.
- Session loading and subscriptions are not duplicated.
- Mobile and desktop navigation retain equivalent behavior.
- Sidebar state remains coherent across breakpoint changes.

## Validation Strategy

Each fix should have a focused regression scenario demonstrating:

- The original failure.
- Correct fork behavior.
- Current upstream behavior.
- Whether the fork change remains necessary.

The combined verification should also confirm:

- No database schema changes are introduced.
- Existing upstream data remains usable.
- Fixes can be removed independently.
- Removing one resolved fix does not disable another.
- Product features do not depend on incidental bug-fix implementations.

## Non-Goals

- Preserving a fork fix after upstream has solved the same problem.
- Maintaining identical implementation details when upstream behavior is equivalent.
- Using this group for intentional product or UI policy.
- Coupling otherwise independent fixes through shared fork-only state.
