import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { SessionID } from "./schema"
import { Effect, Layer, Context } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"

export const Info = SessionStatusEvent.Info
export type Info = SessionStatusEvent.Info

export const Event = SessionStatusEvent

export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Map<SessionID, Info>>
  readonly set: (sessionID: SessionID, status: Info) => Effect.Effect<void>
  readonly hold: (sessionID: SessionID, owner: object) => Effect.Effect<void>
  readonly release: (sessionID: SessionID, owner: object) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionStatus") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionStatus.state")(() =>
        Effect.succeed({ status: new Map<SessionID, Info>(), holds: new Map<SessionID, Set<object>>() }),
      ),
    )

    const get = Effect.fn("SessionStatus.get")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      return data.status.get(sessionID) ?? { type: "idle" as const }
    })

    const list = Effect.fn("SessionStatus.list")(function* () {
      return new Map((yield* InstanceState.get(state)).status)
    })

    const set = Effect.fn("SessionStatus.set")(function* (sessionID: SessionID, status: Info) {
      const data = yield* InstanceState.get(state)
      if (status.type === "idle" && data.holds.get(sessionID)?.size) return
      yield* events.publish(Event.Status, { sessionID, status })
      if (status.type === "idle") {
        yield* events.publish(Event.Idle, { sessionID })
        data.status.delete(sessionID)
        return
      }
      data.status.set(sessionID, status)
    })

    const hold = Effect.fn("SessionStatus.hold")(function* (sessionID: SessionID, owner: object) {
      const data = yield* InstanceState.get(state)
      const owners = data.holds.get(sessionID) ?? new Set<object>()
      owners.add(owner)
      data.holds.set(sessionID, owners)
      yield* set(sessionID, { type: "busy" })
    })

    const release = Effect.fn("SessionStatus.release")(function* (sessionID: SessionID, owner: object) {
      const data = yield* InstanceState.get(state)
      const owners = data.holds.get(sessionID)
      owners?.delete(owner)
      if (owners?.size) return
      data.holds.delete(sessionID)
    })

    return Service.of({ get, list, set, hold, release })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node] })

export * as SessionStatus from "./status"
