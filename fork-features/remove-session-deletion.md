# Remove Session Deletion

## Purpose

Remove session deletion from the legacy web UI while keeping Archive available as the destructive session action.

Only the menu entry point is removed. The upstream deletion implementation and backend contracts remain in place so this fork does not maintain a reduced session lifecycle.

## Required Behavior

- Session header menus do not expose a Delete action.
- Archive appears below the divider that separates ordinary actions from the destructive session action.
- Both legacy and v2 menu variants follow the same ordering.
- Session deletion remains available to upstream code and APIs outside this legacy UI entry point.
- No session data or persistence contracts change.

## Validation

- No session header menu contains Delete.
- Archive is the only session action below the divider.
- Archive behavior remains unchanged.
- Retained upstream deletion code and APIs continue to compile.
- Removing this feature restores the upstream Delete entry point without reimplementing deletion.

## Non-Goals

- Removing session deletion APIs or backend behavior.
- Changing archive behavior or persistence.
- Removing delete actions for files, comments, workspaces, or other resources.
- Modifying the TUI.
