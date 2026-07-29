// Isolates the half of `opencode serve`'s graceful shutdown that has nothing to
// do with signals: disposing a loaded instance must close the scopes it owns,
// and closing a scope that owns a spawned command must kill that command's whole
// detached process group.
//
// `serve` now converts SIGTERM/SIGINT into exactly this disposal, so when the
// subprocess test in test/cli/serve/serve-shutdown.test.ts fails, this test says
// whether the disposal chain broke or only the signal wiring did.
import { expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { InstanceState } from "@/effect/instance-state"
import {
  disposeAllInstancesEffect,
  provideInstanceEffect,
  testInstanceStoreLayer,
  tmpdirScoped,
} from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(LayerNode.compile(CrossSpawnSpawner.node), testInstanceStoreLayer))

/** True while the process group still has at least one member. */
function groupAlive(pgid: number) {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (err) {
    // ESRCH means gone. EPERM would mean it survives under another uid, which
    // can't happen for a group spawned by this test.
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

it.live("instance disposal kills the process group owned by instance state", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()

    // Per-instance state owning a silent, never-exiting child — the shape that
    // leaks, standing in for an external agent CLI mid-turn. Its grandchild
    // shares the detached group but is unknown to the spawner, so the group
    // check below can only succeed if the group was signalled as a whole:
    // kill(-pgid, 0) keeps succeeding while any member survives.
    const state = yield* InstanceState.make(() =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const script = [
          `const { spawn } = require("node:child_process")`,
          `spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })`,
          `setInterval(() => {}, 1000)`,
        ].join(";")
        const handle = yield* spawner.spawn(
          ChildProcess.make(process.execPath, ["-e", script], { forceKillAfter: "3 seconds" }),
        )
        return { pid: Number(handle.pid) }
      }),
    )

    const { pid } = yield* InstanceState.get(state).pipe(provideInstanceEffect(directory))
    expect(groupAlive(pid)).toBe(true)

    yield* disposeAllInstancesEffect

    yield* pollWithTimeout(
      Effect.sync(() => (groupAlive(pid) ? undefined : true)),
      "process group survived instance disposal",
      "20 seconds",
    )
  }),
)
