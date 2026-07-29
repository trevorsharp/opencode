# Workspace Management

## Purpose

Support named workspaces that group multiple repositories and branches into one navigable unit in the legacy web UI.

Workspaces are managed by the external `workspace` CLI and may contain projects from unrelated repositories.

## Terminology

- **Workspace root:** The directory representing a named workspace.
- **Workspace member:** A repository or checkout attached to that workspace.
- **Source project:** The original repository used to create or attach a member.
- **Workspace inventory:** The authoritative list of roots and members returned by the workspace tooling.

## External Dependency

- The external `workspace` executable is required.
- The server owns all interaction with it.
- The UI never invokes it directly.
- CLI results are normalized behind typed server contracts.
- Missing or incompatible tooling produces an actionable error without corrupting project state.

## Workspace Identity

- A directory containing a workspace marker is recognized as a workspace root.
- The project ID is `workspace:<absolute-workspace-root>`.
- No `feature:` compatibility or reconciliation behavior is included.
- Existing data will be updated manually outside this feature.
- A workspace root does not need to be a Git repository.
- Nested repositories retain their own project identities.
- Opening a member resolves to that member rather than collapsing into the root.
- Sessions remain associated with their actual working directories.

## Authoritative Naming

Workspace names come from the live workspace inventory.

- The UI does not persist an independent workspace name.
- The UI provides no workspace rename control.
- Renames performed outside OpenCode appear after inventory refresh.
- Inventory refresh replaces stale display names.
- Cached project metadata cannot overwrite the authoritative name.
- Names refresh after lifecycle operations.
- Names refresh when the app regains focus or visibility.
- Names refresh periodically while workspace UI is active.
- Names refresh when the server reports relevant changes.
- Restarting OpenCode is not required to observe a rename.

## Creation

All three creation paths are supported:

- Create an empty named workspace.
- Create a named workspace from an ordinary Git project.
- Add a project to an existing workspace.

Creation uses the shared directory picker where a source directory is required.

After creation:

- The server returns the workspace root and created member directory.
- Inventory refreshes immediately.
- The workspace opens in the legacy UI.
- Empty workspaces appear immediately.
- Empty workspaces allow sessions directly on their root.

## Inventory

- The server returns roots and members.
- Member information includes directory, source description, branch, and workspace root.
- Ordinary Git worktrees and workspace-managed members can coexist.
- Directories owned by another workspace root are excluded.
- Repeated inventory requests do not create duplicates.
- Externally removed members disappear after refresh.
- Externally added members appear after refresh.
- Busy members remain visible during active operations.
- Refreshes update existing entries in place.
- Inventory may reconcile existing project sandbox persistence without changing its schema.

## Sidebar Presentation

- Each workspace root appears as one project-level container.
- The authoritative workspace name labels the container.
- Members appear beneath the root.
- Member labels use project or directory names without `local:` or `sandbox:` prefixes.
- Root sessions and member sessions remain distinguishable.
- Sessions are grouped by their actual working directory.
- Working, unseen, and error indicators aggregate across members.
- Empty workspaces remain visible and expose Add project.
- Workspace functionality is always enabled for Git projects and workspace roots.
- The legacy enable/disable-workspaces toggle is omitted.
- The existing fork UI is the behavioral and visual reference.

## URL Workspace Context

The active workspace root must be represented in the URL.

This is required because directory and session routes alone do not reliably identify which workspace container should own a member.

- Member routes include the workspace root as explicit route state.
- The root is encoded safely for use in the URL.
- Sidebar session links preserve the root.
- New-session links preserve the root.
- Submitting the first prompt and transitioning to a persisted session preserves the root.
- Navigating between sessions in the same workspace preserves the root.
- Browser refresh preserves the workspace grouping.
- Directly opening or sharing a member-session URL restores the same workspace context.
- Back and forward navigation preserve the expected workspace container.
- Unrelated query parameters and URL fragments are preserved.
- The root context may be omitted when the active directory is the workspace root itself.
- Generic navigation helpers must not silently discard workspace route state.

This behavior must be tested at every navigation boundary because losing the root from the URL has been a recurring source of workspace bugs.

## Navigation

- Selecting a root opens its root sessions.
- Selecting a member opens sessions for that member directory.
- Starting a member session preserves workspace URL context.
- Creating a new session targets the selected root or member.
- Opening an exact directory does not redirect to another repository root.
- Expanding a workspace loads its sessions without generic project bootstrap duplicating ownership.
- Older asynchronous navigation cannot overwrite a newer manual selection.

## Member Removal

The legacy UI supports removing a project from a workspace.

- The action is available for workspace members.
- It is not presented as deleting the source project.
- Removal is delegated to the external workspace tool.
- The source repository remains intact.
- Unmanaged existing directories are never recursively deleted.
- An already-missing managed directory is treated as removed.
- Member-specific terminal and application state is cleared.
- The removed directory's server instance is disposed.
- The member disappears from sidebar and inventory state.
- Associated session records remain in the database.
- The operation reports whether the workspace root was also removed.

## Automatic Root Removal

When the last member is removed:

- The external workspace tool may remove the workspace root automatically.
- The server returns that outcome explicitly.
- The UI closes and removes the root project.
- Workspace inventory is invalidated and refreshed.
- Navigation leaves the removed root safely.
- Existing session records are not deleted.

This behavior also applies when the last member is removed from a workspace that previously contained root-level sessions.

## Unsupported UI Operations

The legacy workspace UI does not provide:

- Workspace rename.
- Member reset.
- Workspace reset.
- General project editing.
- Workspace enable or disable toggles.

External changes remain visible through inventory refresh.

## Server Boundary

One workspace service owns:

- Marker discovery.
- `workspace:` identity.
- CLI invocation.
- Inventory loading and caching.
- Creation and attachment.
- Listing and reconciliation.
- Member removal.
- Automatic root-removal reporting.
- Instance cleanup.
- Stable error translation.

The application consumes typed creation, listing, removal, and inventory results.

The SDK is generated after those contracts stabilize.

## Persistence Compatibility

- Follow `fork-features/README.md`.
- Introduce no workspace tables, columns, indexes, or migrations.
- Reuse existing project and sandbox records where persistence is needed.
- Keep workspace markers and authoritative state outside the database.
- Keep fork metadata optional.
- Upstream OpenCode can open member directories and read their sessions.
- Opening the database with upstream requires no cleanup or conversion.
- The manual `feature:` to `workspace:` data update is outside this feature.

## Failure Behavior

- CLI failures do not commit successful UI state optimistically.
- Partial inventory failure preserves the last usable view.
- Foreign workspace roots are never removed.
- Unmanaged directories are never recursively deleted.
- Concurrent refreshes cannot replace newer inventory with older results.
- Lifecycle completion invalidates inventory caches.
- Optional branch-cleanup failure does not fail an otherwise successful removal.
- Errors identify the affected workspace or member.

## Validation

- Recognize roots using the `workspace:` identity.
- Create an empty workspace.
- Create a workspace from a Git project.
- Add unrelated repositories.
- Create sessions on an empty root.
- List managed members alongside ordinary worktrees.
- Refresh externally changed workspace names.
- Prevent stale names from returning.
- Navigate root and member sessions.
- Preserve root context through every URL transition.
- Reload and directly open member-session URLs.
- Preserve root context through back and forward navigation.
- Remove a member without deleting its source.
- Automatically remove the root after its last member.
- Reject unsafe unmanaged-directory removal.
- Handle missing directories and foreign roots.
- Reconcile externally added and removed members.
- Verify upstream database compatibility.
- Verify no schema changes are introduced.

## Dependencies

- The external `workspace` executable.
- Existing project, session, worktree, terminal, and instance-lifecycle services.
- Open in VS Code depends on Workspace Management and is implemented afterward.

## Non-Goals

- Replacing the external workspace tool.
- Storing authoritative workspace state in the database.
- Treating a workspace as one Git repository.
- Combining members into one project identity.
- Renaming or resetting workspaces through the UI.
- Editing general project metadata.
- Implementing equivalent v2 workspace UI.
