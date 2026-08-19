# MCP-Only Status Popover

## Purpose

Make the legacy status popover a focused view of MCP server state.

The only change is which tabs the popover renders. The MCP tab keeps its upstream content and behavior, and nothing outside the popover is affected.

## Required Behavior

- The status popover exposes only MCP status and controls.
- Server, LSP, and plugin tabs are omitted from the popover.
- No server-management, language-server, or plugin information appears in the popover.
- MCP tab content, layout, and controls remain as upstream provides them.
- MCP connection states remain visible.
- MCP servers can still be enabled, disabled, or reconnected through the existing controls.
- The MCP count remains visible when connected servers exist.
- Underlying server, LSP, and plugin functionality remains unchanged.
- The change applies only to the legacy web UI.
- Fork builds select this policy at the legacy caller; shared and v2 callers retain upstream tab behavior.

## Shared Design

- Reuse the existing MCP status content and toggle behavior.
- Do not duplicate MCP synchronization or connection logic in the popover.
- Retain shared status components used elsewhere.
- Remove only the non-MCP legacy popover tabs. Do not restyle, reorganize, or reimplement the MCP tab.
- Keep shared helper functions and MCP row markup and interaction behavior unchanged from upstream.
- Server, LSP, and plugin surfaces reached from anywhere else keep working; this feature hides tabs, it does not remove capabilities.

## Validation

- Opening the status popover shows only MCP information.
- No Servers, LSP, or Plugins tabs are rendered.
- MCP state and counts remain accurate.
- MCP controls continue to work.
- Server, LSP, and plugin behavior elsewhere remains unaffected.

## Non-Goals

- Removing server, LSP, or plugin functionality.
- Changing MCP authentication or synchronization.
- Deleting shared status components.
- Modifying the v2 UI.
