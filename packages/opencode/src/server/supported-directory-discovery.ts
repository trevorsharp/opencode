import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Effect } from "effect"
import fuzzysort from "fuzzysort"
import path from "path"

export const supportedDirectoryConfig = {
  roots: ["Downloads", "opencode", "projects"],
  nestedRoots: ["projects", "workspaces"],
} as const

export const findSupportedDirectories = Effect.fn("SupportedDirectoryDiscovery.find")(function* (
  directory: string,
  query: string,
  limit: number,
) {
  const fs = yield* FSUtil.Service
  const children = (yield* Effect.forEach(
    supportedDirectoryConfig.nestedRoots,
    (root) =>
      fs.readDirectoryEntries(path.join(Global.Path.home, root)).pipe(
        Effect.catch(() => Effect.succeed([])),
        Effect.map((entries) =>
          entries
            .filter((entry) => entry.type === "directory")
            .sort((left, right) => left.name.localeCompare(right.name))
            .map((entry) => path.join(Global.Path.home, root, entry.name)),
        ),
      ),
    { concurrency: "unbounded" },
  )).flat()
  const configured = supportedDirectoryConfig.roots.map((root) => path.join(Global.Path.home, root))
  const existing = yield* Effect.filter([...configured, ...children], (candidate) => fs.isDir(candidate), {
    concurrency: "unbounded",
  })
  const rows = Array.from(new Set(existing)).map((candidate) => path.relative(directory, candidate) || ".")
  if (!query) return rows.slice(0, limit)
  return fuzzysort.go(query, rows, { limit }).map((result) => result.target)
})
