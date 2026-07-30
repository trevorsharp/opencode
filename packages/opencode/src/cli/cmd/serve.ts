import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@opencode-ai/core/flag/flag"

/**
 * How long instance disposal may take before the process exits anyway. Each
 * tracked child gets SIGTERM and is escalated to SIGKILL after its own
 * `forceKillAfter` (3 seconds for the claude CLI), so this only has to leave
 * room for that escalation plus persistence of the settled turns.
 */
const DISPOSE_TIMEOUT = "15 seconds"

/**
 * Resolves with the first shutdown signal received. Registered with `once` and
 * removed by the finalizer so nothing is left behind on the process.
 */
const shutdownSignal = Effect.callback<NodeJS.Signals>((resume) => {
  const onSignal = (signal: NodeJS.Signals) => resume(Effect.succeed(signal))
  process.once("SIGTERM", onSignal)
  process.once("SIGINT", onSignal)
  return Effect.sync(() => {
    process.off("SIGTERM", onSignal)
    process.off("SIGINT", onSignal)
  })
})

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless opencode server",
  // Server loads instances per-request via x-opencode-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)

    const signal = yield* shutdownSignal
    console.log(`received ${signal}, shutting down`)
    // Escape hatch: a second signal during the grace window exits immediately,
    // matching the pre-existing hard-kill semantics for an impatient operator.
    process.once(signal, () => process.exit(1))

    // Stop admitting requests before disposing so nothing can re-load an
    // instance behind disposeAll().
    yield* Effect.promise(() => server.stop(true))

    // Disposing loaded instances is what every other command already does on
    // exit: it cancels each running session, which settles and persists the
    // interrupted turn and closes the scopes owning external agent processes,
    // killing their detached process groups.
    const { InstanceStore } = yield* Effect.promise(() => import("../../project/instance-store"))
    yield* InstanceStore.Service.use((store) => store.disposeAll()).pipe(Effect.timeoutOption(DISPOSE_TIMEOUT))
  }),
})
