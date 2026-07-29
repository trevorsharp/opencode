# MCP-Only Status Popover

## Purpose

Make the legacy status popover a focused view of MCP server state.

## Required Behavior

- The status popover exposes only MCP status and controls.
- Server, LSP, and plugin tabs are omitted.
- No server-management, language-server, or plugin information appears.
- MCP connection states remain visible.
- MCP servers can still be enabled, disabled, or reconnected through the existing controls.
- The MCP count remains visible when connected servers exist.
- Underlying server, LSP, and plugin functionality remains unchanged.
- The change applies only to the legacy web UI.

## Shared Design

- Reuse the existing MCP status content and toggle behavior.
- Do not duplicate MCP synchronization or connection logic in the popover.
- Retain shared status components used elsewhere.
- Remove only the non-MCP legacy popover surfaces.

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
