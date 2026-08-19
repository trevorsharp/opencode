# System Prompt Override

## Purpose

Allow the OpenCode installation to replace the built-in, model-specific base prompt with a single user-owned `SYSTEM.md` file.

This provides one stable system identity across ordinary models without copying it into agent definitions or mixing it with additive repository instructions.

## File Location

- The override path is `${OPENCODE_CONFIG_DIR}/SYSTEM.md`.
- When `OPENCODE_CONFIG_DIR` is unset, this is the normal OpenCode configuration directory, such as `~/.config/opencode/SYSTEM.md` on Linux.
- The fork does not search the working directory, workspace, repository ancestors, `.opencode`, or the user's home directory for another `SYSTEM.md`.
- The file is read when preparing each ordinary provider turn so edits apply to the next turn without restarting OpenCode.

## Required Behavior

- When `SYSTEM.md` does not exist, OpenCode selects the existing built-in prompt for the current model exactly as upstream does.
- When `SYSTEM.md` exists and is readable, its complete text replaces the result of `SystemPrompt.provider(model)`.
- A present empty or whitespace-only file is a valid override and contributes no model-specific base text. Presence, not non-empty content, selects the override.
- OpenCode does not interpret Markdown frontmatter, substitute variables, resolve file references, or otherwise transform the file.
- A read failure is logged and falls back to the built-in model-specific prompt rather than failing the provider turn.
- The override is not persisted in session or database records.

## Prompt Composition

`SYSTEM.md` replaces only the model-specific base-prompt slot. It does not replace the complete system prompt.

The existing precedence for that slot becomes:

1. A custom agent prompt, when the selected agent defines one.
2. The configuration-directory `SYSTEM.md`, when present and readable.
3. The built-in prompt selected for the model.

The selected base text is still composed with the existing additive system content:

- Environment and model metadata.
- Project references.
- Global and repository instructions such as `AGENTS.md`.
- Active MCP instructions.
- Available skill guidance.
- Structured-output guidance when required.
- Per-message user system text.
- Plugin system-prompt transformations.

Their ordering and behavior remain unchanged. In particular, `SYSTEM.md` is not reported as an instruction source and does not participate in nested instruction discovery.

## Runtime Boundary

The override applies wherever the normal request-preparation path currently calls `SystemPrompt.provider(model)`, including ordinary AI SDK requests and workflow-backed models that use that prepared prompt.

External-agent runtimes remain unchanged. They already bypass the built-in model-specific prompt and own their system context, so the Claude CLI external runtime does not read or receive `SYSTEM.md` through this feature.

## Implementation Plan

1. Extend the `SystemPrompt` service in `packages/opencode/src/session/system.ts` with an effectful base-prompt resolver.
2. Resolve `path.join(global.config, "SYSTEM.md")` through `FSUtil.Service`, distinguishing a missing file from a successfully read empty file and from a read failure.
3. Keep the existing pure model-to-built-in-prompt selector as the fallback so upstream model matching remains isolated and unchanged.
4. In the ordinary branch of `LLM.Service`, select the custom agent prompt immediately when one exists; otherwise resolve the system service's base prompt. This preserves agent precedence without unnecessarily reading `SYSTEM.md`.
5. Pass the already selected base text into `LLMRequestPrep.prepare` rather than reading configuration or choosing a fallback in the request adapter.
6. Add `Global.node`, `FSUtil.node`, and `SystemPrompt.node` only to the layers that need them, avoiding database or protocol changes.

This keeps file discovery in the system-prompt service, runtime selection in `LLM.Service`, and final prompt ordering in request preparation.

## Validation

- With no `SYSTEM.md`, representative GPT, Claude, Gemini, and fallback models retain their current built-in base prompts.
- With a populated `SYSTEM.md`, different ordinary models receive the same file content in place of their built-in base prompt.
- Editing the file changes the next provider turn without restarting OpenCode.
- An empty file removes only the base-prompt text; environment, instructions, MCP, skills, and user system text remain present.
- A custom agent prompt wins over the file.
- Removing the file restores model-specific selection on the next turn.
- An unreadable file logs the failure and uses the built-in prompt.
- Claude CLI external-agent turns remain unchanged.
- `./packages/opencode/script/build.ts --single` succeeds from the repository root.
- `bun.lock` remains unchanged.

## Database Compatibility

This feature reads one external configuration file and makes no database schema or persisted-record changes. Upstream OpenCode can continue using the same database before, during, and after the fork uses the override.

## Rebase Policy

Keep the override at the narrow boundary where upstream selects its model-specific base prompt. If upstream restructures prompt assembly, reapply the precedence and composition rules rather than preserving the fork's old call graph.

Drop the fork implementation if upstream adds an equivalent configuration-directory system-prompt override with the same precedence and runtime boundaries.

## Non-Goals

- Project- or workspace-specific `SYSTEM.md` discovery.
- Stacking multiple system override files.
- Replacing `AGENTS.md`, `CLAUDE.md`, configured instructions, agent prompts, or per-message system text.
- Exposing the override through application UI or configuration schema.
- Watching the file or pushing changes into a provider turn already in progress.
- Applying the file to external-agent runtimes.
- Adding database state, migrations, protocol fields, or generated SDK changes.
