# Remove Project Editing

## Purpose

Remove project metadata editing from the legacy web UI rather than maintaining a reduced editor.

## Required Behavior

- Project menus do not expose an Edit action.
- The legacy UI does not open the project-editing dialog.
- Project names, icons, colors, and startup commands cannot be edited through the legacy UI.
- Existing project metadata remains readable and unchanged.
- Shared editing components and backend update contracts remain available for upstream and v2 consumers.
- No fork-specific project-editor implementation is maintained.

## Validation

- No legacy project menu contains Edit.
- No normal legacy navigation path opens the project editor.
- Existing metadata remains intact.
- Retained upstream editing components and APIs continue to compile.

## Non-Goals

- Removing project metadata from schemas or persistence.
- Deleting shared project-editing components.
- Changing workspace naming or rename behavior.
- Modifying the v2 UI.
