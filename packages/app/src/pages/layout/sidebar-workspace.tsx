import { useNavigate, useParams } from "@solidjs/router"
import { createEffect, createMemo, For, Show, type Accessor, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { createSortable } from "@thisbeyond/solid-dnd"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { getFilename } from "@opencode-ai/core/util/path"
import { Button } from "@opencode-ai/ui/button"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { type Session } from "@opencode-ai/sdk/v2/client"
import { type LocalProject } from "@/context/layout"
import { useServerSync, useQueryOptions } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useNotification } from "@/context/notification"
import { pathKey } from "@/utils/path-key"
import { cancelPendingProjectNavigation } from "@/utils/session-route"
import { NewSessionItem, SessionItem, SessionSkeleton } from "./sidebar-items"
import { displayName, sortedRootSessions } from "./helpers"
import { useIsFetching } from "@tanstack/solid-query"

type InlineEditorComponent = (props: {
  id: string
  value: Accessor<string>
  onSave: (next: string) => void
  class?: string
  displayClass?: string
  editing?: boolean
  stopPropagation?: boolean
  openOnDblClick?: boolean
}) => JSX.Element

export type WorkspaceSidebarContext = {
  currentDir: Accessor<string>
  navList: Accessor<Session[]>
  sidebarExpanded: Accessor<boolean>
  sidebarHovering: Accessor<boolean>
  clearHoverProjectSoon: () => void
  prefetchSession: (session: Session, priority?: "high" | "low") => void
  archiveSession: (session: Session) => Promise<void>
  workspaceName: (directory: string, projectId?: string, branch?: string) => string | undefined
  renameWorkspace: (directory: string, next: string, projectId?: string, branch?: string) => void
  editorOpen: (id: string) => boolean
  openEditor: (id: string, value: string) => void
  closeEditor: () => void
  setEditor: (key: "value", value: string) => void
  InlineEditor: InlineEditorComponent
  isBusy: (directory: string) => boolean
  workspaceExpanded: (directory: string, local: boolean) => boolean
  setWorkspaceExpanded: (directory: string, value: boolean) => void
  showResetWorkspaceDialog: (root: string, directory: string) => void
  showRemoveFromWorkspaceDialog: (root: string, directory: string) => void
  openRemoteVSCode: (directory: string) => void
  copyPath: (directory: string) => void
  canOpenRemoteVSCode: Accessor<boolean>
  setScrollContainerRef: (el: HTMLDivElement | undefined, mobile?: boolean) => void
}

export const WorkspaceDragOverlay = (props: {
  sidebarProject: Accessor<LocalProject | undefined>
  activeWorkspace: Accessor<string | undefined>
  workspaceLabel: (directory: string, branch?: string, projectId?: string) => string
}): JSX.Element => {
  const serverSync = useServerSync()
  const language = useLanguage()
  const label = createMemo(() => {
    const project = props.sidebarProject()
    if (!project) return
    const directory = props.activeWorkspace()
    if (!directory) return

    const [workspaceStore] = serverSync().child(directory, { bootstrap: false })
    const kind =
      directory === project.worktree ? language.t("workspace.type.local") : language.t("workspace.type.sandbox")
    const name = props.workspaceLabel(directory, workspaceStore.vcs?.branch, project.id)
    return `${kind} : ${name}`
  })

  return (
    <Show when={label()}>
      {(value) => <div class="bg-background-base rounded-md px-2 py-1 text-14-medium text-text-strong">{value()}</div>}
    </Show>
  )
}

const WorkspaceHeader = (props: {
  local: Accessor<boolean>
  busy: Accessor<boolean>
  open: Accessor<boolean>
  directory: string
  language: ReturnType<typeof useLanguage>
  branch: Accessor<string | undefined>
  workspaceValue: Accessor<string>
  workspaceEditActive: Accessor<boolean>
  InlineEditor: WorkspaceSidebarContext["InlineEditor"]
  renameWorkspace: WorkspaceSidebarContext["renameWorkspace"]
  setEditor: WorkspaceSidebarContext["setEditor"]
  projectId?: string
  feature?: boolean
  featureName?: string
  unseenCount: Accessor<number>
  hasError: Accessor<boolean>
}): JSX.Element => (
  <div class="flex items-center gap-1 min-w-0 flex-1">
    <div class="flex items-center justify-center shrink-0 size-6">
      <Show when={props.busy()} fallback={<Icon name="branch" size="small" />}>
        <Spinner class="size-[15px]" />
      </Show>
    </div>
    <Show when={props.local() && !props.feature}>
      <span class="text-14-medium text-text-base shrink-0">{props.language.t("workspace.type.local")} :</span>
    </Show>
    <Show
      when={!props.local() && !props.feature}
      fallback={
        <span class="text-14-medium text-text-base min-w-0 truncate">
          {props.feature
            ? props.local()
              ? props.featureName
              : getFilename(props.directory)
            : (props.branch() ?? getFilename(props.directory))}
        </span>
      }
    >
      <props.InlineEditor
        id={`workspace:${props.directory}`}
        value={props.workspaceValue}
        onSave={(next) => {
          const trimmed = next.trim()
          if (!trimmed) return
          props.renameWorkspace(props.directory, trimmed, props.projectId, props.branch())
          props.setEditor("value", props.workspaceValue())
        }}
        class="text-14-medium text-text-base min-w-0 truncate"
        displayClass="text-14-medium text-text-base min-w-0 truncate"
        editing={props.workspaceEditActive()}
        stopPropagation={false}
        openOnDblClick={false}
      />
    </Show>
    <div class="flex items-center justify-center shrink-0 overflow-hidden w-0 opacity-0 transition-all duration-200 group-hover/workspace:w-3.5 group-hover/workspace:opacity-100 group-focus-within/workspace:w-3.5 group-focus-within/workspace:opacity-100">
      <Icon name={props.open() ? "chevron-down" : "chevron-right"} size="small" class="text-icon-base" />
    </div>
    <Show when={props.unseenCount() > 0}>
      <div
        class="size-1.5 rounded-full shrink-0"
        classList={{
          "bg-text-diff-delete-base": props.hasError(),
          "bg-text-interactive-base": !props.hasError(),
        }}
      />
    </Show>
  </div>
)

const WorkspaceActions = (props: {
  directory: string
  local: Accessor<boolean>
  busy: Accessor<boolean>
  menuOpen: Accessor<boolean>
  setMenuOpen: (open: boolean) => void
  sidebarHovering: Accessor<boolean>
  language: ReturnType<typeof useLanguage>
  showRemoveFromWorkspaceDialog: WorkspaceSidebarContext["showRemoveFromWorkspaceDialog"]
  ctx: WorkspaceSidebarContext
  root: string
  clearHoverProjectSoon: WorkspaceSidebarContext["clearHoverProjectSoon"]
  navigateToNewSession: () => void
}): JSX.Element => (
  <div class="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-100 pointer-events-auto">
    <DropdownMenu
      modal={!props.sidebarHovering()}
      open={props.menuOpen()}
      onOpenChange={(open) => props.setMenuOpen(open)}
    >
      <Tooltip value={props.language.t("common.moreOptions")} placement="top">
        <DropdownMenu.Trigger
          as={IconButton}
          icon="dot-grid"
          variant="ghost"
          class="size-6 rounded-md"
          data-action="workspace-menu"
          data-workspace={base64Encode(props.directory)}
          aria-label={props.language.t("common.moreOptions")}
        />
      </Tooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content>
          <DropdownMenu.Item
            onSelect={() => {
              props.clearHoverProjectSoon()
              props.navigateToNewSession()
            }}
          >
            <DropdownMenu.ItemLabel>{props.language.t("command.session.new")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => props.ctx.copyPath(props.directory)}>
            <DropdownMenu.ItemLabel>{props.language.t("session.header.open.copyPath")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item
            onSelect={() => props.ctx.openRemoteVSCode(props.directory)}
            disabled={!props.ctx.canOpenRemoteVSCode()}
          >
            <DropdownMenu.ItemLabel>
              {props.language.t("session.header.open.ariaLabel", {
                app: props.language.t("session.header.open.app.vscode"),
              })}
            </DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item
            disabled={props.local() || props.busy()}
            onSelect={() => props.showRemoveFromWorkspaceDialog(props.root, props.directory)}
          >
            <DropdownMenu.ItemLabel>{props.language.t("workspace.removeFromWorkspace.menu")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  </div>
)

const WorkspaceSessionList = (props: {
  slug: Accessor<string>
  directory: string
  mobile?: boolean
  ctx: WorkspaceSidebarContext
  root: string
  showNew: Accessor<boolean>
  loading: Accessor<boolean>
  sessions: Accessor<Session[]>
  hasMore: Accessor<boolean>
  loadMore: () => Promise<void>
  language: ReturnType<typeof useLanguage>
}): JSX.Element => (
  <nav class="flex flex-col gap-1">
    <Show when={props.showNew()}>
      <NewSessionItem
        slug={props.slug()}
        directory={props.directory}
        root={props.root}
        mobile={props.mobile}
        sidebarExpanded={props.ctx.sidebarExpanded}
        clearHoverProjectSoon={props.ctx.clearHoverProjectSoon}
      />
    </Show>
    <Show when={props.loading()}>
      <SessionSkeleton />
    </Show>
    <For each={props.sessions()}>
      {(session) => (
        <SessionItem
          session={session}
          list={props.sessions()}
          navList={props.ctx.navList}
          slug={props.slug()}
          root={props.root}
          mobile={props.mobile}
          showChild
          sidebarExpanded={props.ctx.sidebarExpanded}
          clearHoverProjectSoon={props.ctx.clearHoverProjectSoon}
          prefetchSession={props.ctx.prefetchSession}
          archiveSession={props.ctx.archiveSession}
        />
      )}
    </For>
    <Show when={props.hasMore()}>
      <div class="relative w-full py-1">
        <Button
          variant="ghost"
          class="flex w-full text-left justify-start text-14-regular text-text-weak pl-2 pr-10"
          size="large"
          onClick={(e: MouseEvent) => {
            void props.loadMore()
            ;(e.currentTarget as HTMLButtonElement).blur()
          }}
        >
          {props.language.t("common.loadMore")}
        </Button>
      </div>
    </Show>
  </nav>
)

const draftTitlePattern = /^(New session|Child session) - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function hasTokenUsage(session: Session) {
  const tokens = session.tokens
  if (!tokens) return false
  return (
    tokens.input > 0 || tokens.output > 0 || tokens.reasoning > 0 || tokens.cache.read > 0 || tokens.cache.write > 0
  )
}

export const SortableWorkspace = (props: {
  ctx: WorkspaceSidebarContext
  directory: string
  project: LocalProject
  sortNow: Accessor<number>
  mobile?: boolean
}): JSX.Element => {
  const navigate = useNavigate()
  const params = useParams()
  const serverSync = useServerSync()
  const queryOptions = useQueryOptions()
  const language = useLanguage()
  const notification = useNotification()
  const sortable = createSortable(props.directory)
  const [workspaceStore, setWorkspaceStore] = serverSync().child(props.directory, { bootstrap: false })
  const [menu, setMenu] = createStore({
    open: false,
  })
  const slug = createMemo(() => base64Encode(props.directory))
  const sessions = createMemo(() => sortedRootSessions(workspaceStore, props.sortNow()))
  const visibleSessions = createMemo(() =>
    sessions().filter((session) => {
      const sessionStore = serverSync().session.data
      const messages = sessionStore.message[session.id]
      const emptyDraft =
        messages !== undefined &&
        messages.length === 0 &&
        draftTitlePattern.test(session.title) &&
        (session.cost ?? 0) === 0 &&
        !hasTokenUsage(session) &&
        !session.summary
      return !emptyDraft || sessionStore.session_working(session.id)
    }),
  )
  const local = createMemo(() => props.directory === props.project.worktree)
  const active = createMemo(() => pathKey(props.ctx.currentDir()) === pathKey(props.directory))
  const workspaceValue = createMemo(() => {
    const branch = workspaceStore.vcs?.branch
    const name = branch ?? getFilename(props.directory)
    return props.ctx.workspaceName(props.directory, props.project.id, branch) ?? name
  })
  const open = createMemo(() => props.ctx.workspaceExpanded(props.directory, local()))
  const count = createMemo(() => visibleSessions().length)
  const hasMore = createMemo(() => workspaceStore.sessionTotal > sessions().length)
  const fetching = useIsFetching(() => queryOptions().sessions(pathKey(props.directory)))
  const busy = createMemo(() => props.ctx.isBusy(props.directory))
  const unseenCount = createMemo(() => notification.project.unseenCount(props.directory))
  const hasError = createMemo(() => notification.project.unseenHasError(props.directory))
  const loading = () => count() === 0 && (!workspaceStore.sessionLoaded || fetching() > 0)
  const showNew = createMemo(() => !loading() && (count() === 0 || (active() && !params.id)))
  const loadMore = async () => {
    setWorkspaceStore("limit", (limit) => (limit ?? 0) + 5)
    await serverSync().project.loadSessions(props.directory)
  }

  const workspaceEditActive = createMemo(() => props.ctx.editorOpen(`workspace:${props.directory}`))
  const header = () => (
    <WorkspaceHeader
      local={local}
      busy={busy}
      open={open}
      directory={props.directory}
      language={language}
      branch={() => workspaceStore.vcs?.branch}
      workspaceValue={workspaceValue}
      workspaceEditActive={workspaceEditActive}
      InlineEditor={props.ctx.InlineEditor}
      renameWorkspace={props.ctx.renameWorkspace}
      setEditor={props.ctx.setEditor}
      projectId={props.project.id}
      feature={props.project.id?.startsWith("feature:")}
      featureName={displayName(props.project)}
      unseenCount={unseenCount}
      hasError={hasError}
    />
  )

  const openWrapper = (value: boolean) => {
    props.ctx.setWorkspaceExpanded(props.directory, value)
    if (value) return
    if (props.ctx.editorOpen(`workspace:${props.directory}`)) props.ctx.closeEditor()
  }

  const navigateToNewSession = () => {
    cancelPendingProjectNavigation()
    navigate(`/${slug()}/session?root=${base64Encode(props.project.worktree)}`)
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('[data-component="prompt-input"]')?.focus()
    })
  }

  createEffect(() => {
    if (active()) {
      serverSync().child(props.directory, { bootstrap: true })
      return
    }
    if (!open()) return
    void serverSync().project.loadSessions(props.directory)
  })

  const workspaceRow = (trigger: boolean) => (
    <div class="py-1">
      <div
        class="group/workspace relative"
        data-component="workspace-item"
        data-workspace={base64Encode(props.directory)}
      >
        <div class="flex items-center gap-1">
          <Show
            when={workspaceEditActive()}
            fallback={
              <Show
                when={trigger}
                fallback={
                  <div
                    class={`flex items-center justify-between w-full pl-2 py-1.5 rounded-md transition-[padding] duration-200 ${
                      menu.open ? "pr-16" : "pr-10"
                    } group-hover/workspace:pr-16 group-focus-within/workspace:pr-16`}
                  >
                    {header()}
                  </div>
                }
              >
                <Collapsible.Trigger
                  class={`flex items-center justify-between w-full pl-2 py-1.5 rounded-md hover:bg-surface-raised-base-hover transition-[padding] duration-200 ${
                    menu.open ? "pr-16" : "pr-10"
                  } group-hover/workspace:pr-16 group-focus-within/workspace:pr-16`}
                  data-action="workspace-toggle"
                  data-workspace={base64Encode(props.directory)}
                >
                  {header()}
                </Collapsible.Trigger>
              </Show>
            }
          >
            <div
              class={`flex items-center justify-between w-full pl-2 py-1.5 rounded-md transition-[padding] duration-200 ${
                menu.open ? "pr-16" : "pr-10"
              } group-hover/workspace:pr-16 group-focus-within/workspace:pr-16`}
            >
              {header()}
            </div>
          </Show>
          <WorkspaceActions
            directory={props.directory}
            local={local}
            busy={busy}
            menuOpen={() => menu.open}
            setMenuOpen={(open) => setMenu("open", open)}
            sidebarHovering={props.ctx.sidebarHovering}
            language={language}
            showRemoveFromWorkspaceDialog={props.ctx.showRemoveFromWorkspaceDialog}
            ctx={props.ctx}
            root={props.project.worktree}
            clearHoverProjectSoon={props.ctx.clearHoverProjectSoon}
            navigateToNewSession={navigateToNewSession}
          />
        </div>
      </div>
    </div>
  )

  return (
    <div
      // @ts-ignore
      use:sortable
      classList={{
        "opacity-30": sortable.isActiveDraggable,
        "opacity-50 pointer-events-none": busy(),
      }}
    >
      <Collapsible variant="ghost" open={open()} class="shrink-0" onOpenChange={openWrapper}>
        {workspaceRow(true)}
        <Collapsible.Content>
          <WorkspaceSessionList
            slug={slug}
            directory={props.directory}
            mobile={props.mobile}
            ctx={props.ctx}
            root={props.project.worktree}
            showNew={showNew}
            loading={loading}
            sessions={visibleSessions}
            hasMore={hasMore}
            loadMore={loadMore}
            language={language}
          />
        </Collapsible.Content>
      </Collapsible>
    </div>
  )
}

export const LocalWorkspaceSessions = (props: {
  ctx: WorkspaceSidebarContext
  project: LocalProject
  sortNow: Accessor<number>
  mobile?: boolean
}): JSX.Element => {
  const serverSync = useServerSync()
  const queryOptions = useQueryOptions()
  const language = useLanguage()
  const workspace = createMemo(() => {
    const [store, setStore] = serverSync().child(props.project.worktree)
    return { store, setStore }
  })
  const slug = createMemo(() => base64Encode(props.project.worktree))
  const sessions = createMemo(() => sortedRootSessions(workspace().store, props.sortNow()))
  const count = createMemo(() => sessions()?.length ?? 0)
  const fetching = useIsFetching(() => queryOptions().sessions(pathKey(props.project.worktree)))
  const hasMore = createMemo(() => workspace().store.sessionTotal > count())
  const loading = () => fetching() > 0 && count() === 0
  const loadMore = async () => {
    workspace().setStore("limit", (limit) => (limit ?? 0) + 5)
    await serverSync().project.loadSessions(props.project.worktree)
  }

  return (
    <Show when={loading() || count() > 0 || hasMore()}>
      <WorkspaceSessionList
        slug={slug}
        directory={props.project.worktree}
        mobile={props.mobile}
        ctx={props.ctx}
        root={props.project.worktree}
        showNew={() => false}
        loading={loading}
        sessions={sessions}
        hasMore={hasMore}
        loadMore={loadMore}
        language={language}
      />
    </Show>
  )
}

export const LocalWorkspace = (props: {
  ctx: WorkspaceSidebarContext
  project: LocalProject
  sortNow: Accessor<number>
  mobile?: boolean
}): JSX.Element => {
  return (
    <div
      ref={(el) => props.ctx.setScrollContainerRef(el, props.mobile)}
      class="size-full flex flex-col py-2 overflow-y-auto no-scrollbar [overflow-anchor:none]"
    >
      <LocalWorkspaceSessions {...props} />
    </div>
  )
}
