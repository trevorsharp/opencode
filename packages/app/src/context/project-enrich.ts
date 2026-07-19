import type { Project } from "@opencode-ai/sdk/v2"
import type { ProjectMeta } from "./global-sync/types"
import { pathKey } from "@/utils/path-key"

export function mergeProjectMetadata(
  metadata: Project | undefined,
  project: { worktree: string; expanded: boolean },
  projectMeta: ProjectMeta | undefined,
) {
  if (metadata?.id === "global") return { ...metadata, name: projectMeta?.name, ...project }
  if (metadata && pathKey(metadata.worktree) !== pathKey(project.worktree)) return { ...project }
  return { ...metadata, ...project }
}
