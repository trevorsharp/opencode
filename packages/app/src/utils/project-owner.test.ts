import { describe, expect, test } from "bun:test"
import { isWorkspaceContainer, owningContainer, type OwnableProject } from "./project-owner"

const SOURCE = "/repo-alpha"
const MEMBER = "/roots/mixed-histories/repo-alpha"
const BETA_SOURCE = "/repo-beta"
const BETA_MEMBER = "/roots/mixed-histories/repo-beta"
const PLAIN_WORKTREE = "/repo-alpha-worktrees/feature"
const WORKSPACE_ROOT = "/roots/mixed-histories"

const git = {
  id: "bfaded4f4e0d1b0a",
  worktree: SOURCE,
  sandboxes: [MEMBER, PLAIN_WORKTREE],
} satisfies OwnableProject

const gitBeta = {
  id: "c19f2a7b3d5e8c40",
  worktree: BETA_SOURCE,
  sandboxes: [BETA_MEMBER],
} satisfies OwnableProject

const workspace = {
  id: `feature:${WORKSPACE_ROOT}`,
  worktree: WORKSPACE_ROOT,
  sandboxes: [MEMBER, BETA_MEMBER],
} satisfies OwnableProject

const orders = [
  ["git first", [git, gitBeta, workspace]],
  ["workspace first", [workspace, git, gitBeta]],
] satisfies [string, OwnableProject[]][]

describe("owningContainer", () => {
  for (const [label, projects] of orders) {
    test(`prefers the workspace container for a member of its own source repository (${label})`, () => {
      expect(owningContainer(projects, MEMBER)?.id).toBe(workspace.id)
    })

    test(`resolves unrelated members to the same workspace container (${label})`, () => {
      expect(owningContainer(projects, BETA_MEMBER)?.id).toBe(workspace.id)
    })

    test(`resolves an exact worktree match to its own project (${label})`, () => {
      expect(owningContainer(projects, SOURCE)?.id).toBe(git.id)
      expect(owningContainer(projects, WORKSPACE_ROOT)?.id).toBe(workspace.id)
    })

    test(`leaves an ordinary git worktree with its source project (${label})`, () => {
      expect(owningContainer(projects, PLAIN_WORKTREE)?.id).toBe(git.id)
    })
  }

  test("ignores trailing slashes when matching directories", () => {
    expect(owningContainer([git, workspace], `${MEMBER}/`)?.id).toBe(workspace.id)
    expect(owningContainer([git, workspace], `${SOURCE}/`)?.id).toBe(git.id)
  })

  test("returns nothing for a directory no project claims", () => {
    expect(owningContainer([git, workspace], "/elsewhere")).toBeUndefined()
  })
})

describe("isWorkspaceContainer", () => {
  test("recognizes workspace identity only", () => {
    expect(isWorkspaceContainer(workspace)).toBe(true)
    expect(isWorkspaceContainer(git)).toBe(false)
    expect(isWorkspaceContainer(undefined)).toBe(false)
  })
})
