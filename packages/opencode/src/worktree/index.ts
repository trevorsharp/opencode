import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { path } from "@opencode-ai/core/effect/app-node-platform"
import { Global } from "@opencode-ai/core/global"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { Database } from "@opencode-ai/core/database/database"
import { eq } from "drizzle-orm"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Slug } from "@opencode-ai/core/util/slug"
import { errorMessage } from "../util/error"
import { GlobalBus } from "@/bus/global"
import { Git } from "@/git"
import { Duration, Effect, Layer, Path, Schema, Scope, Semaphore, Context } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AppProcess } from "@opencode-ai/core/process"
import { InstanceState } from "@/effect/instance-state"
import { WorktreeEvent } from "@opencode-ai/schema/worktree-event"

export const Event = WorktreeEvent

export const Info = Schema.Struct({
  name: Schema.String,
  branch: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  directory: Schema.String,
  root: Schema.optional(Schema.String),
}).annotate({ identifier: "Worktree" })
export type Info = Schema.Schema.Type<typeof Info>

export const CreateInput = Schema.Struct({
  name: Schema.optional(Schema.String),
  startCommand: Schema.optional(
    Schema.String.annotate({ description: "Additional startup script to run after the project's start command" }),
  ),
  workspaceOnly: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "WorktreeCreateInput" })
export type CreateInput = Schema.Schema.Type<typeof CreateInput>

export const RemoveInput = Schema.Struct({
  directory: Schema.String,
  workspaceOnly: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "WorktreeRemoveInput" })
export type RemoveInput = Schema.Schema.Type<typeof RemoveInput>

export const RemoveResult = Schema.Struct({
  removed: Schema.Boolean,
  featureRemoved: Schema.Boolean,
  featureDirectory: Schema.optional(Schema.String),
}).annotate({ identifier: "WorktreeRemoveResult" })
export type RemoveResult = Schema.Schema.Type<typeof RemoveResult>

export const ResetInput = Schema.Struct({
  directory: Schema.String,
}).annotate({ identifier: "WorktreeResetInput" })
export type ResetInput = Schema.Schema.Type<typeof ResetInput>

export const RenameInput = Schema.Struct({
  directory: Schema.String,
  name: Schema.String,
}).annotate({ identifier: "WorktreeRenameInput" })
export type RenameInput = Schema.Schema.Type<typeof RenameInput>

export class NotGitError extends Schema.TaggedErrorClass<NotGitError>()("WorktreeNotGitError", {
  message: Schema.String,
}) {}

export class NameGenerationFailedError extends Schema.TaggedErrorClass<NameGenerationFailedError>()(
  "WorktreeNameGenerationFailedError",
  {
    message: Schema.String,
  },
) {}

export class CreateFailedError extends Schema.TaggedErrorClass<CreateFailedError>()("WorktreeCreateFailedError", {
  message: Schema.String,
}) {}

export class StartCommandFailedError extends Schema.TaggedErrorClass<StartCommandFailedError>()(
  "WorktreeStartCommandFailedError",
  {
    message: Schema.String,
  },
) {}

export class RemoveFailedError extends Schema.TaggedErrorClass<RemoveFailedError>()("WorktreeRemoveFailedError", {
  message: Schema.String,
}) {}

export class ResetFailedError extends Schema.TaggedErrorClass<ResetFailedError>()("WorktreeResetFailedError", {
  message: Schema.String,
}) {}

export class RenameFailedError extends Schema.TaggedErrorClass<RenameFailedError>()("WorktreeRenameFailedError", {
  message: Schema.String,
}) {}

export class ListFailedError extends Schema.TaggedErrorClass<ListFailedError>()("WorktreeListFailedError", {
  message: Schema.String,
}) {}

export type Error =
  | NotGitError
  | NameGenerationFailedError
  | CreateFailedError
  | StartCommandFailedError
  | RemoveFailedError
  | ResetFailedError
  | RenameFailedError
  | ListFailedError

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
}

function failedRemoves(...chunks: string[]) {
  return chunks.filter(Boolean).flatMap((chunk) =>
    chunk
      .split("\n")
      .map((line) => line.trim())
      .flatMap((line) => {
        const match = line.match(/^warning:\s+failed to remove\s+(.+):\s+/i)
        if (!match) return []
        const value = match[1]?.trim().replace(/^['"]|['"]$/g, "")
        if (!value) return []
        return [value]
      }),
  )
}

// ---------------------------------------------------------------------------
// Effect service
// ---------------------------------------------------------------------------

export interface Interface {
  readonly makeWorktreeInfo: (options?: { name?: string; detached?: boolean }) => Effect.Effect<Info, Error>
  readonly createFromInfo: (info: Info, startCommand?: string) => Effect.Effect<void, Error>
  readonly create: (input?: CreateInput) => Effect.Effect<Info, Error>
  readonly list: () => Effect.Effect<(Omit<Info, "branch"> & { branch?: string })[], Error>
  readonly remove: (input: RemoveInput) => Effect.Effect<boolean, Error>
  readonly removeDetailed: (input: RemoveInput) => Effect.Effect<RemoveResult, Error>
  readonly reset: (input: ResetInput) => Effect.Effect<boolean, Error>
  readonly rename: (input: RenameInput) => Effect.Effect<boolean, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Worktree") {}

type GitResult = { code: number; text: string; stderr: string }
type WorkspaceCliInfo = {
  name?: string
  path?: string
  folders?: { folder?: string; branch?: string; source?: string; kind?: string }[]
}

const layer: Layer.Layer<
  Service,
  never,
  | FSUtil.Service
  | Path.Path
  | AppProcess.Service
  | Git.Service
  | Project.Service
  | InstanceStore.Service
  | Database.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const fs = yield* FSUtil.Service
    const pathSvc = yield* Path.Path
    const appProcess = yield* AppProcess.Service
    const { db } = yield* Database.Service
    const gitSvc = yield* Git.Service
    const project = yield* Project.Service
    const store = yield* InstanceStore.Service

    const git = Effect.fnUntraced(
      function* (args: string[], opts?: { cwd?: string }) {
        const result = yield* appProcess.run(
          ChildProcess.make("git", args, { cwd: opts?.cwd, extendEnv: true, stdin: "ignore" }),
        )
        return {
          code: result.exitCode,
          text: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        } satisfies GitResult
      },
      Effect.catch((e) =>
        Effect.succeed({
          code: 1,
          text: "",
          stderr: e instanceof Error ? e.message : String(e),
        } satisfies GitResult),
      ),
    )

    // The workspace CLI is a bun script, and bun reads bunfig.toml from its cwd.
    // Inheriting the server's cwd therefore lets an unrelated project's preload
    // fail the CLI before it parses its own arguments, which reads back as
    // missing workspace information. Directory-independent commands (`info
    // --workspace`, `list`) get opencode's own data directory instead, which
    // never carries a bunfig.
    const workspace = Effect.fnUntraced(
      function* (args: string[], opts?: { cwd?: string; timeout?: Duration.Input }) {
        const command = appProcess.run(
          ChildProcess.make("workspace", args, {
            cwd: opts?.cwd ?? Global.Path.data,
            extendEnv: true,
            stdin: "ignore",
          }),
        )
        const result = yield* opts?.timeout ? command.pipe(Effect.timeout(opts.timeout)) : command
        return {
          code: result.exitCode,
          text: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        } satisfies GitResult
      },
      Effect.catch((e) =>
        Effect.succeed({
          code: 1,
          text: "",
          stderr: e instanceof Error ? e.message : String(e),
        } satisfies GitResult),
      ),
    )

    const MAX_NAME_ATTEMPTS = 26
    const candidate = Effect.fn("Worktree.candidate")(function* (input: {
      root: string
      name?: string
      detached?: boolean
    }) {
      const ctx = yield* InstanceState.context
      for (const attempt of Array.from({ length: MAX_NAME_ATTEMPTS }, (_, i) => i)) {
        const name = input.name ? (attempt === 0 ? input.name : `${input.name}-${Slug.create()}`) : Slug.create()
        const branch = input.detached ? undefined : `opencode/${name}`
        const directory = pathSvc.join(input.root, name)

        if (yield* fs.exists(directory).pipe(Effect.orDie)) continue

        if (branch) {
          const ref = `refs/heads/${branch}`
          const branchCheck = yield* git(["show-ref", "--verify", "--quiet", ref], { cwd: ctx.worktree })
          if (branchCheck.code === 0) continue
        }

        return { name, directory, ...(branch ? { branch } : {}) }
      }
      return yield* new NameGenerationFailedError({ message: "Failed to generate a unique worktree name" })
    })

    const makeWorktreeInfo = Effect.fn("Worktree.makeWorktreeInfo")(function* (input?: {
      name?: string
      detached?: boolean
    }) {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") {
        return yield* new NotGitError({ message: "Worktrees are only supported for git projects" })
      }

      const root = pathSvc.join(Global.Path.data, "worktree", ctx.project.id)
      yield* fs.makeDirectory(root, { recursive: true }).pipe(Effect.orDie)

      return yield* candidate({ root, name: input?.name ? slugify(input.name) : "", detached: input?.detached })
    })

    const setup = Effect.fnUntraced(function* (info: Info) {
      const ctx = yield* InstanceState.context
      const created = yield* git(
        info.branch
          ? ["worktree", "add", "--no-checkout", "-b", info.branch, info.directory]
          : ["worktree", "add", "--no-checkout", "--detach", info.directory, "HEAD"],
        { cwd: ctx.worktree },
      )
      if (created.code !== 0) {
        return yield* new CreateFailedError({
          message: created.stderr || created.text || "Failed to create git worktree",
        })
      }

      yield* project.addSandbox(ctx.project.id, info.directory).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("worktree persistence failed", {
            projectID: ctx.project.id,
            directory: info.directory,
            cause,
          }),
        ),
      )
    })

    const boot = Effect.fnUntraced(function* (info: Info, startCommand?: string, owner?: ProjectV2.ID) {
      const ctx = yield* InstanceState.context
      const workspaceID = yield* InstanceState.workspaceID
      const projectID = owner ?? ctx.project.id
      const extra = startCommand?.trim()

      const populated = yield* git(["reset", "--hard"], { cwd: info.directory })
      if (populated.code !== 0) {
        const message = populated.stderr || populated.text || "Failed to populate worktree"
        yield* Effect.logError("worktree checkout failed", { directory: info.directory, message })
        GlobalBus.emit("event", {
          directory: info.directory,
          project: projectID,
          workspace: workspaceID,
          payload: { type: Event.Failed.type, properties: { message } },
        })
        return
      }

      const booted = yield* store.load({ directory: info.directory }).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.gen(function* () {
            const message = errorMessage(error)
            yield* Effect.logError("worktree bootstrap failed", { directory: info.directory, message })
            GlobalBus.emit("event", {
              directory: info.directory,
              project: projectID,
              workspace: workspaceID,
              payload: { type: Event.Failed.type, properties: { message } },
            })
            return false
          }),
        ),
      )
      if (!booted) return

      GlobalBus.emit("event", {
        directory: info.directory,
        project: projectID,
        workspace: workspaceID,
        payload: {
          type: Event.Ready.type,
          properties: { name: info.name, ...(info.branch ? { branch: info.branch } : {}) },
        },
      })

      yield* runStartScripts(info.directory, { projectID, extra })
    })

    const loadWorkspaceInfo = Effect.fnUntraced(function* (target: string, opts?: { cwd?: string }) {
      const info = yield* workspace(["info", "--json", "--workspace", target], { ...opts, timeout: "10 seconds" })
      if (info.code !== 0) return undefined
      return yield* Effect.try({
        try: () => {
          const data = JSON.parse(info.text || "{}") as unknown
          if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid workspace info")
          return data as WorkspaceCliInfo
        },
        catch: (cause) =>
          new ListFailedError({ message: cause instanceof Error ? cause.message : "Failed to parse workspace info" }),
      })
    })

    const workspaceListLock = Semaphore.makeUnsafe(1)
    const listWorkspacesUncached = Effect.fnUntraced(function* () {
      const result = yield* workspace(["list", "--json", "--verbose"], { timeout: "10 seconds" })
      if (result.code !== 0) {
        return yield* new ListFailedError({
          message: result.stderr || result.text || "Failed to list workspaces",
        })
      }
      return yield* Effect.try({
        try: () => {
          const data = JSON.parse(result.text || "[]") as unknown
          if (!Array.isArray(data)) throw new Error("Invalid workspace list")
          return data as WorkspaceCliInfo[]
        },
        catch: (cause) =>
          new ListFailedError({ message: cause instanceof Error ? cause.message : "Failed to parse workspace list" }),
      })
    }, workspaceListLock.withPermits(1))
    const [listWorkspaces, invalidateWorkspaceList] = yield* Effect.cachedInvalidateWithTTL(
      listWorkspacesUncached(),
      Duration.seconds(1),
    )
    const mutateWorkspace = Effect.fnUntraced(function* (args: string[], opts?: { cwd?: string }) {
      const result = yield* workspace(args, { ...opts, timeout: "5 minutes" })
      if (result.code === 0) yield* invalidateWorkspaceList
      return result
    }, workspaceListLock.withPermits(1))

    const workspaceEntries = Effect.fnUntraced(function* (data: WorkspaceCliInfo) {
      return yield* Effect.forEach(data.folders ?? [], (folder) =>
        Effect.gen(function* () {
          if (!data.path || !folder.folder) return undefined
          const directory = yield* canonical(pathSvc.join(data.path, folder.folder))
          const source = folder.source ? yield* canonical(folder.source) : undefined
          return {
            name: folder.folder,
            directory,
            description: data.name,
            root: data.path,
            source,
            workspacePath: data.path,
            ...(folder.branch ? { branch: folder.branch } : {}),
          }
        }),
      ).pipe(Effect.map((items) => items.filter((item) => item !== undefined)))
    })

    const allWorkspaceEntries = Effect.fnUntraced(function* () {
      const workspaces = yield* listWorkspaces
      return yield* Effect.forEach(workspaces, workspaceEntries).pipe(Effect.map((items) => items.flat()))
    })

    const workspaceFolderInfo = Effect.fnUntraced(function* (
      name: string,
      input?: { branch?: string; exclude?: string[] },
    ) {
      const ctx = yield* InstanceState.context
      const data = yield* loadWorkspaceInfo(name)
      if (!data) return undefined
      const source = yield* canonical(ctx.project.worktree)
      const excluded = new Set(input?.exclude ?? [])
      const entries = yield* workspaceEntries(data)
      const entry =
        entries.find(
          (item) => item.source === source && item.branch === input?.branch && !excluded.has(item.directory),
        ) ?? entries.find((item) => item.source === source && !excluded.has(item.directory))
      if (!entry) return undefined
      return entry satisfies Info
    })

    const createFeatureWorkspace = Effect.fn("Worktree.createFeatureWorkspace")(function* (
      input: CreateInput & { name: string },
    ) {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") {
        return yield* new NotGitError({ message: "Worktrees are only supported for git projects" })
      }

      const name = slugify(input.name)
      if (!name)
        return yield* new NameGenerationFailedError({ message: "Feature name must include letters or numbers" })

      const existing = yield* loadWorkspaceInfo(name)
      const existingFolders = existing ? yield* workspaceEntries(existing) : []
      const created = existing
        ? yield* mutateWorkspace(
            ["add", ctx.project.worktree, "--workspace", name, "--branch", name, "--background-setup"],
            {
              cwd: ctx.worktree,
            },
          )
        : yield* mutateWorkspace(["create", input.name, ctx.project.worktree, "--branch", name, "--background-setup"], {
            cwd: ctx.worktree,
          })

      if (created.code !== 0) {
        return yield* new CreateFailedError({ message: created.stderr || created.text || "Failed to create workspace" })
      }

      const info = yield* workspaceFolderInfo(name, {
        branch: existing ? undefined : name,
        exclude: existingFolders.map((folder) => folder.directory),
      })
      if (!info) return yield* new CreateFailedError({ message: "Failed to read workspace folder information" })

      const createdInfo = { ...info, name, description: input.name, branch: info.branch ?? name }
      const ownerID = yield* project.fromDirectory(info.workspacePath).pipe(
        Effect.map((owner) => owner.project.id),
        Effect.catchCause((cause) =>
          canonical(info.workspacePath).pipe(
            Effect.map((root) => ProjectV2.ID.make(`feature:${root}`)),
            Effect.tap(() =>
              Effect.logWarning("workspace project admission failed", { directory: info.workspacePath, cause }),
            ),
          ),
        ),
      )
      yield* project.addSandbox(ownerID, createdInfo.directory).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("workspace persistence failed", {
            projectID: ownerID,
            directory: createdInfo.directory,
            cause,
          }),
        ),
      )
      yield* boot(createdInfo, input.startCommand, ownerID).pipe(
        Effect.catchCause((cause) => Effect.logError("workspace bootstrap failed", { cause })),
        Effect.forkIn(scope),
      )
      return createdInfo
    })

    const createWorkspaceOnly = Effect.fn("Worktree.createWorkspaceOnly")(function* (
      input: CreateInput & { name: string },
    ) {
      const displayName = input.name.trim()
      const name = slugify(displayName)
      if (!name)
        return yield* new NameGenerationFailedError({ message: "Workspace name must include letters or numbers" })

      const created = yield* mutateWorkspace(["create", displayName, "--background-setup"])
      if (created.code !== 0) {
        return yield* new CreateFailedError({ message: created.stderr || created.text || "Failed to create workspace" })
      }

      const info = yield* loadWorkspaceInfo(name)
      if (!info?.path) return yield* new CreateFailedError({ message: "Failed to read workspace information" })

      return { name: info.name ?? name, description: displayName, directory: info.path } satisfies Info
    })

    const createFromInfo = Effect.fn("Worktree.createFromInfo")(function* (info: Info, startCommand?: string) {
      yield* setup(info)
      yield* boot(info, startCommand).pipe(
        Effect.catchCause((cause) => Effect.logError("worktree bootstrap failed", { cause })),
        Effect.forkIn(scope),
      )
    })

    const create = Effect.fn("Worktree.create")(function* (input?: CreateInput) {
      if (input?.workspaceOnly) return yield* createWorkspaceOnly({ ...input, name: input.name ?? Slug.create() })
      return yield* createFeatureWorkspace({ ...input, name: input?.name ?? Slug.create() })
    })

    const canonical = Effect.fnUntraced(function* (input: string) {
      const abs = pathSvc.resolve(input)
      const real = yield* fs.realPath(abs).pipe(Effect.catch(() => Effect.succeed(abs)))
      const normalized = pathSvc.normalize(real)
      return process.platform === "win32" ? normalized.toLowerCase() : normalized
    })

    function parseWorktreeList(text: string) {
      return text
        .split("\n")
        .map((line) => line.trim())
        .reduce<{ path?: string; branch?: string }[]>((result, line) => {
          if (!line) return result
          if (line.startsWith("worktree ")) {
            result.push({ path: line.slice("worktree ".length).trim() })
            return result
          }
          const current = result[result.length - 1]
          if (current && line.startsWith("branch ")) current.branch = line.slice("branch ".length).trim()
          return result
        }, [])
    }

    const locateGitWorktree = Effect.fnUntraced(function* (
      entries: { path?: string; branch?: string }[],
      directory: string,
    ) {
      for (const item of entries) {
        if (!item.path) continue
        if ((yield* canonical(item.path)) === directory) return item
      }
      return undefined
    })

    const featureRootForDirectory = Effect.fnUntraced(function* (directory: string) {
      const start = yield* canonical(directory)
      const visit = (current: string): Effect.Effect<string | undefined> =>
        fs.exists(pathSvc.join(current, ".workspace")).pipe(
          Effect.orDie,
          Effect.flatMap((exists) => {
            if (exists) return Effect.succeed(current)
            const parent = pathSvc.dirname(current)
            if (parent === current) return Effect.succeed(undefined)
            return visit(parent)
          }),
        )
      return yield* visit(start)
    })

    const listGitWorktrees = Effect.fnUntraced(function* () {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") return []
      const result = yield* git(["worktree", "list", "--porcelain"], { cwd: ctx.worktree })
      if (result.code !== 0) {
        return yield* new ListFailedError({ message: result.stderr || result.text || "Failed to read git worktrees" })
      }
      const primary = yield* canonical(ctx.project.worktree)
      const primaryName = pathSvc.basename(primary).toLowerCase()
      return yield* Effect.forEach(parseWorktreeList(result.text), (entry) =>
        Effect.gen(function* () {
          if (!entry.path) return undefined
          const directory = yield* canonical(entry.path)
          if (directory === primary) return undefined
          const featureRoot = yield* featureRootForDirectory(directory)
          if (featureRoot && featureRoot !== primary) return undefined
          const name = pathSvc.basename(directory).toLowerCase()
          return {
            name: name === primaryName ? pathSvc.basename(pathSvc.dirname(directory)) : name,
            directory,
            ...(entry.branch ? { branch: entry.branch.replace(/^refs\/heads\//, "") } : {}),
          }
        }),
      ).pipe(Effect.map((items) => items.filter((item) => item !== undefined)))
    })

    const stopFsmonitor = Effect.fnUntraced(function* (directory: string) {
      if (!(yield* fs.exists(directory).pipe(Effect.orDie))) return
      yield* git(["fsmonitor--daemon", "stop"], { cwd: directory })
    })

    const cleanWorktreeDirectory = Effect.fnUntraced(function* (directory: string) {
      if (!(yield* fs.exists(directory).pipe(Effect.orDie))) return
      yield* fs
        .remove(directory, { recursive: true })
        .pipe(
          Effect.mapError(
            (error) =>
              new RemoveFailedError({ message: errorMessage(error) || "Failed to remove git worktree directory" }),
          ),
        )
    })

    const workspaceInventory = Effect.fnUntraced(function* () {
      const ctx = yield* InstanceState.context
      const root = yield* canonical(ctx.project.worktree)
      const workspaces = yield* listWorkspaces
      const data = yield* Effect.forEach(workspaces, (item) =>
        item.path
          ? canonical(item.path).pipe(Effect.map((directory) => (directory === root ? item : undefined)))
          : Effect.succeed(undefined),
      )
      const match = data.find((item) => item !== undefined)
      const entries = match ? yield* workspaceEntries(match) : []
      yield* syncSandboxes(entries)
      return entries
    })

    const syncSandboxes = Effect.fnUntraced(function* (entries: readonly { directory: string }[]) {
      const ctx = yield* InstanceState.context
      const current = yield* project.get(ctx.project.id)
      const directories = new Set(entries.map((entry) => entry.directory))
      yield* Effect.forEach(entries, (entry) =>
        current?.sandboxes.includes(entry.directory)
          ? Effect.void
          : project.addSandbox(ctx.project.id, entry.directory),
      )
      yield* Effect.forEach(current?.sandboxes ?? [], (directory) =>
        directories.has(directory) ? Effect.void : project.removeSandbox(ctx.project.id, directory),
      )
    })

    const list = Effect.fn("Worktree.list")(function* () {
      const ctx = yield* InstanceState.context
      if (ctx.project.id.startsWith("feature:")) return yield* workspaceInventory()

      const worktrees = yield* listGitWorktrees()
      if (ctx.project.vcs !== "git") return worktrees
      const source = yield* canonical(ctx.project.worktree)
      const entries = yield* allWorkspaceEntries().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("workspace membership listing failed", { projectID: ctx.project.id, cause }).pipe(
            Effect.as(undefined),
          ),
        ),
      )
      const memberships = entries?.filter((entry) => entry.source === source) ?? []
      const result = [...memberships, ...worktrees].filter(
        (entry, index, items) => items.findIndex((item) => item.directory === entry.directory) === index,
      )
      if (entries) yield* syncSandboxes(result)
      return result
    })

    const workspaceFolder = Effect.fnUntraced(function* (directory: string) {
      const ctx = yield* InstanceState.context
      const target = yield* canonical(directory)
      if (ctx.project.id.startsWith("feature:")) {
        const entries = yield* workspaceInventory()
        return entries.find((entry) => entry.directory === target)
      }
      const source = yield* canonical(ctx.project.worktree)
      const entries = yield* allWorkspaceEntries()
      return entries.find((entry) => entry.directory === target && entry.source === source)
    })

    const workspacePathForDirectory = Effect.fnUntraced(function* (directory: string) {
      const target = yield* canonical(directory)
      const ctx = yield* InstanceState.context
      const info = yield* loadWorkspaceInfo(directory, { cwd: directory })
      if (info?.path && (yield* canonical(info.path)) === target && (yield* canonical(ctx.project.worktree)) === target)
        return info.path
      const folder = yield* workspaceFolder(directory)
      return folder?.workspacePath
    })

    const rename = Effect.fn("Worktree.rename")(function* (input: RenameInput) {
      const name = input.name.trim()
      if (!name) return yield* new RenameFailedError({ message: "Workspace name is required" })

      const workspacePath = yield* workspacePathForDirectory(input.directory).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )
      if (!workspacePath) return yield* new RenameFailedError({ message: "Workspace folder not found" })

      const renamed = yield* mutateWorkspace(["rename", name, "--workspace", workspacePath], { cwd: workspacePath })
      if (renamed.code !== 0) {
        return yield* new RenameFailedError({
          message: renamed.stderr || renamed.text || "Failed to rename workspace",
        })
      }
      return true
    })

    const removeDetailed = Effect.fn("Worktree.removeDetailed")(function* (input: RemoveInput) {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git" && !input.workspaceOnly) {
        return yield* new NotGitError({ message: "Worktrees are only supported for git projects" })
      }

      const directory = yield* canonical(input.directory)
      const primary = yield* canonical(ctx.worktree)
      if (directory === primary) return yield* new RemoveFailedError({ message: "Cannot remove the primary workspace" })

      const folder = yield* workspaceFolder(directory).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (folder) {
        const removed = yield* mutateWorkspace(["rm", folder.name, "--workspace", folder.workspacePath, "--force"], {
          cwd: folder.workspacePath,
        })
        if (removed.code !== 0) {
          return yield* new RemoveFailedError({
            message: removed.stderr || removed.text || "Failed to remove workspace folder",
          })
        }
        yield* store.disposeDirectory(input.directory)
        yield* project
          .removeSandbox(ctx.project.id, directory)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("workspace persistence failed", { projectID: ctx.project.id, directory, cause }),
            ),
          )
        const featureExists = yield* fs.exists(folder.workspacePath).pipe(Effect.orDie)
        return {
          removed: true,
          featureRemoved: !featureExists,
          ...(!featureExists ? { featureDirectory: folder.workspacePath } : {}),
        }
      }

      if (input.workspaceOnly) {
        return yield* new RemoveFailedError({ message: "Workspace folder not found" })
      }

      const featureRoot = yield* featureRootForDirectory(directory)
      if (featureRoot && featureRoot !== (yield* canonical(ctx.project.worktree))) {
        return yield* new RemoveFailedError({ message: "Workspace folder belongs to another project" })
      }

      const worktrees = yield* git(["worktree", "list", "--porcelain"], { cwd: ctx.worktree })
      if (worktrees.code !== 0) {
        return yield* new RemoveFailedError({
          message: worktrees.stderr || worktrees.text || "Failed to list git worktrees",
        })
      }
      const entry = yield* locateGitWorktree(parseWorktreeList(worktrees.text), directory)
      if (!entry?.path) {
        if (!(yield* fs.exists(input.directory).pipe(Effect.orDie))) return { removed: true, featureRemoved: false }
        return yield* new RemoveFailedError({ message: "Directory is not a managed git worktree" })
      }

      yield* stopFsmonitor(entry.path)
      const removed = yield* git(["worktree", "remove", "--force", entry.path], { cwd: ctx.worktree })
      if (removed.code !== 0) {
        const next = yield* git(["worktree", "list", "--porcelain"], { cwd: ctx.worktree })
        const stale = next.code === 0 ? yield* locateGitWorktree(parseWorktreeList(next.text), directory) : entry
        if (stale?.path) {
          return yield* new RemoveFailedError({
            message: removed.stderr || removed.text || next.stderr || next.text || "Failed to remove worktree",
          })
        }
      }
      yield* store.disposeDirectory(entry.path)
      yield* project
        .removeSandbox(ctx.project.id, directory)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("worktree persistence failed", { projectID: ctx.project.id, directory, cause }),
          ),
        )
      yield* cleanWorktreeDirectory(entry.path).pipe(
        Effect.catchCause((cause) => Effect.logWarning("worktree directory cleanup failed", { directory, cause })),
      )
      const branch = entry.branch?.replace(/^refs\/heads\//, "")
      if (branch) {
        const deleted = yield* git(["branch", "-D", branch], { cwd: ctx.worktree })
        if (deleted.code !== 0)
          yield* Effect.logWarning("worktree branch cleanup failed", {
            branch,
            message: deleted.stderr || deleted.text || "Failed to delete worktree branch",
          })
      }
      return { removed: true, featureRemoved: false }
    })

    const remove = Effect.fn("Worktree.remove")(function* (input: RemoveInput) {
      return (yield* removeDetailed(input)).removed
    })

    const gitExpect = Effect.fnUntraced(function* (
      args: string[],
      opts: { cwd: string },
      error: (r: GitResult) => Error,
    ) {
      const result = yield* git(args, opts)
      if (result.code !== 0) return yield* error(result)
      return result
    })

    const runStartCommand = Effect.fnUntraced(
      function* (directory: string, cmd: string) {
        const [shell, args] = process.platform === "win32" ? ["cmd", ["/c", cmd]] : ["bash", ["-lc", cmd]]
        const result = yield* appProcess.run(
          ChildProcess.make(shell, args as string[], { cwd: directory, extendEnv: true, stdin: "ignore" }),
        )
        return { code: result.exitCode, stderr: result.stderr.toString("utf8") }
      },
      Effect.catch(() => Effect.succeed({ code: 1, stderr: "" })),
    )

    const runStartScript = Effect.fnUntraced(function* (directory: string, cmd: string, kind: string) {
      const text = cmd.trim()
      if (!text) return true
      const result = yield* runStartCommand(directory, text)
      if (result.code === 0) return true
      yield* Effect.logError("worktree start command failed", { kind, directory, message: result.stderr })
      return false
    })

    const runStartScripts = Effect.fnUntraced(function* (
      directory: string,
      input: { projectID: ProjectV2.ID; extra?: string },
    ) {
      const row = yield* db
        .select()
        .from(ProjectTable)
        .where(eq(ProjectTable.id, input.projectID))
        .get()
        .pipe(Effect.orDie)
      const project = row ? Project.fromRow(row) : undefined
      const startup = project?.commands?.start?.trim() ?? ""
      const ok = yield* runStartScript(directory, startup, "project")
      if (!ok) return false
      yield* runStartScript(directory, input.extra ?? "", "worktree")
      return true
    })

    const prune = Effect.fnUntraced(function* (root: string, entries: string[]) {
      const base = yield* canonical(root)
      yield* Effect.forEach(
        entries,
        (entry) =>
          Effect.gen(function* () {
            const target = yield* canonical(pathSvc.resolve(root, entry))
            if (target === base) return
            if (!target.startsWith(`${base}${pathSvc.sep}`)) return
            yield* fs.remove(target, { recursive: true }).pipe(Effect.ignore)
          }),
        { concurrency: "unbounded" },
      )
    })

    const sweep = Effect.fnUntraced(function* (root: string) {
      const first = yield* git(["clean", "-ffdx"], { cwd: root })
      if (first.code === 0) return first

      const entries = failedRemoves(first.stderr, first.text)
      if (!entries.length) return first

      yield* prune(root, entries)
      return yield* git(["clean", "-ffdx"], { cwd: root })
    })

    const reset = Effect.fn("Worktree.reset")(function* (input: ResetInput) {
      const ctx = yield* InstanceState.context
      const directory = yield* canonical(input.directory)
      const primary = yield* canonical(ctx.worktree)
      if (directory === primary) {
        return yield* new ResetFailedError({ message: "Cannot reset the primary workspace" })
      }

      const folder = yield* workspaceFolder(directory).pipe(Effect.catch(() => Effect.succeed(undefined)))
      const featureRoot = yield* featureRootForDirectory(directory)
      if (!folder && featureRoot && featureRoot !== (yield* canonical(ctx.project.worktree))) {
        return yield* new ResetFailedError({ message: "Workspace folder belongs to another project" })
      }
      const worktrees = folder ? undefined : yield* git(["worktree", "list", "--porcelain"], { cwd: ctx.worktree })
      if (worktrees && worktrees.code !== 0) {
        return yield* new ResetFailedError({
          message: worktrees.stderr || worktrees.text || "Failed to read git worktrees",
        })
      }
      const gitWorktree = worktrees ? yield* locateGitWorktree(parseWorktreeList(worktrees.text), directory) : undefined
      if (!folder && !gitWorktree?.path) return yield* new ResetFailedError({ message: "Workspace folder not found" })
      const sourcePath = folder?.source ?? ctx.worktree
      const worktreePath = folder?.directory ?? gitWorktree?.path
      if (!worktreePath) return yield* new ResetFailedError({ message: "Workspace folder not found" })

      const base = yield* gitSvc.defaultBranch(sourcePath)
      if (!base) {
        return yield* new ResetFailedError({ message: "Default branch not found" })
      }

      const sep = base.ref.indexOf("/")
      if (base.ref !== base.name && sep > 0) {
        const remote = base.ref.slice(0, sep)
        const branch = base.ref.slice(sep + 1)
        yield* gitExpect(
          ["fetch", remote, branch],
          { cwd: sourcePath },
          (r) => new ResetFailedError({ message: r.stderr || r.text || `Failed to fetch ${base.ref}` }),
        )
      }

      yield* gitExpect(
        ["reset", "--hard", base.ref],
        { cwd: worktreePath },
        (r) => new ResetFailedError({ message: r.stderr || r.text || "Failed to reset worktree to target" }),
      )

      const cleanResult = yield* sweep(worktreePath)
      if (cleanResult.code !== 0) {
        return yield* new ResetFailedError({
          message: cleanResult.stderr || cleanResult.text || "Failed to clean worktree",
        })
      }

      yield* gitExpect(
        ["submodule", "update", "--init", "--recursive", "--force"],
        { cwd: worktreePath },
        (r) => new ResetFailedError({ message: r.stderr || r.text || "Failed to update submodules" }),
      )

      yield* gitExpect(
        ["submodule", "foreach", "--recursive", "git", "reset", "--hard"],
        { cwd: worktreePath },
        (r) => new ResetFailedError({ message: r.stderr || r.text || "Failed to reset submodules" }),
      )

      yield* gitExpect(
        ["submodule", "foreach", "--recursive", "git", "clean", "-fdx"],
        { cwd: worktreePath },
        (r) => new ResetFailedError({ message: r.stderr || r.text || "Failed to clean submodules" }),
      )

      const status = yield* git(["-c", "core.fsmonitor=false", "status", "--porcelain=v1"], { cwd: worktreePath })
      if (status.code !== 0) {
        return yield* new ResetFailedError({ message: status.stderr || status.text || "Failed to read git status" })
      }

      if (status.text.trim()) {
        return yield* new ResetFailedError({ message: `Worktree reset left local changes:\n${status.text.trim()}` })
      }

      yield* runStartScripts(worktreePath, { projectID: ctx.project.id }).pipe(
        Effect.catchCause((cause) => Effect.logError("worktree start task failed", { cause })),
        Effect.forkIn(scope),
      )

      return true
    })

    return Service.of({ makeWorktreeInfo, createFromInfo, create, list, remove, removeDetailed, reset, rename })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, path, AppProcess.node, Git.node, Project.node, InstanceStore.node, Database.node],
})

export * as Worktree from "."
