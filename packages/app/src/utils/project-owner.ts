import { pathKey } from "@/utils/path-key"

export type OwnableProject = { id?: string; worktree: string; sandboxes?: string[] }

export const isWorkspaceContainer = (project: { id?: string } | undefined) => !!project?.id?.startsWith("feature:")

// A workspace member is a Git worktree of its source checkout, so both the source project (which
// shares the member's Git identity) and the workspace container claim the same directory through
// their sandboxes. Resolve that ambiguity identically everywhere: a project whose own worktree is
// the directory owns it, then the workspace container that claims it, then any other claimant.
export function owningContainer<T extends OwnableProject>(projects: readonly T[], directory: string) {
  const key = pathKey(directory)
  let workspace: T | undefined
  let claimant: T | undefined

  for (const project of projects) {
    if (pathKey(project.worktree) === key) return project
    if (!project.sandboxes?.some((sandbox) => pathKey(sandbox) === key)) continue
    if (isWorkspaceContainer(project)) workspace ??= project
    else claimant ??= project
  }

  return workspace ?? claimant
}
