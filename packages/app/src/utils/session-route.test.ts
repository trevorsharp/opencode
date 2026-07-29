import { describe, expect, test } from "bun:test"
import { ServerConnection } from "@/context/server"
import {
  legacyNewSessionHref,
  legacyRouteDirectory,
  legacySessionHref,
  legacySessionServer,
  requireServerKey,
  rootSession,
  sessionHref,
  withWorkspaceRoot,
  workspaceRootOf,
  workspaceRootParam,
} from "./session-route"

describe("session routes", () => {
  test("uses the unique persisted server for a legacy session route", () => {
    expect(
      legacySessionServer(
        [{ type: "session", server: ServerConnection.Key.make("server-b"), sessionId: "session-1" }],
        "session-1",
        ServerConnection.Key.make("server-a"),
      ),
    ).toBe(ServerConnection.Key.make("server-b"))
  })

  test("prefers the active server when a legacy session ID is ambiguous", () => {
    expect(
      legacySessionServer(
        [
          { type: "session", server: ServerConnection.Key.make("server-a"), sessionId: "session-1" },
          { type: "session", server: ServerConnection.Key.make("server-b"), sessionId: "session-1" },
        ],
        "session-1",
        ServerConnection.Key.make("server-b"),
      ),
    ).toBe(ServerConnection.Key.make("server-b"))
  })

  test("builds and decodes a server-keyed session route", () => {
    const server = ServerConnection.Key.make("https://example.com:4096")
    const href = sessionHref(server, "session-1")

    expect(href).toBe("/server/aHR0cHM6Ly9leGFtcGxlLmNvbTo0MDk2/session/session-1")
    expect(requireServerKey(href.split("/")[2])).toBe(server)
  })

  test("rejects malformed server keys", () => {
    expect(() => requireServerKey("not-base64")).toThrow("Invalid server route")
  })

  test("builds the legacy directory-keyed route", () => {
    expect(legacySessionHref("/Users/example/project", "session-1")).toBe(
      "/L1VzZXJzL2V4YW1wbGUvcHJvamVjdA/session/session-1",
    )
  })

  test("carries the workspace root on member routes", () => {
    expect(legacySessionHref("/Users/example/workspace/api", "session-1", "/Users/example/workspace")).toBe(
      "/L1VzZXJzL2V4YW1wbGUvd29ya3NwYWNlL2FwaQ/session/session-1?root=L1VzZXJzL2V4YW1wbGUvd29ya3NwYWNl",
    )
    expect(legacyNewSessionHref("/Users/example/workspace/api", "/Users/example/workspace")).toBe(
      "/L1VzZXJzL2V4YW1wbGUvd29ya3NwYWNlL2FwaQ/session?root=L1VzZXJzL2V4YW1wbGUvd29ya3NwYWNl",
    )
  })

  test("omits the workspace root when the directory is the root itself", () => {
    expect(legacySessionHref("/Users/example/workspace", "session-1", "/Users/example/workspace")).toBe(
      "/L1VzZXJzL2V4YW1wbGUvd29ya3NwYWNl/session/session-1",
    )
  })

  test("preserves unrelated query parameters and fragments", () => {
    expect(withWorkspaceRoot("/slug/session?draftId=abc#top", "/dir/member", "/dir")).toBe(
      "/slug/session?draftId=abc&root=L2Rpcg#top",
    )
    expect(withWorkspaceRoot("/slug/session?root=stale", "/dir/member", "/dir")).toBe("/slug/session?root=L2Rpcg")
    expect(
      legacySessionHref("/dir/member", "session-1", "/dir", {
        search: "?root=stale&audit=retained",
        hash: "#gate-fragment",
      }),
    ).toBe("/L2Rpci9tZW1iZXI/session/session-1?root=L2Rpcg&audit=retained#gate-fragment")
  })

  test("reads the workspace root from route state", () => {
    expect(workspaceRootParam("?root=L2Rpcg&draftId=abc")).toBe("/dir")
    expect(workspaceRootParam("?draftId=abc")).toBeUndefined()
    expect(workspaceRootParam(undefined)).toBeUndefined()
  })

  test("reads the directory back out of a legacy route", () => {
    expect(legacyRouteDirectory("/L1VzZXJzL2V4YW1wbGUvd29ya3NwYWNlL2FwaQ/session/session-1")).toBe(
      "/Users/example/workspace/api",
    )
    expect(legacyRouteDirectory("/L1VzZXJzL2V4YW1wbGUvd29ya3NwYWNlL2FwaQ?tab=1#top")).toBe(
      "/Users/example/workspace/api",
    )
    expect(legacyRouteDirectory("/server/aHR0cHM6Ly9leGFtcGxlLmNvbTo0MDk2/session/session-1")).toBeUndefined()
    expect(legacyRouteDirectory("/not-base64/session/session-1")).toBeUndefined()
    expect(legacyRouteDirectory("https://example.com/x")).toBeUndefined()
  })

  test("finds the container that owns a member directory", () => {
    const projects = [
      { worktree: "/Users/example/workspace", sandboxes: ["/Users/example/workspace/api"] },
      { worktree: "/Users/example/other" },
    ]

    expect(workspaceRootOf(projects, "/Users/example/workspace/api")).toBe("/Users/example/workspace")
    expect(workspaceRootOf(projects, "/Users/example/workspace")).toBeUndefined()
    expect(workspaceRootOf(projects, "/Users/example/other")).toBeUndefined()
    expect(workspaceRootOf(projects, "/Users/example/unknown")).toBeUndefined()
  })

  test("resolves the root session", async () => {
    const sessions: Record<string, { id: string; parentID?: string }> = {
      child: { id: "child", parentID: "parent" },
      parent: { id: "parent", parentID: "root" },
      root: { id: "root" },
    }

    expect(
      await rootSession(sessions.child, async (id) => {
        const session = sessions[id]
        if (!session) throw new Error(`Missing session: ${id}`)
        return session
      }),
    ).toBe(sessions.root)
  })

  test("rejects a parent cycle", async () => {
    const sessions: Record<string, { id: string; parentID?: string }> = {
      child: { id: "child", parentID: "parent" },
      parent: { id: "parent", parentID: "child" },
    }

    expect(rootSession(sessions.child, async (id) => sessions[id]!)).rejects.toThrow("Session parent cycle: child")
  })
})
