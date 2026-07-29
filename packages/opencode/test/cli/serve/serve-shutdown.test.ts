// Shutdown-lifecycle tests for `opencode serve`. These cover the one link that
// used to be missing: `serve` parked on `Effect.never` and registered no signal
// handler, so Node's default SIGTERM disposition killed the process before any
// scope closed. Nothing disposed instances, so a running turn was never settled
// and the detached process group of an external agent CLI reparented to PID 1.
//
// The fake `claude` here is deliberately the shape that leaks: it emits one
// stream-json event and then goes permanently silent. A chatty CLI dies on its
// own once opencode's stdout pipe closes, which would mask a regression; a
// silent one does not. It also never emits a `result` event, so the turn cannot
// settle by itself, and the adapter's idle timeout (5 minutes) is far outside
// the test window.
import { describe, expect } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { cliIt, type CliFixture } from "../../lib/cli-process"
import { pollWithTimeout } from "../../lib/effect"

const MODEL = { providerID: "claude-cli", modelID: "claude-opus-5" }

type Pids = { readonly pid: number; readonly child: number }

/** True while the process group still has at least one member. */
function groupAlive(pgid: number) {
  return alive(-pgid)
}

/** True while the individual process is still around. */
function processAlive(pid: number) {
  return alive(pid)
}

function alive(target: number) {
  try {
    process.kill(target, 0)
    return true
  } catch (err) {
    // ESRCH means gone. EPERM would mean it exists under another uid, which
    // can't happen for something we spawned ourselves.
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * Installs a fake `claude` on PATH that records its own pid plus a grandchild's,
 * emits a single assistant event, and then sleeps forever without speaking.
 *
 * The grandchild is what makes this a group test rather than a child test: it
 * shares the detached process group but is never known to opencode, so it only
 * dies if the whole group is signalled.
 */
const fakeClaude = Effect.fn("fakeClaude")(function* (home: string) {
  const bin = path.join(home, "bin")
  const pidFile = path.join(home, "claude.pid.json")
  yield* Effect.sync(() => {
    mkdirSync(bin, { recursive: true })
    const script = [
      "#!/usr/bin/env bun",
      `const fs = require("node:fs")`,
      `const { spawn } = require("node:child_process")`,
      `const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })`,
      `const event = { type: "assistant", message: { id: "msg_1", content: [{ type: "text", text: "working" }] } }`,
      `process.stdout.write(JSON.stringify(event) + "\\n")`,
      `fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ pid: process.pid, child: child.pid }))`,
      `setInterval(() => {}, 1000)`,
    ].join("\n")
    writeFileSync(path.join(bin, "claude"), script, { mode: 0o755 })
  })

  // Killing the recorded group in a finalizer keeps a failing assertion from
  // leaking a forever-sleeping process into the test host.
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      const pids = readPids(pidFile)
      if (!pids) return
      // Group first, then the grandchild by pid in case the group leader is
      // already gone and only its child is left behind.
      for (const target of [-pids.pid, pids.child]) {
        try {
          process.kill(target, "SIGKILL")
        } catch {}
      }
    }),
  )

  return {
    pidFile,
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      // Claude CLI models are only offered when the executable is on PATH and
      // the CLI looks authenticated.
      ANTHROPIC_API_KEY: "fake-key-for-availability-check",
      // The test preload puts the suite on an in-memory database, which the
      // subprocess would inherit — nothing would survive the restart these
      // tests read through. Point it at a file inside the sandbox instead so
      // both servers share one database, and the live one is never touched.
      OPENCODE_DB: path.join(home, "opencode.db"),
    },
  }
})

function readPids(pidFile: string): Pids | undefined {
  try {
    const parsed = JSON.parse(readFileSync(pidFile, "utf8")) as Pids
    return typeof parsed.pid === "number" && typeof parsed.child === "number" ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * The assistant message as a freshly started server reports it. Reading it back
 * through a restarted server — rather than poking at the sandbox database —
 * asserts the property that actually matters: what an operator sees after the
 * server comes back.
 */
const assistantAfterRestart = Effect.fn("assistantAfterRestart")(function* (input: {
  opencode: CliFixture["opencode"]
  home: string
  env: Record<string, string>
  sessionID: string
}) {
  const server = yield* input.opencode.serve({ env: input.env })
  const response = yield* HttpClientRequest.get(`${server.url}/session/${input.sessionID}/message`).pipe(
    HttpClientRequest.setHeader("x-opencode-directory", input.home),
    HttpClient.execute,
  )
  expect(response.status).toBe(200)
  const messages = (yield* response.json) as Array<{ info: Record<string, any> }>
  return messages.map((message) => message.info).find((info) => info.role === "assistant")
})

/**
 * Creates a session, starts a claude-cli turn, and returns once the fake CLI has
 * recorded its pids — i.e. the process group exists and the turn is running.
 */
const startExternalTurn = Effect.fn("startExternalTurn")(function* (input: {
  url: string
  home: string
  pidFile: string
}) {
  const post = (url: string, body: object) =>
    HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeader("x-opencode-directory", input.home),
      HttpClientRequest.bodyJson(body),
      Effect.flatMap(HttpClient.execute),
    )

  const created = yield* post(`${input.url}/session`, { title: "shutdown" })
  expect(created.status).toBe(200)
  const session = (yield* created.json) as { id: string }

  // prompt_async returns as soon as the turn is accepted, so the test can drive
  // shutdown while the turn is still in flight.
  const accepted = yield* post(`${input.url}/session/${session.id}/prompt_async`, {
    model: MODEL,
    parts: [{ type: "text", text: "hello" }],
  })
  expect(accepted.status).toBeLessThan(300)

  const pids = yield* pollWithTimeout(
    Effect.sync(() => readPids(input.pidFile)),
    "fake claude never recorded its pids",
    "30 seconds",
  )
  return { sessionID: session.id, pids }
})

describe("opencode serve shutdown", () => {
  // The graceful path: SIGTERM must dispose instances, which cancels the running
  // session. That settles and persists the turn and closes the scope owning the
  // CLI, whose release signals the whole detached group.
  cliIt.live(
    "SIGTERM settles the running turn and kills the external process group",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        const fake = yield* fakeClaude(home)
        const server = yield* opencode.serve({ env: fake.env })
        const { sessionID, pids } = yield* startExternalTurn({ url: server.url, home, pidFile: fake.pidFile })

        expect(groupAlive(pids.pid)).toBe(true)

        server.kill()

        // Shutdown must actually complete — this is the liveness bound on the
        // grace window, not just an eventual-exit assertion.
        const code = yield* Effect.promise(() => server.exited).pipe(
          Effect.timeoutOrElse({
            duration: "30 seconds",
            orElse: () => Effect.fail(new Error("serve did not exit after SIGTERM")),
          }),
        )
        expect(typeof code === "number" || code === null).toBe(true)

        // Checked by syscall rather than by parsing `ps`. kill(-pgid, 0) keeps
        // succeeding while any member survives, so this covers the grandchild
        // opencode never knew about; it is asserted separately by pid because
        // it is a group member, not a group leader of its own.
        yield* pollWithTimeout(
          Effect.sync(() => (groupAlive(pids.pid) ? undefined : true)),
          "external process group survived SIGTERM",
          "20 seconds",
        )
        expect(processAlive(pids.child)).toBe(false)

        // Same settled shape `session.abort` produces: completed timestamp plus
        // an aborted error, so a restarted server shows a finished turn.
        const message = yield* assistantAfterRestart({ opencode, home, env: fake.env, sessionID })
        expect(message?.time?.completed).toBeGreaterThan(0)
        expect(message?.error).toBeDefined()
        expect(message?.error?.name).toBe("MessageAbortedError")
      }),
    120_000,
  )

  // Ctrl-C takes the same path as SIGTERM. Without this, deleting the SIGINT
  // registration would leave the interactive case silently leaking.
  cliIt.live(
    "SIGINT takes the same graceful path as SIGTERM",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        const fake = yield* fakeClaude(home)
        const server = yield* opencode.serve({ env: fake.env })
        const { pids } = yield* startExternalTurn({ url: server.url, home, pidFile: fake.pidFile })

        expect(groupAlive(pids.pid)).toBe(true)

        server.kill("SIGINT")

        yield* Effect.promise(() => server.exited).pipe(
          Effect.timeoutOrElse({
            duration: "30 seconds",
            orElse: () => Effect.fail(new Error("serve did not exit after SIGINT")),
          }),
        )
        yield* pollWithTimeout(
          Effect.sync(() => (groupAlive(pids.pid) ? undefined : true)),
          "external process group survived SIGINT",
          "20 seconds",
        )
      }),
    120_000,
  )

  // Control case pinning that the fix did not smuggle settlement into crash
  // paths. SIGKILL runs no handler, so the turn stays unsettled-but-readable
  // after restart — which the feature's recovery scope deliberately excludes.
  cliIt.live(
    "SIGKILL leaves the turn unsettled, preserving hard-crash semantics",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        const fake = yield* fakeClaude(home)
        const server = yield* opencode.serve({ env: fake.env })
        const { sessionID, pids } = yield* startExternalTurn({ url: server.url, home, pidFile: fake.pidFile })

        expect(groupAlive(pids.pid)).toBe(true)

        server.kill("SIGKILL")

        yield* Effect.promise(() => server.exited).pipe(
          Effect.timeoutOrElse({
            duration: "30 seconds",
            orElse: () => Effect.fail(new Error("serve did not exit after SIGKILL")),
          }),
        )

        // The message is readable (it was persisted when the turn started) but
        // was never completed, because no finalizer ran.
        const message = yield* assistantAfterRestart({ opencode, home, env: fake.env, sessionID })
        expect(message).toBeDefined()
        expect(message?.time?.completed).toBeUndefined()
      }),
    120_000,
  )
})
