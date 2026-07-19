import * as InstanceState from "@/effect/instance-state"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { Protected } from "@opencode-ai/core/filesystem/protected"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { Effect, Layer, Option } from "effect"
import fuzzysort from "fuzzysort"
import ignore from "ignore"
import path from "path"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const fileHandlers = HttpApiBuilder.group(InstanceHttpApi, "file", (handlers) =>
  Effect.gen(function* () {
    const ripgrep = yield* Ripgrep.Service
    const locations = yield* LocationServiceMap.Service

    const filesystem = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
      return yield* effect.pipe(
        Effect.provide(
          locations.get(Location.Ref.make({ directory: AbsolutePath.make((yield* InstanceState.context).directory) })),
        ),
      )
    })

    const defaultDirectoryResults = Effect.fn("FileHttpApi.defaultDirectoryResults")(function* (
      query: string,
      limit: number,
    ) {
      const fs = yield* FileSystem.Service
      const protectedNames = Protected.names()
      const nested = new Set(["node_modules", "dist", "build", "target", "vendor"])
      const top = (yield* fs.list({ path: RelativePath.make("") }).pipe(Effect.catch(() => Effect.succeed([]))))
        .filter((item) => item.type === "directory")
        .filter((item) => !path.basename(item.path).startsWith("."))
        .filter((item) => !protectedNames.has(path.basename(item.path)))
      const children = (yield* Effect.forEach(
        top,
        (item) =>
          fs.list({ path: item.path }).pipe(
            Effect.catch(() => Effect.succeed([])),
            Effect.map((items) =>
              items
                .filter((child) => child.type === "directory")
                .filter((child) => !path.basename(child.path).startsWith("."))
                .filter((child) => !nested.has(path.basename(child.path)))
                .map((child) => child.path),
            ),
          ),
        { concurrency: 16 },
      )).flat()
      const rows = Array.from(new Set([...top.map((item) => item.path), ...children]))
      if (!query) return rows.slice(0, limit)
      return fuzzysort.go(query, rows, { limit }).map((item) => item.target)
    })

    const findText = Effect.fn("FileHttpApi.findText")(function* (ctx: { query: { pattern: string } }) {
      return (yield* ripgrep
        .grep({ cwd: (yield* InstanceState.context).directory, pattern: ctx.query.pattern, limit: 10 })
        .pipe(Effect.orDie)).map((match) => ({
        path: { text: match.entry.path },
        lines: { text: match.text },
        line_number: match.line,
        absolute_offset: match.offset,
        submatches: match.submatches.map((submatch) => ({
          match: { text: submatch.text },
          start: submatch.start,
          end: submatch.end,
        })),
      }))
    })

    const findFile = Effect.fn("FileHttpApi.findFile")(function* (ctx: {
      query: { query: string; dirs?: "true" | "false"; type?: "file" | "directory"; limit?: number }
    }) {
      const directory = (yield* InstanceState.context).directory
      const limit = ctx.query.limit ?? 10
      const type = ctx.query.type ?? (ctx.query.dirs === "false" ? "file" : undefined)
      const query = ctx.query.query.trim()
      const useDefaultDirectories = type === "directory" || (!query && type === undefined)
      const started = performance.now()
      const found = yield* filesystem(FileSystem.Service.use((fs) => fs.find({ query, limit, type }))).pipe(
        Effect.catch((error) => {
          if (!useDefaultDirectories) return Effect.die(error)
          return Effect.logWarning("find file failed", { directory, query, type, error }).pipe(
            Effect.andThen(Effect.succeed<{ path: string }[]>([])),
          )
        }),
      )
      const fallback =
        useDefaultDirectories && found.length === 0 ? yield* filesystem(defaultDirectoryResults(query, limit)) : []
      const results = fallback.length ? fallback : found.map((item) => item.path)
      yield* Effect.logInfo("find file", {
        engine: fallback.length ? "directory-list" : "fff",
        query: ctx.query.query,
        type,
        directory,
        limit,
        results: results.length,
        duration: Math.round(performance.now() - started),
      })
      return results
    })

    const findSymbol = Effect.fn("FileHttpApi.findSymbol")(function* () {
      return []
    })

    const list = Effect.fn("FileHttpApi.list")(function* (ctx: { query: { path: string } }) {
      const directory = (yield* InstanceState.context).directory
      return yield* filesystem(
        Effect.gen(function* () {
          const fs = yield* FileSystem.Service
          const raw = yield* FSUtil.Service
          const location = yield* Location.Service
          const ignored = ignore()
          const gitignore = yield* raw
            .readFileString(path.join(location.project.directory, ".gitignore"))
            .pipe(Effect.catch(() => Effect.succeed("")))
          if (gitignore) ignored.add(gitignore)
          const ignorefile = yield* raw
            .readFileString(path.join(location.project.directory, ".ignore"))
            .pipe(Effect.catch(() => Effect.succeed("")))
          if (ignorefile) ignored.add(ignorefile)
          return (yield* fs.list({ path: RelativePath.make(ctx.query.path) })).map((item) => ({
            name: path.basename(item.path),
            path: item.path,
            absolute: path.resolve(location.directory, item.path),
            type: item.type,
            ignored: ignored.ignores(
              path.relative(location.project.directory, path.resolve(location.directory, item.path)) +
                (item.type === "directory" ? "/" : ""),
            ),
          }))
        }),
      )
    })

    const content = Effect.fn("FileHttpApi.content")(function* (ctx: { query: { path: string } }) {
      const directory = (yield* InstanceState.context).directory
      const file = path.resolve(directory, ctx.query.path)
      if (!FSUtil.contains(directory, file)) return yield* Effect.die(new Error("Path escapes the location"))
      if (!(yield* FSUtil.Service.use((fs) => fs.existsSafe(file)))) return { type: "text" as const, content: "" }
      return yield* filesystem(
        FileSystem.Service.use((fs) => fs.read({ path: RelativePath.make(ctx.query.path) })),
      ).pipe(
        Effect.flatMap((item) =>
          Effect.gen(function* () {
            const text = item.content.includes(0)
              ? Option.none<string>()
              : yield* Effect.sync(() => new TextDecoder("utf-8", { fatal: true }).decode(item.content)).pipe(
                  Effect.option,
                )
            return { item, text }
          }),
        ),
        Effect.map(({ item, text }) =>
          Option.isSome(text)
            ? { type: "text" as const, content: text.value.trim() }
            : {
                type: "binary" as const,
                content: Buffer.from(item.content).toString("base64"),
                encoding: "base64" as const,
                mimeType: item.mime,
              },
        ),
      )
    })

    const status = Effect.fn("FileHttpApi.status")(function* () {
      return []
    })

    return handlers
      .handle("findText", findText)
      .handle("findFile", findFile)
      .handle("findSymbol", findSymbol)
      .handle("list", list)
      .handle("content", content)
      .handle("status", status)
  }),
).pipe(Layer.provide(locationServiceMapLayer))
