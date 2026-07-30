# Glob Directory Guidance

## Purpose

Tell models explicitly that the glob tool matches files only, so they stop using it to list folders or to check whether a directory exists.

Without this, a glob pattern aimed at a directory returns an empty result, which reads as "the directory is missing" and leads to redundant searches or wrong conclusions.

## Required Behavior

- The glob tool description states that it does not return directories.
- It points at the read tool on the parent directory as the way to list folders or confirm a folder exists.
- Both tool surfaces carry the clarification: the core tool description (`packages/core/src/tool/glob.ts`) and the legacy tool prompt (`packages/opencode/src/tool/glob.txt`).
- Wording is additive. Existing guidance about patterns, relative paths, result limits, and batching is unchanged.
- Glob matching, filtering, output shape, and result limits are unchanged.

## Shared Design

- This is a prompt-only clarification of behavior upstream already has. It must not become a behavior change that starts returning directories.
- Keep the two surfaces consistent; updating one without the other reintroduces the confusion on the other runtime.

## Validation

- Both glob descriptions mention that directories are not returned and name the read-on-parent alternative.
- Glob results are identical to upstream for the same patterns.
- A directory-shaped pattern still returns no entries, and the description explains why.

## Rebase Policy

Drop this change if upstream adopts equivalent wording. If upstream rewrites either description, reapply only the missing clarification rather than restoring the fork's full sentence.

## Non-Goals

- Making glob return directories or a directory-listing mode.
- Changing glob inputs, outputs, or limits.
- Editing unrelated tool descriptions.
