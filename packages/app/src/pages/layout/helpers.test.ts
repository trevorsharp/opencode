import { describe, expect, test } from "bun:test"
import {
  collectNewSessionDeepLinks,
  collectOpenProjectDeepLinks,
  drainPendingDeepLinks,
  parseDeepLink,
  parseNewSessionDeepLink,
} from "./deep-links"
import { type Session } from "@opencode-ai/sdk/v2/client"
import {
  childSessionOnPath,
  closeHomeProject,
  displayName,
  effectiveWorkspaceOrder,
  errorMessage,
  hasProjectPermissions,
  homeProjectNavigation,
  homeProjectDirectories,
  homeSessionServerStatus,
  latestRootSession,
  openInVSCodeBase,
  openInVSCodeURL,
  projectForSession,
  toggleHomeProjectSelection,
} from "./helpers"
import { pathKey } from "@/utils/path-key"
import { ServerConnection } from "@/context/server"

const serverKey = ServerConnection.Key.make

const session = (input: Partial<Session> & Pick<Session, "id" | "directory">) =>
  ({
    title: "",
    version: "v2",
    parentID: undefined,
    messageCount: 0,
    permissions: { session: {}, share: {} },
    time: { created: 0, updated: 0, archived: undefined },
    ...input,
  }) as Session

describe("layout deep links", () => {
  test("parses open-project deep links", () => {
    expect(parseDeepLink("opencode://open-project?directory=/tmp/demo")).toBe("/tmp/demo")
  })

  test("ignores non-project deep links", () => {
    expect(parseDeepLink("opencode://other?directory=/tmp/demo")).toBeUndefined()
    expect(parseDeepLink("https://example.com")).toBeUndefined()
  })

  test("ignores malformed deep links safely", () => {
    expect(() => parseDeepLink("opencode://open-project/%E0%A4%A%")).not.toThrow()
    expect(parseDeepLink("opencode://open-project/%E0%A4%A%")).toBeUndefined()
  })

  test("parses links when URL.canParse is unavailable", () => {
    const original = Object.getOwnPropertyDescriptor(URL, "canParse")
    Object.defineProperty(URL, "canParse", { configurable: true, value: undefined })
    try {
      expect(parseDeepLink("opencode://open-project?directory=/tmp/demo")).toBe("/tmp/demo")
    } finally {
      if (original) Object.defineProperty(URL, "canParse", original)
      if (!original) Reflect.deleteProperty(URL, "canParse")
    }
  })

  test("ignores open-project deep links without directory", () => {
    expect(parseDeepLink("opencode://open-project")).toBeUndefined()
    expect(parseDeepLink("opencode://open-project?directory=")).toBeUndefined()
  })

  test("collects only valid open-project directories", () => {
    const result = collectOpenProjectDeepLinks([
      "opencode://open-project?directory=/a",
      "opencode://other?directory=/b",
      "opencode://open-project?directory=/c",
    ])
    expect(result).toEqual(["/a", "/c"])
  })

  test("parses new-session deep links with optional prompt", () => {
    expect(parseNewSessionDeepLink("opencode://new-session?directory=/tmp/demo")).toEqual({ directory: "/tmp/demo" })
    expect(parseNewSessionDeepLink("opencode://new-session?directory=/tmp/demo&prompt=hello%20world")).toEqual({
      directory: "/tmp/demo",
      prompt: "hello world",
    })
  })

  test("ignores new-session deep links without directory", () => {
    expect(parseNewSessionDeepLink("opencode://new-session")).toBeUndefined()
    expect(parseNewSessionDeepLink("opencode://new-session?directory=")).toBeUndefined()
  })

  test("collects only valid new-session deep links", () => {
    const result = collectNewSessionDeepLinks([
      "opencode://new-session?directory=/a",
      "opencode://open-project?directory=/b",
      "opencode://new-session?directory=/c&prompt=ship%20it",
    ])
    expect(result).toEqual([{ directory: "/a" }, { directory: "/c", prompt: "ship it" }])
  })

  test("drains global deep links once", () => {
    const target = {
      __OPENCODE__: {
        deepLinks: ["opencode://open-project?directory=/a"],
      },
    } as unknown as Window & { __OPENCODE__?: { deepLinks?: string[] } }

    expect(drainPendingDeepLinks(target)).toEqual(["opencode://open-project?directory=/a"])
    expect(drainPendingDeepLinks(target)).toEqual([])
  })
})

describe("layout workspace helpers", () => {
  test("normalizes trailing slash in workspace key", () => {
    expect(String(pathKey("/tmp/demo///"))).toBe("/tmp/demo")
    expect(String(pathKey("C:\\tmp\\demo\\\\"))).toBe("C:/tmp/demo")
  })

  test("preserves posix and drive roots in workspace key", () => {
    expect(String(pathKey("/"))).toBe("/")
    expect(String(pathKey("///"))).toBe("/")
    expect(String(pathKey("C:\\"))).toBe("C:/")
    expect(String(pathKey("C://"))).toBe("C:/")
    expect(String(pathKey("C:///"))).toBe("C:/")
  })

  test("keeps local first while preserving known order", () => {
    const result = effectiveWorkspaceOrder("/root", ["/root", "/b", "/c"], ["/root", "/c", "/a", "/b"])
    expect(result).toEqual(["/root", "/c", "/b"])
  })

  test("finds the latest root session across workspaces", () => {
    const result = latestRootSession(
      [
        {
          path: { directory: "/root" },
          session: [session({ id: "root", directory: "/root", time: { created: 1, updated: 1, archived: undefined } })],
        },
        {
          path: { directory: "/workspace" },
          session: [
            session({
              id: "workspace",
              directory: "/workspace",
              time: { created: 2, updated: 2, archived: undefined },
            }),
          ],
        },
      ],
      120_000,
    )

    expect(result?.id).toBe("workspace")
  })

  test("detects project permissions with a filter", () => {
    const result = hasProjectPermissions(
      {
        root: [{ id: "perm-root" }, { id: "perm-hidden" }],
        child: [{ id: "perm-child" }],
      },
      (item) => item.id === "perm-child",
    )

    expect(result).toBe(true)
  })

  test("ignores project permissions filtered out", () => {
    const result = hasProjectPermissions(
      {
        root: [{ id: "perm-root" }],
      },
      () => false,
    )

    expect(result).toBe(false)
  })

  test("ignores archived and child sessions when finding latest root session", () => {
    const result = latestRootSession(
      [
        {
          path: { directory: "/workspace" },
          session: [
            session({
              id: "archived",
              directory: "/workspace",
              time: { created: 10, updated: 10, archived: 10 },
            }),
            session({
              id: "child",
              directory: "/workspace",
              parentID: "parent",
              time: { created: 20, updated: 20, archived: undefined },
            }),
            session({
              id: "root",
              directory: "/workspace",
              time: { created: 30, updated: 30, archived: undefined },
            }),
          ],
        },
      ],
      120_000,
    )

    expect(result?.id).toBe("root")
  })

  test("finds the direct child on the active session path", () => {
    const list = [
      session({ id: "root", directory: "/workspace" }),
      session({ id: "child", directory: "/workspace", parentID: "root" }),
      session({ id: "leaf", directory: "/workspace", parentID: "child" }),
    ]

    expect(childSessionOnPath(list, "root", "leaf")?.id).toBe("child")
    expect(childSessionOnPath(list, "child", "leaf")?.id).toBe("leaf")
    expect(childSessionOnPath(list, "root", "root")).toBeUndefined()
    expect(childSessionOnPath(list, "root", "other")).toBeUndefined()
  })

  test("formats fallback project display name", () => {
    expect(displayName({ worktree: "/tmp/app" })).toBe("app")
    expect(displayName({ worktree: "/tmp/app", name: "My App" })).toBe("My App")
    expect(displayName({ worktree: "/" })).toBe("/")
  })

  test("scopes home project selection by server", () => {
    expect(
      toggleHomeProjectSelection(undefined, serverKey("https://debian.example"), "/home/luke/repos/amazon"),
    ).toEqual({
      server: serverKey("https://debian.example"),
      directory: "/home/luke/repos/amazon",
    })
    expect(
      toggleHomeProjectSelection(
        { server: serverKey("https://windows.example"), directory: "/home/luke/repos/amazon" },
        serverKey("https://debian.example"),
        "/home/luke/repos/amazon",
      ),
    ).toEqual({ server: serverKey("https://debian.example"), directory: "/home/luke/repos/amazon" })
    expect(
      toggleHomeProjectSelection(
        { server: serverKey("https://debian.example"), directory: "/home/luke/repos/amazon" },
        serverKey("https://debian.example"),
        "/home/luke/repos/amazon",
      ),
    ).toEqual({ server: serverKey("https://debian.example") })
  })

  test("closes a home project through its server context", () => {
    const closed: string[] = []

    expect(
      closeHomeProject(
        { server: serverKey("https://windows.example"), directory: "/shared" },
        serverKey("https://debian.example"),
        { close: (directory) => closed.push(directory) },
        "/shared",
      ),
    ).toEqual({ server: serverKey("https://windows.example"), directory: "/shared" })
    expect(closed).toEqual(["/shared"])
    expect(
      closeHomeProject(
        { server: serverKey("https://debian.example"), directory: "/shared" },
        serverKey("https://debian.example"),
        { close: (directory) => closed.push(directory) },
        "/shared",
      ),
    ).toEqual({ server: serverKey("https://debian.example") })
  })

  test("defers home project navigation until its server is active", () => {
    expect(
      homeProjectNavigation(serverKey("sidecar"), serverKey("https://debian.example"), "/YW1hem9u/session"),
    ).toEqual({
      server: serverKey("https://debian.example"),
      href: "/YW1hem9u/session",
    })
    expect(
      homeProjectNavigation(
        serverKey("https://debian.example"),
        serverKey("https://debian.example"),
        "/YW1hem9u/session",
      ),
    ).toEqual({
      href: "/YW1hem9u/session",
    })
  })

  test("preserves picker order when adding multiple projects", () => {
    expect(homeProjectDirectories(["/first", "/second"])).toEqual(["/first", "/second"])
    expect(homeProjectDirectories("/only")).toEqual(["/only"])
    expect(homeProjectDirectories(null)).toEqual([])
  })

  test("hides status derived from an inactive server", () => {
    let reads = 0
    const status = () => {
      reads++
      return { working: true, tint: "red" }
    }
    expect(homeSessionServerStatus(false, status)).toEqual({
      working: false,
      tint: undefined,
    })
    expect(reads).toBe(0)
    expect(homeSessionServerStatus(true, status)).toEqual({
      working: true,
      tint: "red",
    })
    expect(reads).toBe(1)
  })

  test("rejects missing, malformed, and unsupported vscode base urls", () => {
    expect(openInVSCodeBase(undefined)).toBeUndefined()
    expect(openInVSCodeBase("")).toBeUndefined()
    expect(openInVSCodeBase("not a url")).toBeUndefined()
    expect(openInVSCodeBase("ftp://code.example.com")).toBeUndefined()
    expect(openInVSCodeURL(undefined, "/home/sharp")).toBeUndefined()
    expect(openInVSCodeURL("not a url", "/home/sharp")).toBeUndefined()
    expect(openInVSCodeURL("ftp://code.example.com", "/home/sharp")).toBeUndefined()
    expect(openInVSCodeURL("https://code.example.com", "")).toBeUndefined()
  })

  test("sets the folder parameter on http and https base urls", () => {
    const url = new URL(openInVSCodeURL("https://code.example.com/open?theme=dark", "/home/sharp/my project")!)
    expect(url.searchParams.getAll("folder")).toEqual(["/home/sharp/my project"])
    expect(url.searchParams.get("theme")).toBe("dark")
    expect(openInVSCodeURL("http://code.example.com/?folder=%2Fold#panel", "/home/sharp/projects")).toBe(
      "http://code.example.com/?folder=%2Fhome%2Fsharp%2Fprojects#panel",
    )
  })

  test("appends the directory to a vscode base url", () => {
    expect(openInVSCodeURL("vscode://vscode-remote/ssh-remote+code-server", "/home/sharp/my project")).toBe(
      "vscode://vscode-remote/ssh-remote+code-server/home/sharp/my%20project?windowId=_blank",
    )
    expect(openInVSCodeURL("vscode://vscode-remote/ssh-remote+code-server/", "/home/sharp")).toBe(
      "vscode://vscode-remote/ssh-remote+code-server/home/sharp?windowId=_blank",
    )
    expect(openInVSCodeURL("vscode://vscode-remote/ssh-remote+host?profile=work&windowId=1#frag", "/home/sharp")).toBe(
      "vscode://vscode-remote/ssh-remote+host/home/sharp?profile=work&windowId=_blank#frag",
    )
  })

  test("round trips directories through both url formats", () => {
    for (const directory of ["/home/sharp/my project", "/home/sharp/a#b?c&d", "/home/sharp/ünïcødé/☃"]) {
      const http = new URL(openInVSCodeURL("https://code.example.com/open", directory)!)
      expect(http.searchParams.get("folder")).toBe(directory)

      const vscode = openInVSCodeURL("vscode://vscode-remote/ssh-remote+code-server", directory)!
      const path = vscode.slice("vscode://vscode-remote/ssh-remote+code-server".length, vscode.indexOf("?"))
      expect(decodeURIComponent(path)).toBe(directory)
    }
  })

  test("extracts api error message and fallback", () => {
    expect(errorMessage({ data: { message: "boom" } }, "fallback")).toBe("boom")
    expect(errorMessage(new Error("broken"), "fallback")).toBe("broken")
    expect(errorMessage("unknown", "fallback")).toBe("fallback")
  })
})

describe("projectForSession", () => {
  const gitProject = { id: "git-alpha", worktree: "/repo-alpha", sandboxes: ["/roots/mixed/repo-alpha", "/wt/feature"] }
  const gitBeta = { id: "git-beta", worktree: "/repo-beta", sandboxes: ["/roots/mixed/repo-beta"] }
  const workspaceProject = {
    id: "feature:/roots/mixed",
    worktree: "/roots/mixed",
    sandboxes: ["/roots/mixed/repo-alpha", "/roots/mixed/repo-beta"],
  }

  const orders = [
    ["git first", [gitProject, gitBeta, workspaceProject]],
    ["workspace first", [workspaceProject, gitProject, gitBeta]],
  ] as const

  for (const [label, projects] of orders) {
    test(`groups a member session under its workspace despite the shared git project id (${label})`, () => {
      const member = session({ id: "s1", directory: "/roots/mixed/repo-alpha", projectID: "git-alpha" })
      expect(projectForSession(member, [...projects])?.id).toBe(workspaceProject.id)
    })

    test(`groups unrelated member sessions under the same workspace (${label})`, () => {
      const beta = session({ id: "s2", directory: "/roots/mixed/repo-beta", projectID: "git-beta" })
      expect(projectForSession(beta, [...projects])?.id).toBe(workspaceProject.id)
    })

    test(`keeps source sessions on the source checkout (${label})`, () => {
      const source = session({ id: "s3", directory: "/repo-alpha", projectID: "git-alpha" })
      expect(projectForSession(source, [...projects])?.id).toBe(gitProject.id)
    })

    test(`keeps ordinary worktree sessions on the source checkout (${label})`, () => {
      const worktree = session({ id: "s4", directory: "/wt/feature", projectID: "git-alpha" })
      expect(projectForSession(worktree, [...projects])?.id).toBe(gitProject.id)
    })
  }

  test("falls back to the project id when no project claims the directory", () => {
    const detached = session({ id: "s5", directory: "/gone", projectID: "git-alpha" })
    expect(projectForSession(detached, [gitProject, workspaceProject])?.id).toBe(gitProject.id)
  })
})
