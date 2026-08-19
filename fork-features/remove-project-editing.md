# Remove Project Editing

## Purpose

Hide access to project metadata editing in the legacy web UI while leaving the upstream editor implementation in place.

Only access is removed. The Edit Project dialog, its supporting components, and its update contracts stay exactly as upstream ships them, so the fork never maintains a reduced or forked editor.

## Required Behavior

- Project menus do not expose an Edit action.
- The legacy UI does not open the project-editing dialog.
- Project names, icons, colors, and startup commands cannot be edited through the legacy UI.
- Existing project metadata remains readable and unchanged.
- The upstream Edit Project dialog and its shared components are retained unmodified.
- Project rename behavior outside the hidden legacy Edit entry point remains unchanged.
- Copy Path entry points are hidden in the app and TUI.
- Shared editing components and backend update contracts remain available for upstream and v2 consumers.
- No fork-specific project-editor implementation is maintained.

## Validation

- No legacy project menu contains Edit.
- No normal legacy navigation path opens the project editor.
- Existing metadata remains intact.
- Retained upstream editing components and APIs continue to compile.
- Removing this feature restores the upstream editor without reimplementing it.

## Non-Goals

- Removing project metadata from schemas or persistence.
- Deleting shared project-editing components.
- Changing project rename behavior.
- Modifying the v2 UI.
