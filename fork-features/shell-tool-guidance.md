# Shell Tool Guidance

## Purpose

Keep the shell tool prompt focused on accurate terminal execution mechanics without duplicating agent, user, or project workflow policy.

The upstream prompt mixed shell syntax with hardcoded file-tool names and GitHub workflow instructions. Those assumptions can conflict with the tools available in a session and with repository-specific commands for GitHub, Azure DevOps, or other version-control workflows.

## Required Behavior

- The rendered prompt identifies the configured operating system, shell, exposed tool name, working-directory behavior, temporary directory, timeout, and output limits.
- Shell-specific guidance covers quoting, dependent command chaining, independent command concurrency, and use of the `workdir` parameter for Bash, PowerShell 7+, Windows PowerShell 5.1, and cmd.exe.
- The prompt recommends dedicated filesystem tools by capability without assuming tool names such as Read, Grep, Edit, Write, or Glob are available.
- The prompt contains no Git commit, push, pull-request, GitHub CLI, or other version-control workflow policy.
- User, agent, and project instructions remain responsible for selecting workflow commands and tools such as `gh`, `pr`, or Azure DevOps tooling.
- Shell execution behavior, permissions, inputs, output capture, and truncation remain unchanged.

## Design

- `packages/opencode/src/tool/shell/shell.txt` contains only shared shell capability and execution guidance.
- `packages/opencode/src/tool/shell/prompt.ts` renders concise syntax guidance for each supported shell profile.
- The exposed tool ID is rendered from `ShellID.ToolID` instead of being described inconsistently as Bash or Shell.
- Profile data exists only when referenced by the shared template; do not retain dormant Git or pull-request examples.

## Validation

- Render Bash, PowerShell 7+, Windows PowerShell 5.1, and cmd.exe descriptions and confirm no template placeholders remain.
- Confirm each profile describes valid command chaining for that shell.
- Confirm the rendered descriptions contain no hardcoded dedicated tool names or version-control workflow instructions.
- Run `./packages/opencode/script/build.ts --single` from the repository root.

## Rebase Policy

Drop this change if upstream scopes the shell prompt to equivalent execution-only guidance. If upstream changes shell execution behavior or adds another shell profile, preserve its accurate mechanics while keeping workflow policy out of the tool description.

## Non-Goals

- Defining general Git safety or pull-request workflows.
- Selecting between GitHub, Azure DevOps, or repository-specific workflow tools.
- Renaming the compatibility-preserved `bash` tool ID.
- Changing shell execution, permissions, persistence, or output handling.
