# Remove Slash Commands

## Purpose

Remove slash-command discovery and invocation from the legacy web composer so prompts beginning with `/` remain ordinary user text.

## Required Behavior

- Typing `/` does not open a slash-command popover.
- Built-in, custom, MCP, and skill commands do not appear as slash suggestions.
- Submitting text that begins with `/` sends that text as a normal prompt.
- Command-palette actions and keyboard shortcuts remain available.
- Skills remain available through agent tool use and through the Claude CLI runtime's native skill discovery.

## Fork Boundary

- This feature changes only the legacy web composer.
- The upstream command registry, command API, TUI, and retained v2 UI remain unchanged.
- Slash-command implementation stays present but unreachable from the legacy composer so upstream changes remain easy to rebase.
- No configuration flag or database change controls this behavior.

## Validation

- Typing `/` in the legacy composer does not open a popover.
- Submitting `/init`, `/review`, a configured custom command, an MCP prompt, or a skill name creates a normal user prompt containing the original text.
- Command-palette actions and their keyboard shortcuts still work.
- Agent skill discovery and invocation still work.
- `./packages/opencode/script/build.ts --single` succeeds from the repository root.

## Non-Goals

- Removing command definitions from the backend.
- Removing or changing the command API.
- Changing TUI or v2 slash-command behavior.
- Removing command-palette actions or keyboard shortcuts.
