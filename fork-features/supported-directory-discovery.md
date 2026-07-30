# Supported Directory Discovery

## Purpose

Keep empty and untyped directory-picker searches focused on the home directories used by this fork, while ensuring those directories remain available in filtered searches.

This is intentional product behavior rather than a generic filesystem fallback or a temporary reliability fix.

## Configuration

The feature-owned configuration lives in `packages/opencode/src/server/supported-directory-discovery.ts`.

The configured roots are:

- `~/Downloads`
- `~/opencode`
- `~/projects`

The configured one-level expansion roots are:

- `~/projects`
- `~/workspaces`

Direct child directories of each expansion root are included. `~/projects` itself is included because it is also a configured root; `~/workspaces` itself is not included.

## Required Behavior

- Supported-directory discovery is combined with primary directory search results.
- Supported directories are ordered before primary results so the configured options are not displaced by the result limit.
- Empty untyped searches behave like directory searches.
- Only configured roots and direct child directories of expansion roots are returned.
- Missing or unreadable configured directories are ignored.
- Files and deeper descendants are excluded.
- Empty-query ordering is stable: configured roots first, followed by sorted children in expansion-root order.
- Non-empty queries use fuzzy ranking.
- Results retain the existing file API response contract.

## Boundaries

- The policy is server-owned so local and remote clients see directories from the server host.
- The generic filesystem service remains location-scoped and policy-free.
- The UI does not duplicate the supported-directory list.
- Explicit paths entered by the user continue to use normal directory navigation and are not restricted to this list.

## Validation

- Empty discovery includes existing configured roots.
- Discovery includes direct children of `~/projects` and `~/workspaces`.
- Discovery excludes files and grandchildren.
- Missing roots do not fail the picker.
- Fuzzy queries rank only supported directories.
- Filtered picker searches include matching supported directories even when primary search also returns results.
- Explicit path navigation continues to work outside the supported list.

## Non-Goals

- Restricting which directories can be opened explicitly.
- Recursively scanning project or workspace trees.
- Reading the directory list from the database or user configuration.
- Preserving generic two-level fallback discovery from upstream or earlier fork revisions.
