import { Effect } from "effect"
import type { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"

/**
 * The MCP servers a session tree has activated, keyed by its root session.
 *
 * Activation is a materialization filter rather than configuration, so it stays
 * process-local: a restart simply clears it and a resumed session activates
 * again. Root session ids are globally unique, so no directory key is needed —
 * the clients themselves remain owned by the directory-scoped MCP service.
 */
const trees = new Map<string, Set<string>>()

const NONE: ReadonlySet<string> = new Set()

/**
 * The root of the session tree a session belongs to, found by walking the
 * existing parent relationship. A session whose parent can no longer be read is
 * treated as the root rather than failing the turn. The walk stops at a parent in
 * another directory: clients, credentials, and configuration are directory-scoped,
 * so activation must not reach a tree that never authorized it.
 */
export const root = Effect.fnUntraced(function* (sessions: Session.Interface, sessionID: SessionID) {
  const read = (id: SessionID) => sessions.get(id).pipe(Effect.catch(() => Effect.succeed(undefined)))
  const seen = new Set<string>([sessionID])
  let rootID = sessionID
  let info = yield* read(sessionID)
  while (info?.parentID && !seen.has(info.parentID)) {
    seen.add(info.parentID)
    const parent = yield* read(info.parentID)
    if (!parent || parent.directory !== info.directory) break
    rootID = info.parentID
    info = parent
  }
  return rootID
})

export function active(rootID: SessionID): ReadonlySet<string> {
  return trees.get(rootID) ?? NONE
}

export function activate(rootID: SessionID, names: Iterable<string>) {
  const existing = trees.get(rootID) ?? new Set<string>()
  for (const name of names) existing.add(name)
  trees.set(rootID, existing)
}

export * as McpActivation from "./activation"
