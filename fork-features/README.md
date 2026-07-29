# Fork Features

This directory documents intentional functionality maintained by the OpenCode fork. Each feature should be independently implementable and testable, with explicit behavior, boundaries, dependencies, and validation requirements.

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
- Retain upstream implementations that are outside a feature's documented scope.
