---
name: validate-fork-ui
description: Build and manually validate this OpenCode fork's web UI on an alternate port with the existing database and configuration. Use when testing fork changes without disrupting the regular OpenCode instance.
---

# Validate Fork UI

Use a browser-capable workflow agent to perform the investigation, launch, and Chrome DevTools checks. The regular OpenCode instance must remain running and untouched.

## Safety

- Do not stop, restart, or reconfigure the regular instance.
- Do not override `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `OPENCODE_CONFIG`, or the database path. This ensures the fork uses the existing config and database.
- Use `127.0.0.1` and an unused alternate port, normally `4097` when the regular instance uses `4096`.
- Treat the shared database as live data. Do not submit prompts, change settings, archive or delete sessions, or perform other durable mutations.
- Record the alternate server PID and stop only that PID after validation.

## Build

From the repository root, build the single-platform binary:

```bash
./packages/opencode/script/build.ts --single
```

The expected binary in this environment is:

```text
packages/opencode/dist/opencode-linux-arm64/bin/opencode
```

Use the actual artifact produced by the build if the platform differs.

## Launch

First confirm the selected port is unused:

```bash
lsof -nP -iTCP:4097 -sTCP:LISTEN
```

Launch `serve`, not `web`, because `web` attempts to open a system browser:

```bash
nohup env OPENCODE_FORK=1 OPENCODE_DISABLE_CHANNEL_DB=1 \
  ./packages/opencode/dist/opencode-linux-arm64/bin/opencode \
  serve --hostname 127.0.0.1 --port 4097 \
  >/tmp/opencode-fork-web-4097.log 2>&1 </dev/null &
```

Immediately record `$!` as the alternate server PID. Verify the listener and inspect the log before browser testing. If startup reports a database lock, diagnose it without stopping the regular instance or copying the database; SQLite WAL should support these concurrent processes.

## Browser Validation

Open `http://127.0.0.1:4097` with Chrome DevTools. Follow redirects rather than constructing a project URL manually.

Check all of the following without durable mutations:

1. The application loads at a desktop viewport.
2. Existing projects and session history appear, providing evidence that the shared database is in use.
3. An existing session opens read-only and renders its timeline and composer.
4. Settings show expected persisted configuration, model, and theme values.
5. The application remains usable at a mobile viewport such as `390x844`.
6. The browser console contains no unexpected errors.
7. Network requests contain no unexpected non-2xx responses.
8. The server log contains no startup, database, or request failures.

Report the build command and result, launch command, port, PID, evidence that config and database are shared, browser outcomes, console and network failures, server-log failures, and cleanup command.

## Cleanup

Stop only the recorded alternate PID:

```bash
kill <pid>
```

Confirm the alternate port no longer has a listener:

```bash
lsof -nP -iTCP:4097 -sTCP:LISTEN
```

If the user explicitly asks to keep the validation server running, report its PID, port, log path, and cleanup command instead of stopping it.
