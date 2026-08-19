# Disable Native Task Tool

## Purpose

Keep OpenCode's built-in `task` implementation out of the model-visible tool catalog without removing its compatibility surfaces.

The core fork does not choose, describe, or depend on a replacement. Plugins own any replacement tool definitions, orchestration behavior, child-session policy, and agent guidance.

## Required Behavior

- The built-in registry may initialize and retain the native tool for internal compatibility, but excludes it from the tool catalog materialized for model requests.
- A model request cannot discover or invoke native subagent delegation by tool name.
- Provider prompts and built-in tool descriptions do not recommend an unavailable delegation tool.
- Open-ended search and truncated-output guidance describe the available file tools without prescribing an external delegation mechanism.
- Agent attachments and command inputs do not synthesize model instructions to call an unavailable tool.
- Disabling model access requires no database schema change or data migration.

## Extension Boundary

- The core runtime remains agnostic about replacement delegation and orchestration.
- Plugins may register their own tools and inject their own model guidance through existing extension points.
- Plugins are responsible for preventing unsupported recursion and for selecting tools available to their child sessions.
- Core prompts must not name or special-case a plugin-provided replacement.
- Core runtime code must not depend on plugin-specific run state, metadata, configuration, or persistence.

## Compatibility

- The native tool implementation, permission schema, command/subtask plumbing, background handling, and child-session support remain available for upstream compatibility.
- Existing agent definitions and public agent configuration remain valid.
- Existing persisted messages and tool parts remain readable without rewriting historical records.
- Existing CLI, TUI, web, and shared UI presentation for historical tool parts remains unchanged.
- Existing generic plugin tool registration and permission behavior remain unchanged.

## Validation

- A model-visible tool catalog contains no native `task` definition.
- Production prompts and built-in tool descriptions contain no instructions to use the hidden tool.
- Direct registry lookup used by model requests cannot materialize the native tool.
- A plugin can register an independent delegation tool without a core dependency or special case.
- Historical sessions remain readable.
- `./packages/opencode/script/build.ts --single` succeeds from the repository root.

## Non-Goals

- Defining a replacement delegation protocol.
- Documenting or configuring any specific orchestration plugin.
- Deleting the native tool implementation or its upstream compatibility surfaces.
- Removing agents, agent configuration, or child-session support.
- Changing the database schema or rewriting historical session data.
