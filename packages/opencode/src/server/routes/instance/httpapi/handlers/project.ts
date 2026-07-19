import * as InstanceState from "@/effect/instance-state"
import { Project } from "@/project/project"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Process } from "@/util/process"
import { Worktree } from "@/worktree"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ProjectNotFoundError } from "../errors"
import { ProjectPullRequestError, ProjectRenameError } from "../groups/project"
import { markInstanceForReload } from "../lifecycle"
import { errorMessage } from "@/util/error"

export const projectHandlers = HttpApiBuilder.group(InstanceHttpApi, "project", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Project.Service
    const project = yield* ProjectV2.Service
    const worktree = yield* Worktree.Service

    const list = Effect.fn("ProjectHttpApi.list")(function* () {
      return yield* svc.list()
    })

    const current = Effect.fn("ProjectHttpApi.current")(function* () {
      return (yield* InstanceState.context).project
    })

    const initGit = Effect.fn("ProjectHttpApi.initGit")(function* () {
      const ctx = yield* InstanceState.context
      const next = yield* svc.initGit({ directory: ctx.directory, project: ctx.project })
      if (next.id === ctx.project.id && next.vcs === ctx.project.vcs && next.worktree === ctx.project.worktree)
        return next
      yield* markInstanceForReload(ctx, {
        directory: ctx.directory,
        worktree: ctx.directory,
        project: next,
      })
      return next
    })

    const isWorkspaceRoot = (project: Project.Info) => {
      if (project.id.startsWith("feature:")) return true
      const root = `${project.worktree.replace(/\/+$/, "")}/`
      return project.sandboxes.some((directory) => directory.startsWith(root))
    }

    const save = (projectID: ProjectV2.ID, payload: Project.UpdatePayload) =>
      svc.update({ ...payload, projectID }).pipe(
        Effect.catchTag("Project.NotFoundError", (error) =>
          Effect.fail(
            new ProjectNotFoundError({
              projectID: error.projectID,
              message: `Project not found: ${error.projectID}`,
            }),
          ),
        ),
      )

    const update = Effect.fn("ProjectHttpApi.update")(function* (ctx: {
      params: { projectID: ProjectV2.ID }
      payload: Project.UpdatePayload
    }) {
      const current = yield* svc.get(ctx.params.projectID)
      const name = ctx.payload.name?.trim()
      const instance = yield* InstanceState.context
      if (current && name && isWorkspaceRoot(current)) {
        if (instance.directory !== current.worktree && current.sandboxes.includes(instance.directory)) {
          yield* worktree
            .rename({ directory: instance.directory, name })
            .pipe(
              Effect.mapError(
                (error) => new ProjectRenameError({ message: error.message || "Failed to rename workspace" }),
              ),
            )
          return yield* save(ctx.params.projectID, { ...ctx.payload, name: undefined })
        }

        if (instance.directory === current.worktree) {
          yield* worktree
            .rename({ directory: current.worktree, name })
            .pipe(
              Effect.mapError(
                (error) => new ProjectRenameError({ message: error.message || "Failed to rename workspace" }),
              ),
            )
        }
      }

      return yield* save(ctx.params.projectID, ctx.payload)
    })

    const openPullRequest = Effect.fn("ProjectHttpApi.openPullRequest")(function* () {
      const ctx = yield* InstanceState.context
      const result = yield* Effect.tryPromise({
        try: () => Process.text(["pr", "--existing"], { cwd: ctx.directory, nothrow: true }),
        catch: (error) => new ProjectPullRequestError({ message: errorMessage(error) }),
      })
      const output = `${result.text}\n${result.stderr.toString()}`.trim()

      if (result.code === 0) {
        const url = output
          .split(/\s+/)
          .map((value) => value.trim())
          .find((value) => /^https?:\/\//.test(value))
        if (url) return { status: "found" as const, url }
        return yield* new ProjectPullRequestError({ message: "The pr script did not return a PR URL." })
      }

      if (/no\s+(existing|open)\s+(pull\s+request|pr)\s+found/i.test(output)) return { status: "missing" as const }
      return yield* new ProjectPullRequestError({ message: output || "Failed to find an open PR." })
    })

    const directories = Effect.fn("ProjectHttpApi.directories")((ctx: { params: { projectID: ProjectV2.ID } }) =>
      project.directories({ projectID: ctx.params.projectID }),
    )

    return handlers
      .handle("list", list)
      .handle("current", current)
      .handle("initGit", initGit)
      .handle("openPullRequest", openPullRequest)
      .handle("update", update)
      .handle("directories", directories)
  }),
)
