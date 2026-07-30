# Fork Features

This directory documents intentional functionality maintained by the OpenCode fork. Each feature should be independently implementable and verifiable, with explicit behavior, boundaries, dependencies, and validation requirements.

## Database Compatibility

All fork features must be implemented without database schema changes.

- Do not add fork-specific tables, columns, indexes, migrations, or constraints.
- Do not change the meaning or required shape of existing persisted records.
- Do not require the database to be migrated before or after switching between the fork and upstream OpenCode.
- Persist fork state only through storage mechanisms already supported by upstream, such as existing session messages, parts, optional metadata, configuration, or external files.
- Keep fork-specific metadata optional and safe for upstream OpenCode to ignore.
- Preserve compatibility with existing upstream records that do not contain fork metadata.
- Do not make upstream data unreadable or unusable after it has been opened by the fork.
- Prefer external feature-owned storage when state does not naturally fit an existing upstream record.

An upstream OpenCode build must be able to use the same database after the fork has written to it. It may ignore fork-only optional metadata, but it must not require repair, migration, or cleanup.

## Implementation Boundaries

- Keep fork changes small, isolated, and easy to reapply after rebasing.
- Reuse upstream public contracts and extension points where practical.
- Avoid coupling independent fork features through shared fork-only state.
- Keep fork UI behavior in the legacy web UI unless a feature document explicitly states otherwise.
- Keep fork-only UI text as minimal hardcoded English at production call sites rather than extending upstream locale catalogs.
- Retain upstream implementations that are outside a feature's documented scope.

When a fork feature removes access to an upstream surface, hide the entry points and leave the upstream implementation in place. `remove-project-editing.md` and `mcp-only-status-popover.md` are the reference examples: the project editor and the non-MCP status tabs still exist upstream and still compile; only the paths that reach them are gone.

Workspace support uses `workspace:<absolute-workspace-root>` identities and requires a one-time manual update for records written with the earlier identity. It does not add automatic migration or fallback behavior. Workspace work does not change project rename or Edit Project dialog internals. Copy Path entry points are intentionally absent from the fork UI.

## Verification

This fork uses build-only repository verification.

- Package builds are required. The repository gate is `./packages/opencode/script/build.ts --single` from the repository root after every code change.
- Broader test suites are not maintained or run for fork changes.
- Upstream tests, specs, E2E files, locale catalogs, and event-manifest specs remain exactly upstream; do not adapt, skip, replace, or delete them for fork behavior.
- Do not add fork-owned tests or test-only helpers.
- Keep `bun.lock` exactly at `HEAD`, including after build commands.
- Keep generated test output ignored and absent.

## Repository Support Files

`repository-support-files.md` documents the repository-level workflow changes: the intentional deletion of `.husky/pre-push`, the retained `.opencode/skills/validate-fork-ui` skill used to build and manually validate the legacy web UI, and the ignore rules for generated Playwright output. Check it after rebasing, because these files are easy to restore or lose by accident.

## Agent Tool Guidance

`glob-directory-guidance.md` documents the fork's prompt-only clarification that the glob tool does not return directories. Tool-guidance changes may only clarify existing behavior; they must not change what a tool does.
