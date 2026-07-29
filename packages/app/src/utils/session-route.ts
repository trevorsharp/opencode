import { base64Encode } from "@opencode-ai/core/util/encode"
import { ServerConnection } from "@/context/server"
import { decode64 } from "@/utils/base64"
import { pathKey } from "@/utils/path-key"

export const cancelProjectNavigationEvent = "opencode:cancel-project-navigation"

export function cancelPendingProjectNavigation() {
  window.dispatchEvent(new Event(cancelProjectNavigationEvent))
}

export function sessionHref(server: ServerConnection.Key, sessionID: string) {
  return `/server/${base64Encode(server)}/session/${sessionID}`
}

// The workspace root a legacy route belongs to, carried as explicit route state because a
// directory alone does not identify which workspace container owns it.
export function workspaceRootParam(search: string | undefined) {
  const value = new URLSearchParams(search ?? "").get("root")
  return value ? decode64(value) : undefined
}

export function withWorkspaceRoot(href: string, directory: string, root: string | undefined) {
  if (!root || pathKey(root) === pathKey(directory)) return href
  const [path, fragment] = href.split("#")
  const url = new URL(path ?? href, "http://legacy")
  url.searchParams.set("root", base64Encode(root))
  return `${url.pathname}${url.search}${fragment ? `#${fragment}` : ""}`
}

// Generic navigation helpers receive plain legacy hrefs, so the owning root is restored from the
// known containers instead of being discarded.
export function legacyRouteDirectory(href: string) {
  if (!href.startsWith("/")) return
  const [path] = href.split(/[?#]/)
  const [, segment, kind] = (path ?? "").split("/")
  if (!segment || (kind !== undefined && kind !== "session")) return
  const directory = decode64(segment)
  return directory && base64Encode(directory) === segment ? directory : undefined
}

export function workspaceRootOf(projects: readonly { worktree: string; sandboxes?: string[] }[], directory: string) {
  const key = pathKey(directory)
  if (projects.some((project) => pathKey(project.worktree) === key)) return undefined
  return projects.find((project) => project.sandboxes?.some((item) => pathKey(item) === key))?.worktree
}

export function legacySessionHref(
  directory: string,
  sessionID: string,
  root?: string,
  state?: { search?: string; hash?: string },
) {
  return withWorkspaceRoot(
    `/${base64Encode(directory)}/session/${sessionID}${state?.search ?? ""}${state?.hash ?? ""}`,
    directory,
    root,
  )
}

export function legacyNewSessionHref(directory: string, root?: string) {
  return withWorkspaceRoot(`/${base64Encode(directory)}/session`, directory, root)
}

export function requireServerKey(segment: string | undefined) {
  const key = decode64(segment)
  if (!key || base64Encode(key) !== segment) throw new Error("Invalid server route")
  return ServerConnection.Key.make(key)
}

export function legacySessionServer(
  tabs: readonly { type: "session"; server: ServerConnection.Key; sessionId: string }[],
  sessionID: string,
  active: ServerConnection.Key,
) {
  const matches = tabs.filter((tab) => tab.sessionId === sessionID)
  return matches.find((tab) => tab.server === active)?.server ?? (matches.length === 1 ? matches[0]?.server : active)
}

type SessionParent = { id: string; parentID?: string }

export async function rootSession<T extends SessionParent>(session: T, get: (sessionID: string) => Promise<T>) {
  const seen = new Set([session.id])
  let current = session
  while (current.parentID) {
    if (seen.has(current.parentID)) throw new Error(`Session parent cycle: ${current.parentID}`)
    seen.add(current.parentID)
    current = await get(current.parentID)
  }
  return current
}
