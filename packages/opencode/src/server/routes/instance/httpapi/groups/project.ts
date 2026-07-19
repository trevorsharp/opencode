import { Project } from "@/project/project"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ProjectNotFoundError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/project"
const UpdatePayload = Schema.Struct({
  name: Schema.optional(Schema.String),
  icon: Schema.optional(Project.Info.fields.icon),
  commands: Schema.optional(Project.Info.fields.commands),
})
export const ProjectPullRequestResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("found"),
    url: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("missing"),
  }),
])
export class ProjectPullRequestError extends Schema.ErrorClass<ProjectPullRequestError>("ProjectPullRequestError")(
  {
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}
export class ProjectRenameError extends Schema.ErrorClass<ProjectRenameError>("ProjectRenameError")(
  {
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

export const ProjectApi = HttpApi.make("project")
  .add(
    HttpApiGroup.make("project")
      .add(
        HttpApiEndpoint.get("list", root, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Project.Info), "List of projects"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.list",
            summary: "List all projects",
            description: "Get a list of projects that have been opened with OpenCode.",
          }),
        ),
        HttpApiEndpoint.get("current", `${root}/current`, {
          query: WorkspaceRoutingQuery,
          success: described(Project.Info, "Current project information"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.current",
            summary: "Get current project",
            description: "Retrieve the currently active project that OpenCode is working with.",
          }),
        ),
        HttpApiEndpoint.post("initGit", `${root}/git/init`, {
          query: WorkspaceRoutingQuery,
          success: described(Project.Info, "Project information after git initialization"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.initGit",
            summary: "Initialize git repository",
            description: "Create a git repository for the current project and return the refreshed project info.",
          }),
        ),
        HttpApiEndpoint.post("openPullRequest", `${root}/pr/open`, {
          query: WorkspaceRoutingQuery,
          success: described(ProjectPullRequestResult, "Open pull request lookup result"),
          error: [ProjectPullRequestError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.open_pull_request",
            summary: "Find open pull request",
            description: "Find an existing pull request for the current branch using the configured pr script.",
          }),
        ),
        HttpApiEndpoint.patch("update", `${root}/:projectID`, {
          params: { projectID: ProjectV2.ID },
          query: WorkspaceRoutingQuery,
          payload: UpdatePayload,
          success: described(Project.Info, "Updated project information"),
          error: [HttpApiError.BadRequest, ProjectNotFoundError, ProjectRenameError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.update",
            summary: "Update project",
            description: "Update project properties such as name, icon, and commands.",
          }),
        ),
        HttpApiEndpoint.get("directories", `${root}/:projectID/directories`, {
          params: { projectID: ProjectV2.ID },
          query: WorkspaceRoutingQuery,
          success: described(ProjectV2.Directories, "Project directories"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.directories",
            summary: "List project directories",
            description: "List known local absolute directories for a project.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "project",
          description: "Experimental HttpApi project routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
