# Repository Support Files

## Purpose

Record the repository-level files the fork intentionally removes, adds, or ignores, so a rebase does not restore or delete them by accident.

These are development-workflow changes only. They do not affect application behavior, persistence, or upstream compatibility.

## Removed: `.husky/pre-push`

The upstream pre-push hook ran a Bun version check and a full `bun typecheck` on every push.

- The hook is deleted intentionally, not accidentally lost.
- Pushes from this fork are not gated on a repository-wide typecheck.
- Verification uses the required package build described in `AGENTS.md`, not a repository-wide typecheck or broader test suite.
- A rebase that reintroduces `.husky/pre-push` should delete it again rather than adapt it.
- Other Husky hooks and the Husky dependency are left alone.

## Retained: `.opencode/skills/validate-fork-ui`

`.opencode/skills/validate-fork-ui/SKILL.md` is a fork-owned skill that describes how to build this fork and validate the legacy web UI manually.

- It builds the single-platform binary, serves it on an alternate port, and exercises the UI against the existing configuration and database.
- It exists because most fork features are legacy-web-UI behavior that is verified by observation rather than by an automated suite.
- It must not mutate durable state: no prompts, setting changes, session archival or deletion, and no overriding of `HOME`, config paths, or the database path.
- It stops only the alternate server it started; the regular instance keeps running.
- Use it when validating fork UI changes, and keep it in sync when the build command, expected artifact path, or launch flags change.

## Unchanged: `bun.lock`

The fork does not carry lockfile registry or dependency churn.

- Keep `bun.lock` exactly at `HEAD`.
- Restore it after any build or other command that changes it.

## Ignored: generated test output

Playwright writes run artifacts next to wherever it was invoked, and those artifacts must never be committed.

- The repository root ignores `test-results/` and `playwright-report/`.
- `packages/app/.gitignore` keeps the existing `e2e/test-results` and `e2e/playwright-report` rules for runs started from that package.
- Generated Playwright output remains absent from the worktree.
- A rebase that reintroduces generated run output should delete it and confirm an ignore rule covers the path it appeared at.

## Validation

- No pre-push hook runs on push, and `./packages/opencode/script/build.ts --single` succeeds from the repository root.
- The validation skill builds, serves, and validates the fork UI without touching the regular instance or durable data.
- Broader test suites are not maintained or run for this fork.
- `bun.lock` matches `HEAD`, and no generated test output exists.

## Non-Goals

- Removing Husky itself or other hooks.
- Replacing manual UI validation with a new automated suite.
- Changing upstream Playwright configuration or output paths.
