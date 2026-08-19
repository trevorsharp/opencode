import {
  createEffect,
  createMemo,
  createResource,
  For,
  on,
  onCleanup,
  onMount,
  ParentProps,
  Show,
  untrack,
  type Accessor,
} from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createMediaQuery } from "@solid-primitives/media"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { useLayout, LocalProject } from "@/context/layout"
import { useServerSync } from "@/context/server-sync"
import { Persist, persisted } from "@/utils/persist"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { decode64 } from "@/utils/base64"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Button } from "@opencode-ai/ui/button"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { getFilename } from "@opencode-ai/core/util/path"
import { Session, type Worktree } from "@opencode-ai/sdk/v2/client"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { createStore, produce, reconcile } from "solid-js/store"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { useProviders } from "@/hooks/use-providers"
import { dismissToast, setV2Toast, showToast, ToastRegion } from "@/utils/toast"
import { useServerSDK } from "@/context/server-sdk"
import { clearWorkspaceTerminals } from "@/context/terminal"
import { pickSessionCacheEvictions } from "@/context/global-sync/session-cache"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { Binary } from "@opencode-ai/core/util/binary"
import { retry } from "@opencode-ai/core/util/retry"
import { playSoundById } from "@/utils/sound"
import { createAim } from "@/utils/aim"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { setSessionHandoff } from "@/pages/session/handoff"
import { SessionRouteKey, SessionStateKey } from "@/utils/server-scope"
import { listAllSessions } from "@/utils/session"
import { same } from "@/utils/same"
import {
  cancelProjectNavigationEvent,
  legacyNewSessionHref,
  legacyRouteDirectory,
  legacySessionHref,
  withWorkspaceRoot,
  workspaceRootParam,
} from "@/utils/session-route"

import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useTheme, type ColorScheme } from "@opencode-ai/ui/theme/context"
import { useCommand, type CommandOption } from "@/context/command"
import { ConstrainDragXAxis, getDraggableId } from "@/utils/solid-dnd"
import { DebugBar } from "@/components/debug-bar"
import { TabsInfoPopup } from "@/components/help-button"
import { Titlebar, type TitlebarUpdate } from "@/components/titlebar"
import { useDirectoryPicker } from "@/components/directory-picker"
import { useServer } from "@/context/server"
import { useLanguage, type Locale } from "@/context/language"
import { pathKey } from "@/utils/path-key"
import { owningContainer } from "@/utils/project-owner"
import {
  displayName,
  effectiveWorkspaceOrder,
  errorMessage,
  latestRootSession,
  openInVSCodeBase,
  openInVSCodeURL,
  sortedRootSessions,
} from "./layout/helpers"
import {
  collectNewSessionDeepLinks,
  collectOpenProjectDeepLinks,
  deepLinkEvent,
  drainPendingDeepLinks,
} from "./layout/deep-links"
import { createInlineEditorController } from "./layout/inline-editor"
import {
  LocalWorkspace,
  LocalWorkspaceSessions,
  SortableWorkspace,
  WorkspaceDragOverlay,
  type WorkspaceSidebarContext,
} from "./layout/sidebar-workspace"
import { ProjectDragOverlay, SortableProject, type ProjectSidebarContext } from "./layout/sidebar-project"
import { SidebarContent } from "./layout/sidebar-shell"

const OPEN_IN_VSCODE_URL = import.meta.env.VITE_OPEN_IN_VSCODE_URL

export default function LegacyLayout(props: ParentProps) {
  const serverSDK = useServerSDK()
  const [store, setStore, , ready] = persisted(
    Persist.serverGlobal(serverSDK().scope, "layout.page", ["layout.page.v1"]),
    createStore({
      lastProjectSession: {} as { [directory: string]: { directory: string; id: string; at: number } },
      activeProject: undefined as string | undefined,
      activeWorkspace: undefined as string | undefined,
      workspaceOrder: {} as Record<string, string[]>,
      workspaceName: {} as Record<string, string>,
      workspaceBranchName: {} as Record<string, Record<string, string>>,
      workspaceExpanded: {} as Record<string, boolean>,
      gettingStartedDismissed: false,
    }),
  )

  const pageReady = createMemo(() => ready())

  let scrollContainerRef: HTMLDivElement | undefined
  let dialogRun = 0
  let dialogDead = false

  const params = useParams()
  const serverSync = useServerSync()
  const layout = useLayout()
  const layoutReady = createMemo(() => layout.ready())
  const platform = usePlatform()
  const pickDirectory = useDirectoryPicker()
  const settings = useSettings()
  const server = useServer()
  const notification = useNotification()
  const permission = usePermission()
  const navigate = useNavigate()
  const routeLocation = useLocation()
  const providers = useProviders(() => undefined)
  const dialog = useDialog()
  const command = useCommand()
  const theme = useTheme()
  const language = useLanguage()
  const desktopSidebar = createMediaQuery("(min-width: 1280px)")
  createEffect(() => setV2Toast(false))
  onMount(() => {
    if (!window.matchMedia("(display-mode: standalone)").matches) return

    const viewport = window.visualViewport
    const root = document.getElementById("root")
    if (!viewport || !root) return

    let viewportFrame: number | undefined
    let viewportTimer: number | undefined
    let layoutWidth = viewport.width
    let layoutHeight = viewport.height

    const syncViewport = () => {
      if (!viewport.height) return
      if (Math.abs(viewport.width - layoutWidth) <= 1) layoutHeight = Math.max(layoutHeight, viewport.height)
      root.style.height = `${layoutHeight}px`
      root.style.removeProperty("transform")
      if (viewport.height >= layoutHeight - 1) window.scrollTo(0, 0)
    }

    const settleViewport = () => {
      if (Math.abs(viewport.width - layoutWidth) > 1) {
        layoutWidth = viewport.width
        layoutHeight = viewport.height
      }
      syncViewport()
    }

    const scheduleViewportSync = () => {
      if (viewportFrame !== undefined) cancelAnimationFrame(viewportFrame)
      if (viewportTimer !== undefined) clearTimeout(viewportTimer)
      viewportFrame = requestAnimationFrame(syncViewport)
      viewportTimer = window.setTimeout(settleViewport, 300)
    }

    syncViewport()
    makeEventListener(viewport, "resize", scheduleViewportSync)
    makeEventListener(viewport, "scroll", scheduleViewportSync)
    makeEventListener(document, "focusout", scheduleViewportSync)
    onCleanup(() => {
      if (viewportFrame !== undefined) cancelAnimationFrame(viewportFrame)
      if (viewportTimer !== undefined) clearTimeout(viewportTimer)
      root.style.removeProperty("height")
      root.style.removeProperty("transform")
    })
  })
  const initialDirectory = decode64(params.dir)
  const route = createMemo(() => {
    const slug = params.dir
    if (!slug) return { slug, dir: "" }
    const dir = decode64(slug)
    if (!dir) return { slug, dir: "" }
    const store = serverSync().peek(dir, { bootstrap: false })
    return {
      slug,
      store,
      dir: store[0].path.directory || dir,
    }
  })
  const availableThemeEntries = createMemo(() => theme.ids().map((id) => [id, theme.themes()[id]] as const))
  const colorSchemeOrder: ColorScheme[] = ["system", "light", "dark"]
  const colorSchemeKey: Record<ColorScheme, "theme.scheme.system" | "theme.scheme.light" | "theme.scheme.dark"> = {
    system: "theme.scheme.system",
    light: "theme.scheme.light",
    dark: "theme.scheme.dark",
  }
  const colorSchemeLabel = (scheme: ColorScheme) => language.t(colorSchemeKey[scheme])
  const currentDir = createMemo(() => route().dir)
  const rootParam = createMemo(() => workspaceRootParam(routeLocation.search))
  const canOpenRemoteVSCode = createMemo(() => platform.platform === "web" && !!openInVSCodeBase(OPEN_IN_VSCODE_URL))

  const [state, setState] = createStore({
    autoselect: !initialDirectory,
    busyWorkspaces: {} as Record<string, boolean>,
    pendingWorkspaces: {} as Record<string, { directory: string; root: string }>,
    memberDirectories: {} as Record<string, string[]>,
    pendingProjects: {} as Record<string, boolean>,
    openingProject: undefined as string | undefined,
    hoverProject: undefined as string | undefined,
    scrollSessionKey: undefined as string | undefined,
    nav: undefined as HTMLElement | undefined,
    sortNow: Date.now(),
    sizing: false,
    peek: undefined as string | undefined,
    peeked: false,
    debugTools: true,
  })

  const updateVersion = () => {
    const state = platform.updater?.state()
    if (state?.status !== "ready") return
    return state.version
  }
  const installUpdate = () => void platform.updater?.install()
  const titlebarUpdate: TitlebarUpdate = {
    version: updateVersion,
    installing: () => platform.updater?.state().status === "installing",
    install: installUpdate,
  }

  const editor = createInlineEditorController()
  const setBusy = (directory: string, value: boolean, root?: string) => {
    const key = pathKey(directory)
    if (value) {
      setState("busyWorkspaces", key, true)
      if (root) setState("pendingWorkspaces", key, { directory, root })
      return
    }
    setState(
      "busyWorkspaces",
      produce((draft) => {
        delete draft[key]
      }),
    )
    setState(
      "pendingWorkspaces",
      produce((draft) => {
        delete draft[key]
      }),
    )
  }
  const isBusy = (directory: string) => !!state.busyWorkspaces[pathKey(directory)]
  const navLeave = { current: undefined as number | undefined }
  const sortNow = () => state.sortNow
  let sizet: number | undefined
  let sortNowInterval: ReturnType<typeof setInterval> | undefined
  const sortNowTimeout = setTimeout(
    () => {
      setState("sortNow", Date.now())
      sortNowInterval = setInterval(() => setState("sortNow", Date.now()), 60_000)
    },
    60_000 - (Date.now() % 60_000),
  )

  const aim = createAim({
    enabled: () => !layout.sidebar.opened(),
    active: () => state.hoverProject,
    el: () => state.nav?.querySelector<HTMLElement>("[data-component='sidebar-rail']") ?? state.nav,
    onActivate: (directory) => {
      serverSync().child(directory)
      setState("hoverProject", directory)
    },
  })

  onCleanup(() => {
    dialogDead = true
    dialogRun += 1
    if (navLeave.current !== undefined) clearTimeout(navLeave.current)
    clearTimeout(sortNowTimeout)
    if (sortNowInterval) clearInterval(sortNowInterval)
    if (sizet !== undefined) clearTimeout(sizet)
    if (peekt !== undefined) clearTimeout(peekt)
    aim.reset()
  })

  onMount(() => {
    const stop = () => setState("sizing", false)
    const blur = () => reset()
    const hide = () => {
      if (document.visibilityState !== "hidden") return
      reset()
    }
    makeEventListener(window, "pointerup", stop)
    makeEventListener(window, "pointercancel", stop)
    makeEventListener(window, "blur", stop)
    makeEventListener(window, "blur", blur)
    makeEventListener(document, "visibilitychange", hide)
    makeEventListener(window, cancelProjectNavigationEvent, cancelProjectNavigation)
  })

  const sidebarHovering = createMemo(() => !layout.sidebar.opened() && state.hoverProject !== undefined)
  const sidebarExpanded = createMemo(() => layout.sidebar.opened() || sidebarHovering())
  const setHoverProject = (value: string | undefined) => {
    setState("hoverProject", value)
    if (value !== undefined) return
    aim.reset()
  }
  const clearHoverProjectSoon = () => queueMicrotask(() => setHoverProject(undefined))

  const disarm = () => {
    if (navLeave.current === undefined) return
    clearTimeout(navLeave.current)
    navLeave.current = undefined
  }

  const reset = () => {
    disarm()
    setHoverProject(undefined)
  }

  const arm = (delay = 300) => {
    if (layout.sidebar.opened()) return
    if (state.hoverProject === undefined) return
    disarm()
    navLeave.current = window.setTimeout(() => {
      navLeave.current = undefined
      setHoverProject(undefined)
    }, delay)
  }

  let peekt: number | undefined

  const hoverProjectData = createMemo(() => {
    const id = state.hoverProject
    if (!id) return
    return layout.projects.list().find((project) => project.worktree === id)
  })

  const peekProject = createMemo(() => {
    const id = state.peek
    if (!id) return
    return layout.projects.list().find((project) => project.worktree === id)
  })

  createEffect(() => {
    const p = hoverProjectData()
    if (p) {
      if (peekt !== undefined) {
        clearTimeout(peekt)
        peekt = undefined
      }
      setState("peek", p.worktree)
      setState("peeked", true)
      return
    }

    setState("peeked", false)
    if (state.peek === undefined) return
    if (peekt !== undefined) clearTimeout(peekt)
    peekt = window.setTimeout(() => {
      peekt = undefined
      setState("peek", undefined)
    }, 180)
  })

  createEffect(() => {
    if (!layout.sidebar.opened()) return
    setHoverProject(undefined)
  })

  createEffect(() => {
    if (!state.autoselect) return
    const dir = params.dir
    if (!dir) return
    const directory = decode64(dir)
    if (!directory) return
    setState("autoselect", false)
  })

  const editorOpen = editor.editorOpen
  const openEditor = editor.openEditor
  const closeEditor = editor.closeEditor
  const setEditor = editor.setEditor
  const InlineEditor = editor.InlineEditor

  const clearSidebarHoverState = () => {
    if (layout.sidebar.opened()) return
    reset()
  }

  const navigateWithSidebarReset = (href: string, token?: number) => {
    if (token === undefined) cancelProjectNavigation()
    clearSidebarHoverState()
    navigate(href)
    layout.mobileSidebar.hide()
  }

  const focusSessionPrompt = () => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>('[data-component="prompt-input"]')?.focus()
      })
    })
  }

  function sessionHref(directory: string, sessionID?: string, root = activeProjectRoot(directory)) {
    return sessionID ? legacySessionHref(directory, sessionID, root) : legacyNewSessionHref(directory, root)
  }

  function navigateToNewSession(directory: string, root = directory) {
    navigateWithSidebarReset(sessionHref(directory, undefined, root))
    focusSessionPrompt()
  }

  function cycleTheme(direction = 1) {
    const ids = availableThemeEntries().map(([id]) => id)
    if (ids.length === 0) return
    const currentIndex = ids.indexOf(theme.themeId())
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + direction + ids.length) % ids.length
    const nextThemeId = ids[nextIndex]
    theme.setTheme(nextThemeId)
    showToast({
      title: language.t("toast.theme.title"),
      description: theme.name(nextThemeId),
    })
  }

  function cycleColorScheme(direction = 1) {
    const current = theme.colorScheme()
    const currentIndex = colorSchemeOrder.indexOf(current)
    const nextIndex =
      currentIndex === -1 ? 0 : (currentIndex + direction + colorSchemeOrder.length) % colorSchemeOrder.length
    const next = colorSchemeOrder[nextIndex]
    theme.setColorScheme(next)
    showToast({
      title: language.t("toast.scheme.title"),
      description: colorSchemeLabel(next),
    })
  }

  function setLocale(next: Locale) {
    if (next === language.locale()) return
    language.setLocale(next)
    showToast({
      title: language.t("toast.language.title"),
      description: language.t("toast.language.description", { language: language.label(next) }),
    })
  }

  function cycleLanguage(direction = 1) {
    const locales = language.locales
    const currentIndex = locales.indexOf(language.locale())
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + direction + locales.length) % locales.length
    const next = locales[nextIndex]
    if (!next) return
    setLocale(next)
  }

  const useSDKNotificationToasts = () =>
    onMount(() => {
      const toastBySession = new Map<string, number>()
      const alertedAtBySession = new Map<string, number>()
      const cooldownMs = 5000

      const dismissSessionAlert = (sessionKey: string) => {
        const toastId = toastBySession.get(sessionKey)
        if (toastId === undefined) return
        dismissToast(toastId)
        toastBySession.delete(sessionKey)
        alertedAtBySession.delete(sessionKey)
      }

      const unsub = serverSDK().event.listen((e) => {
        if (e.details?.type === "worktree.ready") {
          setBusy(e.name, false)
          WorktreeState.ready(serverSDK().scope, e.name)
          const project = layout.projects.list().find((item) => item.worktree === projectRoot(e.name))
          if (project) void refreshWorkspaceList(project, true)
          return
        }

        if (e.details?.type === "worktree.failed") {
          setBusy(e.name, false)
          WorktreeState.failed(
            serverSDK().scope,
            e.name,
            e.details.properties?.message ?? language.t("common.requestFailed"),
          )
          return
        }

        if (
          e.details?.type === "question.replied" ||
          e.details?.type === "question.rejected" ||
          e.details?.type === "permission.replied"
        ) {
          const props = e.details.properties as { sessionID: string }
          const sessionKey = `${e.name}:${props.sessionID}`
          dismissSessionAlert(sessionKey)
          return
        }

        if (e.details?.type !== "permission.asked" && e.details?.type !== "question.asked") return
        const title =
          e.details.type === "permission.asked"
            ? language.t("notification.permission.title")
            : language.t("notification.question.title")
        const icon = e.details.type === "permission.asked" ? ("checklist" as const) : ("bubble-5" as const)
        const directory = e.name
        const props = e.details.properties
        if (e.details.type === "permission.asked" && permission.autoResponds(e.details.properties, directory)) return

        const [store] = serverSync().child(directory, { bootstrap: false })
        const session = store.session.find((s) => s.id === props.sessionID)
        const sessionKey = `${directory}:${props.sessionID}`

        const sessionTitle = session?.title ?? language.t("command.session.new")
        const projectName = getFilename(directory)
        const description =
          e.details.type === "permission.asked"
            ? language.t("notification.permission.description", { sessionTitle, projectName })
            : language.t("notification.question.description", { sessionTitle, projectName })
        const href = `/${base64Encode(directory)}/session/${props.sessionID}`

        const now = Date.now()
        const lastAlerted = alertedAtBySession.get(sessionKey) ?? 0
        if (now - lastAlerted < cooldownMs) return
        alertedAtBySession.set(sessionKey, now)

        if (e.details.type === "permission.asked") {
          if (settings.sounds.permissionsEnabled()) {
            void playSoundById(settings.sounds.permissions())
          }
          if (settings.notifications.permissions()) {
            void platform.notify(title, description, () => navigate(navigationHref(href)))
          }
        }

        if (e.details.type === "question.asked") {
          if (settings.notifications.agent()) {
            void platform.notify(title, description, () => navigate(navigationHref(href)))
          }
        }

        const currentSession = params.id
        if (pathKey(directory) === pathKey(currentDir()) && props.sessionID === currentSession) return
        if (pathKey(directory) === pathKey(currentDir()) && session?.parentID === currentSession) return

        dismissSessionAlert(sessionKey)

        const toastId = showToast({
          persistent: true,
          icon,
          title,
          description,
          actions: [
            {
              label: language.t("notification.action.goToSession"),
              // Same restoration the platform notification gets: a
              // workspace member session must open under its owning root.
              onClick: () => navigate(navigationHref(href)),
            },
            {
              label: language.t("common.dismiss"),
              onClick: "dismiss",
            },
          ],
        })
        toastBySession.set(sessionKey, toastId)
      })
      onCleanup(unsub)

      createEffect(() => {
        const currentSession = params.id
        if (!currentDir() || !currentSession) return
        const sessionKey = `${currentDir()}:${currentSession}`
        dismissSessionAlert(sessionKey)
        const [store] = serverSync().child(currentDir(), { bootstrap: false })
        const childSessions = store.session.filter((s) => s.parentID === currentSession)
        for (const child of childSessions) {
          dismissSessionAlert(`${currentDir()}:${child.id}`)
        }
      })
    })

  useSDKNotificationToasts()

  function showRequestError(err: unknown) {
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: errorMessage(err, language.t("common.requestFailed")),
    })
  }

  function openRemoteVSCode(directory: string) {
    if (!canOpenRemoteVSCode()) return
    const url = openInVSCodeURL(OPEN_IN_VSCODE_URL, directory)
    if (!url) return
    platform.openExternal(url)
  }

  function scrollToSession(sessionId: string, sessionKey: string) {
    if (!scrollContainerRef) return
    if (state.scrollSessionKey === sessionKey) return
    const element = scrollContainerRef.querySelector(`[data-session-id="${sessionId}"]`)
    if (!element) return
    const containerRect = scrollContainerRef.getBoundingClientRect()
    const elementRect = element.getBoundingClientRect()
    if (elementRect.top >= containerRect.top && elementRect.bottom <= containerRect.bottom) {
      setState("scrollSessionKey", sessionKey)
      return
    }
    setState("scrollSessionKey", sessionKey)
    element.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }

  const currentProject = createMemo(() => {
    const directory = currentDir()
    if (!directory) return

    const projects = layout.projects.list()
    const queryRoot = rootParam()
    if (queryRoot) {
      const project = projects.find((p) => pathKey(p.worktree) === pathKey(queryRoot))
      if (project) return project
    }

    const container = owningContainer(projects, directory)
    if (container) return container

    const [child] = serverSync().child(directory, { bootstrap: false })
    const id = child.project
    if (!id) return

    const meta = serverSync().data.project.find((p) => p.id === id)
    const root = meta?.worktree
    if (!root) return

    return projects.find((p) => p.worktree === root)
  })

  const [autoselecting] = createResource(async () => {
    await ready.promise
    await layout.ready.promise
    if (!untrack(() => state.autoselect)) return

    const list = layout.projects.list()
    const last = server.projects.last()

    if (list.length === 0) {
      if (!last) return
      await openProject(last, true)
    } else {
      const next = list.find((project) => project.worktree === last) ?? list[0]
      if (!next) return
      await openProject(next.worktree, true)
    }
  })

  const workspaceName = (directory: string, projectId?: string, branch?: string) => {
    const key = pathKey(directory)
    const direct = store.workspaceName[key] ?? store.workspaceName[directory]
    if (direct) return direct
    if (!projectId) return
    if (!branch) return
    return store.workspaceBranchName[projectId]?.[branch]
  }

  const setWorkspaceName = (directory: string, next: string, projectId?: string, branch?: string) => {
    const key = pathKey(directory)
    if (store.workspaceName[key] === next) return
    setStore("workspaceName", key, next)
    if (!projectId) return
    if (!branch) return
    if (!store.workspaceBranchName[projectId]) {
      setStore("workspaceBranchName", projectId, {})
    }
    setStore("workspaceBranchName", projectId, branch, next)
  }

  const workspaceLabel = (directory: string, branch?: string, projectId?: string) =>
    workspaceName(directory, projectId, branch) ?? branch ?? getFilename(directory)

  const applyWorkspaceList = (project: LocalProject, workspaces: Worktree[]) => {
    const directories = workspaces
      .map((item) => item.directory)
      .filter((directory) => pathKey(directory) !== pathKey(project.worktree))
    for (const item of workspaces) {
      setWorkspaceName(item.directory, item.description ?? item.branch ?? item.name, project.id, item.branch)
    }
    setState(
      "memberDirectories",
      pathKey(project.worktree),
      workspaces.filter((item) => item.root).map((item) => pathKey(item.directory)),
    )
    const target = serverSync().data.project.find((item) => item.worktree === project.worktree)
    if (!same(target?.sandboxes?.map(pathKey), directories.map(pathKey))) {
      serverSync().set(
        "project",
        produce((draft) => {
          const target = draft.find((item) => item.worktree === project.worktree)
          if (!target) return
          target.sandboxes = directories
        }),
      )
    }
    setStore("workspaceOrder", project.worktree, (order) => {
      const next = (order ?? []).filter((directory) => {
        if (isBusy(directory)) return true
        return directories.some((item) => pathKey(item) === pathKey(directory))
      })
      return same(order, next) ? order : next
    })
  }

  const workspaceRefreshes = new Map<string, Promise<Worktree[] | undefined>>()
  const refreshWorkspaceList = async (project: LocalProject, force = false): Promise<Worktree[]> => {
    const key = pathKey(project.worktree)
    const existing = workspaceRefreshes.get(key)
    if (existing) {
      const workspaces = (await existing) ?? []
      if (!force) return workspaces
      return refreshWorkspaceList(project)
    }
    const request = serverSDK()
      .client.worktree.list({ directory: project.worktree })
      .then((x) => x.data ?? [])
      .catch(() => undefined)
      .then((workspaces) => {
        if (workspaces) applyWorkspaceList(project, workspaces)
        return workspaces
      })
      .finally(() => {
        workspaceRefreshes.delete(key)
      })
    workspaceRefreshes.set(key, request)
    return (await request) ?? []
  }

  const workspaceSetting = createMemo(() => {
    const project = currentProject()
    if (!project) return false
    if (project.vcs !== "git" && !isWorkspaceRootProject(project)) return false
    return true
  })

  onMount(() => {
    let refreshing = false
    const refresh = () => {
      if (document.visibilityState === "hidden" || refreshing) return
      refreshing = true
      const projects = layout.projects
        .list()
        .filter((project) => project.vcs === "git" || isWorkspaceRootProject(project))
      void Promise.all(projects.map((project) => refreshWorkspaceList(project))).finally(() => {
        refreshing = false
      })
    }
    const visible = () => {
      if (document.visibilityState === "visible") refresh()
    }
    const interval = setInterval(refresh, 10_000)
    window.addEventListener("focus", refresh)
    document.addEventListener("visibilitychange", visible)
    refresh()
    onCleanup(() => {
      clearInterval(interval)
      window.removeEventListener("focus", refresh)
      document.removeEventListener("visibilitychange", visible)
    })
  })

  const visibleSessionDirs = createMemo(() => {
    const project = currentProject()
    if (!project) return [] as string[]
    if (!workspaceSetting()) return [project.worktree]

    const activeDir = currentDir()
    return workspaceIds(project).filter((directory) => {
      const expanded = store.workspaceExpanded[directory] ?? directory === project.worktree
      const active = pathKey(directory) === pathKey(activeDir)
      return expanded || active
    })
  })

  createEffect(() => {
    if (!pageReady()) return
    if (!layoutReady()) return
    const projects = layout.projects.list()
    for (const [directory, expanded] of Object.entries(store.workspaceExpanded)) {
      if (!expanded) continue
      const key = pathKey(directory)
      const project = projects.find(
        (item) => pathKey(item.worktree) === key || item.sandboxes?.some((sandbox) => pathKey(sandbox) === key),
      )
      if (!project) continue
      if (isWorkspaceRootProject(project)) continue
      if (project.vcs === "git" && layout.sidebar.workspaces(project.worktree)()) continue
      setStore("workspaceExpanded", directory, false)
    }
  })

  const currentSessions = createMemo(() => {
    const now = Date.now()
    const dirs = visibleSessionDirs()
    if (dirs.length === 0) return [] as Session[]

    const result: Session[] = []
    for (const dir of dirs) {
      const [dirStore] = serverSync().child(dir, { bootstrap: false })
      const dirSessions = sortedRootSessions(dirStore, now)
      result.push(...dirSessions)
    }
    return result
  })

  type PrefetchQueue = {
    inflight: Set<string>
    pending: string[]
    pendingSet: Set<string>
    running: number
  }

  const prefetchChunk = 200
  const prefetchConcurrency = 2
  const prefetchPendingLimit = 10
  const span = 4
  const prefetchToken = { value: 0 }
  const prefetchQueues = new Map<string, PrefetchQueue>()

  const PREFETCH_MAX_SESSIONS_PER_DIR = 10
  const prefetchedByDir = new Map<string, Set<string>>()

  const lruFor = (directory: string) => {
    const existing = prefetchedByDir.get(directory)
    if (existing) return existing
    const created = new Set<string>()
    prefetchedByDir.set(directory, created)
    return created
  }

  const markPrefetched = (directory: string, sessionID: string) => {
    const lru = lruFor(directory)
    return pickSessionCacheEvictions({
      seen: lru,
      keep: sessionID,
      limit: PREFETCH_MAX_SESSIONS_PER_DIR,
      preserve: params.id && pathKey(directory) === pathKey(currentDir()) ? [params.id] : undefined,
    })
  }

  createEffect(() => {
    const active = new Set(visibleSessionDirs())
    for (const directory of prefetchedByDir.keys()) {
      if (active.has(directory)) continue
      prefetchedByDir.delete(directory)
    }
  })

  createEffect(() => {
    route()
    serverSDK().url

    prefetchToken.value += 1
    prefetchQueues.clear()
  })

  createEffect(() => {
    const visible = new Set(visibleSessionDirs())
    for (const [directory, q] of prefetchQueues) {
      if (visible.has(directory)) continue
      q.pending.length = 0
      q.pendingSet.clear()
      if (q.running === 0) prefetchQueues.delete(directory)
    }
  })

  const queueFor = (directory: string) => {
    const existing = prefetchQueues.get(directory)
    if (existing) return existing

    const created: PrefetchQueue = {
      inflight: new Set(),
      pending: [],
      pendingSet: new Set(),
      running: 0,
    }
    prefetchQueues.set(directory, created)
    return created
  }

  async function prefetchMessages(directory: string, sessionID: string, token: number) {
    await serverSync()
      .session.prefetch(sessionID, prefetchChunk)
      .catch(() => {})
    if (prefetchToken.value !== token) return
    for (const stale of markPrefetched(directory, sessionID)) serverSync().session.evict(stale)
  }

  const pumpPrefetch = (directory: string) => {
    const q = queueFor(directory)
    if (q.running >= prefetchConcurrency) return

    const sessionID = q.pending.shift()
    if (!sessionID) return

    q.pendingSet.delete(sessionID)
    q.inflight.add(sessionID)
    q.running += 1

    const token = prefetchToken.value

    void prefetchMessages(directory, sessionID, token).finally(() => {
      q.running -= 1
      q.inflight.delete(sessionID)
      pumpPrefetch(directory)
    })
  }

  const prefetchSession = (session: Session, priority: "high" | "low" = "low") => {
    const directory = session.directory
    if (!directory) return

    const cached = untrack(() => !serverSync().session.shouldPrefetch(session.id, prefetchChunk))
    if (cached) return

    const q = queueFor(directory)
    if (q.inflight.has(session.id)) return
    if (q.pendingSet.has(session.id)) {
      if (priority !== "high") return
      const index = q.pending.indexOf(session.id)
      if (index > 0) {
        q.pending.splice(index, 1)
        q.pending.unshift(session.id)
      }
      return
    }

    const lru = lruFor(directory)
    const known = lru.has(session.id)
    if (!known && lru.size >= PREFETCH_MAX_SESSIONS_PER_DIR && priority !== "high") return

    if (priority === "high") q.pending.unshift(session.id)
    if (priority !== "high") q.pending.push(session.id)
    q.pendingSet.add(session.id)

    while (q.pending.length > prefetchPendingLimit) {
      const dropped = q.pending.pop()
      if (!dropped) continue
      q.pendingSet.delete(dropped)
    }

    pumpPrefetch(directory)
  }

  const warm = (sessions: Session[], index: number) => {
    for (let offset = 1; offset <= span; offset++) {
      const next = sessions[index + offset]
      if (next) prefetchSession(next, offset === 1 ? "high" : "low")

      const prev = sessions[index - offset]
      if (prev) prefetchSession(prev, offset === 1 ? "high" : "low")
    }
  }

  createEffect(() => {
    if (!params.id) return
    const sessions = currentSessions()
    if (sessions.length === 0) return

    const index = sessions.findIndex((s) => s.id === params.id)
    if (index === -1) return

    warm(sessions, index)
  })

  function navigateSessionByOffset(offset: number) {
    const sessions = currentSessions()
    if (sessions.length === 0) return

    const sessionIndex = params.id ? sessions.findIndex((s) => s.id === params.id) : -1

    let targetIndex: number
    if (sessionIndex === -1) {
      targetIndex = offset > 0 ? 0 : sessions.length - 1
    } else {
      targetIndex = (sessionIndex + offset + sessions.length) % sessions.length
    }

    const session = sessions[targetIndex]
    if (!session) return

    prefetchSession(session, "high")
    warm(sessions, targetIndex)

    navigateToSession(session)
  }

  function navigateProjectByOffset(offset: number) {
    const projects = layout.projects.list()
    if (projects.length === 0) return

    const current = currentProject()?.worktree
    const fallback = currentDir() ? projectRoot(currentDir()) : undefined
    const active = current ?? fallback
    const index = active ? projects.findIndex((project) => project.worktree === active) : -1

    const target =
      index === -1
        ? offset > 0
          ? projects[0]
          : projects[projects.length - 1]
        : projects[(index + offset + projects.length) % projects.length]
    if (!target) return

    // warm up child store to prevent flicker
    serverSync().child(target.worktree)
    void openProject(target.worktree)
  }

  function navigateToProjectIndex(index: number) {
    const projects = layout.projects.list()
    const target = projects[index]
    if (!target) return

    serverSync().child(target.worktree)
    void openProject(target.worktree)
  }

  function navigateSessionByUnseen(offset: number) {
    const sessions = currentSessions()
    if (sessions.length === 0) return

    const hasUnseen = sessions.some((session) => notification.session.unseenCount(session.id) > 0)
    if (!hasUnseen) return

    const activeIndex = params.id ? sessions.findIndex((s) => s.id === params.id) : -1
    const start = activeIndex === -1 ? (offset > 0 ? -1 : 0) : activeIndex

    for (let i = 1; i <= sessions.length; i++) {
      const index = offset > 0 ? (start + i) % sessions.length : (start - i + sessions.length) % sessions.length
      const session = sessions[index]
      if (!session) continue
      if (notification.session.unseenCount(session.id) === 0) continue

      prefetchSession(session, "high")
      warm(sessions, index)

      navigateToSession(session)
      return
    }
  }

  async function archiveSession(session: Session) {
    if ((await serverSDK().protocol) !== "v1") return
    const [store, setStore] = serverSync().child(session.directory)
    const sessions = store.session ?? []
    const index = sessions.findIndex((s) => s.id === session.id)
    const nextSession = sessions[index + 1] ?? sessions[index - 1]

    await serverSDK().client.session.update({
      sessionID: session.id,
      directory: session.directory,
      time: { archived: Date.now() },
    })
    setStore(
      produce((draft) => {
        const match = Binary.search(draft.session, session.id, (s) => s.id)
        if (match.found) draft.session.splice(match.index, 1)
      }),
    )
    if (session.id === params.id) {
      if (nextSession) {
        navigate(sessionHref(nextSession.directory, nextSession.id))
      } else {
        navigate(sessionHref(session.directory))
      }
    }
  }

  command.register("layout", () => {
    const commands: CommandOption[] = [
      {
        id: "sidebar.toggle",
        title: language.t("command.sidebar.toggle"),
        category: language.t("command.category.view"),
        keybind: "mod+b",
        onSelect: () => layout.sidebar.toggle(),
      },
      {
        id: "project.open",
        title: language.t("command.project.open"),
        category: language.t("command.category.project"),
        keybind: "mod+o",
        onSelect: () => chooseProject(),
      },
      {
        id: "project.previous",
        title: language.t("command.project.previous"),
        category: language.t("command.category.project"),
        keybind: "mod+alt+arrowup",
        onSelect: () => navigateProjectByOffset(-1),
      },
      {
        id: "project.next",
        title: language.t("command.project.next"),
        category: language.t("command.category.project"),
        keybind: "mod+alt+arrowdown",
        onSelect: () => navigateProjectByOffset(1),
      },
      {
        id: "provider.connect",
        title: language.t("command.provider.connect"),
        category: language.t("command.category.provider"),
        onSelect: () => connectProvider(),
      },
      {
        id: "server.switch",
        title: language.t("command.server.switch"),
        category: language.t("command.category.server"),
        onSelect: () => openServer(),
      },
      {
        id: "session.previous",
        title: language.t("command.session.previous"),
        category: language.t("command.category.session"),
        keybind: "alt+arrowup",
        onSelect: () => navigateSessionByOffset(-1),
      },
      {
        id: "session.next",
        title: language.t("command.session.next"),
        category: language.t("command.category.session"),
        keybind: "alt+arrowdown",
        onSelect: () => navigateSessionByOffset(1),
      },
      {
        id: "session.previous.unseen",
        title: language.t("command.session.previous.unseen"),
        category: language.t("command.category.session"),
        keybind: "shift+alt+arrowup",
        onSelect: () => navigateSessionByUnseen(-1),
      },
      {
        id: "session.next.unseen",
        title: language.t("command.session.next.unseen"),
        category: language.t("command.category.session"),
        keybind: "shift+alt+arrowdown",
        onSelect: () => navigateSessionByUnseen(1),
      },
      {
        id: "session.archive",
        title: language.t("command.session.archive"),
        category: language.t("command.category.session"),
        keybind: "mod+shift+backspace",
        disabled: !params.dir || !params.id,
        onSelect: () => {
          const session = currentSessions().find((s) => s.id === params.id)
          if (session) void archiveSession(session)
        },
      },
      {
        id: "workspace.new",
        title: language.t("workspace.new"),
        category: language.t("command.category.workspace"),
        keybind: "mod+shift+w",
        disabled: !workspaceSetting(),
        onSelect: () => {
          const project = currentProject()
          if (!project) return
          showCreateWorkspaceDialog(project)
        },
      },
      {
        id: "workspace.toggle",
        title: language.t("command.workspace.toggle"),
        description: language.t("command.workspace.toggle.description"),
        category: language.t("command.category.workspace"),
        slash: "workspace",
        disabled: !currentProject() || currentProject()?.vcs !== "git",
        onSelect: () => {
          const project = currentProject()
          if (!project) return
          if (project.vcs !== "git") return
          const wasEnabled = layout.sidebar.workspaces(project.worktree)()
          layout.sidebar.toggleWorkspaces(project.worktree)
          showToast({
            title: wasEnabled
              ? language.t("toast.workspace.disabled.title")
              : language.t("toast.workspace.enabled.title"),
            description: wasEnabled
              ? language.t("toast.workspace.disabled.description")
              : language.t("toast.workspace.enabled.description"),
          })
        },
      },
      {
        id: "theme.cycle",
        title: language.t("command.theme.cycle"),
        category: language.t("command.category.theme"),
        keybind: "mod+shift+t",
        onSelect: () => cycleTheme(1),
      },
    ]

    Array.from({ length: 9 }, (_, i) => {
      const index = i
      const number = index + 1
      commands.push({
        id: `project.${number}`,
        category: language.t("command.category.project"),
        title: `Open Project {number}`,
        keybind: `mod+${number}`,
        disabled: layout.projects.list().length <= index,
        hidden: true,
        onSelect: () => navigateToProjectIndex(index),
      })
    })

    for (const [id] of availableThemeEntries()) {
      commands.push({
        id: `theme.set.${id}`,
        title: language.t("command.theme.set", { theme: theme.name(id) }),
        category: language.t("command.category.theme"),
        onSelect: () => theme.commitPreview(),
        onHighlight: () => {
          theme.previewTheme(id)
          return () => theme.cancelPreview()
        },
      })
    }

    commands.push({
      id: "theme.scheme.cycle",
      title: language.t("command.theme.scheme.cycle"),
      category: language.t("command.category.theme"),
      keybind: "mod+shift+s",
      onSelect: () => cycleColorScheme(1),
    })

    for (const scheme of colorSchemeOrder) {
      commands.push({
        id: `theme.scheme.${scheme}`,
        title: language.t("command.theme.scheme.set", { scheme: colorSchemeLabel(scheme) }),
        category: language.t("command.category.theme"),
        onSelect: () => theme.commitPreview(),
        onHighlight: () => {
          theme.previewColorScheme(scheme)
          return () => theme.cancelPreview()
        },
      })
    }

    commands.push({
      id: "language.cycle",
      title: language.t("command.language.cycle"),
      category: language.t("command.category.language"),
      onSelect: () => cycleLanguage(1),
    })

    for (const locale of language.locales) {
      commands.push({
        id: `language.set.${locale}`,
        title: language.t("command.language.set", { language: language.label(locale) }),
        category: language.t("command.category.language"),
        onSelect: () => setLocale(locale),
      })
    }

    return commands
  })

  function connectProvider() {
    const run = ++dialogRun
    void import("@/components/dialog-connect-provider").then((x) => {
      if (dialogDead || dialogRun !== run) return
      void dialog.show(() => <x.DialogConnectProvider />)
    })
  }

  function openServer() {
    const run = ++dialogRun
    void import("@/components/dialog-select-server").then((x) => {
      if (dialogDead || dialogRun !== run) return
      dialog.show(() => <x.DialogSelectServer />)
    })
  }

  function projectRoot(directory: string) {
    const queryRoot = rootParam()
    if (queryRoot && pathKey(directory) === pathKey(currentDir())) return queryRoot

    const key = pathKey(directory)
    const container = owningContainer(layout.projects.list(), directory)
    if (container) return container.worktree

    const known = Object.entries(store.workspaceOrder).find(
      ([root, dirs]) => pathKey(root) === key || dirs.some((item) => pathKey(item) === key),
    )
    if (known) return known[0]

    const [child] = serverSync().child(directory, { bootstrap: false })
    const id = child.project
    if (!id || id === "global") return directory

    const meta = serverSync().data.project.find((item) => item.id === id)
    return meta?.worktree ?? directory
  }

  function activeProjectRoot(directory: string) {
    return currentProject()?.worktree ?? projectRoot(directory)
  }

  // Notifications and alerts build plain directory hrefs, so restore the owning workspace root
  // before handing them to the router.
  function navigationHref(href: string) {
    if (workspaceRootParam(href.split("?")[1]?.split("#")[0])) return href
    const directory = legacyRouteDirectory(href)
    if (!directory) return href
    return withWorkspaceRoot(href, directory, projectRoot(directory))
  }

  function rememberSessionRoute(directory: string, id: string, root = activeProjectRoot(directory)) {
    setStore("lastProjectSession", root, { directory, id, at: Date.now() })
    return root
  }

  function clearLastProjectSession(root: string) {
    if (!store.lastProjectSession[root]) return
    setStore(
      "lastProjectSession",
      produce((draft) => {
        delete draft[root]
      }),
    )
  }

  function syncSessionRoute(directory: string, id: string, root = activeProjectRoot(directory)) {
    rememberSessionRoute(directory, id, root)
    notification.session.markViewed(id)
    const expanded = untrack(() => store.workspaceExpanded[directory])
    if (expanded !== true) {
      setStore("workspaceExpanded", directory, true)
    }
    requestAnimationFrame(() => scrollToSession(id, `${directory}:${id}`))
    return root
  }

  const projectAdmissions = new Map<string, Promise<void>>()

  function admitProject(directory: string) {
    const root = projectRoot(directory)
    layout.projects.open(root)
    const key = pathKey(root)
    const existing = projectAdmissions.get(key)
    if (existing) return existing

    const refresh = serverSync()
      .project.refresh()
      .catch(() => undefined)
    setState("pendingProjects", key, true)

    const admission = Promise.all([
      Promise.resolve(serverSync().project.loadSessions(root)),
      refresh.then(async () => {
        const project = layout.projects.list().find((item) => pathKey(item.worktree) === key)
        if (!project) return
        if (project.vcs !== "git" && !isWorkspaceRootProject(project)) return
        await refreshWorkspaceList(project)
      }),
    ]).then(() => {})

    projectAdmissions.set(key, admission)
    void admission.then(
      () => {
        projectAdmissions.delete(key)
        setState("pendingProjects", key, false)
      },
      () => {
        projectAdmissions.delete(key)
        setState("pendingProjects", key, false)
      },
    )
    return admission
  }

  let projectNavigation = 0
  let projectNavigationTarget: { href: string; token: number } | undefined
  let observedLocation = `${routeLocation.pathname}${routeLocation.search}${routeLocation.hash}`
  let observedProjectRoot = rootParam() ?? (currentDir() ? projectRoot(currentDir()) : undefined)

  function cancelProjectNavigation() {
    projectNavigation += 1
    projectNavigationTarget = undefined
    setState("openingProject", undefined)
  }

  createEffect(() => {
    const href = `${routeLocation.pathname}${routeLocation.search}${routeLocation.hash}`
    if (href === observedLocation) return
    const directory = decode64(params.dir)
    const root = rootParam() ?? (directory ? projectRoot(directory) : undefined)
    const target = projectNavigationTarget
    projectNavigationTarget = undefined
    if (!target || target.href !== href) {
      projectNavigation += 1
      setState("openingProject", undefined)
    }
    if (pathKey(root ?? "") !== pathKey(observedProjectRoot ?? "")) {
      reset()
      setState("peek", undefined)
      setState("peeked", false)
    }
    observedLocation = href
    observedProjectRoot = root
  })

  function navigateToProject(directory: string | undefined) {
    if (!directory) return
    const token = ++projectNavigation
    const root = projectRoot(directory)
    reset()
    setState("peek", undefined)
    setState("openingProject", root)
    const admission = admitProject(root)
    return resolveProjectNavigation(directory, token, admission).finally(() => {
      if (projectNavigation !== token) return
      setState("openingProject", undefined)
    })
  }

  async function resolveProjectNavigation(directory: string, token: number, admission: Promise<void>) {
    const root = projectRoot(directory)
    server.projects.touch(root)
    await admission.catch(() => undefined)
    if (projectNavigation !== token) return
    const project = layout.projects.list().find((item) => item.worktree === root)
    let dirs = project
      ? effectiveWorkspaceOrder(root, [root, ...(project.sandboxes ?? [])], store.workspaceOrder[root])
      : [root]
    const canOpen = (value: string | undefined) => {
      if (!value) return false
      return dirs.some((item) => pathKey(item) === pathKey(value))
    }
    const refreshDirs = async (target?: string) => {
      if (!target || target === root || canOpen(target)) return canOpen(target)
      const listed = await Promise.resolve(
        project?.id ?? serverSDK().api.project.current({ location: { directory: root } }),
      )
        .then((value) => (typeof value === "string" ? value : value.id))
        .then((projectID) => serverSDK().api.project.directories({ projectID, location: { directory: root } }))
        .then((items) => items.map((item) => item.directory).filter((item) => pathKey(item) !== pathKey(root)))
        .catch(() => [] as string[])
      dirs = effectiveWorkspaceOrder(root, [root, ...listed], store.workspaceOrder[root])
      return canOpen(target)
    }
    const openSession = async (target: { directory: string; id: string }) => {
      if (projectNavigation !== token) return false
      if (!canOpen(target.directory)) return false
      const sync = serverSync().ensureDirSyncContext(target.directory)
      if (sync.session.get(target.id)) {
        if (projectNavigation !== token) return false
        setStore("lastProjectSession", root, { directory: target.directory, id: target.id, at: Date.now() })
        const href = sessionHref(target.directory, target.id, root)
        projectNavigationTarget = { href, token }
        navigateWithSidebarReset(href, token)
        return true
      }
      const resolved = await sync.session
        .sync(target.id)
        .then(() => sync.session.get(target.id))
        .catch(() => undefined)
      if (projectNavigation !== token) return false
      if (!resolved?.directory) return false
      if (!canOpen(resolved.directory)) return false
      setStore("lastProjectSession", root, { directory: resolved.directory, id: resolved.id, at: Date.now() })
      const href = sessionHref(resolved.directory, resolved.id, root)
      projectNavigationTarget = { href, token }
      navigateWithSidebarReset(href, token)
      return true
    }

    const projectSession = store.lastProjectSession[root]
    if (projectSession?.id) {
      await refreshDirs(projectSession.directory)
      if (projectNavigation !== token) return
      const opened = await openSession(projectSession)
      if (projectNavigation !== token) return
      if (opened) return
      clearLastProjectSession(root)
    }

    const latest = latestRootSession(
      dirs.map((item) => serverSync().child(item, { bootstrap: false })[0]),
      Date.now(),
    )
    if (latest) {
      const opened = await openSession(latest)
      if (projectNavigation !== token) return
      if (opened) return
    }

    await Promise.all(dirs.map((item) => serverSync().project.loadSessions(item)))
    if (projectNavigation !== token) return
    const fetched = latestRootSession(
      dirs.map((item) => serverSync().child(item, { bootstrap: false })[0]),
      Date.now(),
    )
    if (fetched) {
      const opened = await openSession(fetched)
      if (projectNavigation !== token) return
      if (opened) return
    }

    if (projectNavigation !== token) return
    const href = sessionHref(root, undefined, root)
    projectNavigationTarget = { href, token }
    navigateWithSidebarReset(href, token)
  }

  createEffect(() => {
    if (!pageReady() || !layoutReady()) return
    const directory = currentDir()
    if (!directory) return
    const root = rootParam()
    untrack(() => admitProject(root ?? directory))
  })

  function navigateToSession(session: Session | undefined) {
    if (!session) return
    navigateWithSidebarReset(sessionHref(session.directory, session.id))
  }

  function openProject(directory: string, navigate = true) {
    void admitProject(directory)
    if (navigate) return navigateToProject(directory)
  }

  async function createEmptyWorkspace(name: string) {
    const directory = serverSync().data.path.directory || serverSync().data.path.home
    const created = await serverSDK()
      .client.worktree.create({
        ...(directory ? { directory } : {}),
        worktreeCreateInput: { name, mode: "workspace-root" },
      })
      .then((result) => result.data)
      .catch((error) => {
        showToast({
          title: language.t("workspace.create.failed.title"),
          description: errorMessage(error, language.t("common.requestFailed")),
        })
        return undefined
      })
    if (!created?.directory) return
    return created.directory
  }

  const handleDeepLinks = (urls: string[]) => {
    if (!server.isLocal()) return

    for (const directory of collectOpenProjectDeepLinks(urls)) {
      void openProject(directory)
    }

    for (const link of collectNewSessionDeepLinks(urls)) {
      void openProject(link.directory, false)
      const slug = base64Encode(link.directory)
      if (link.prompt) {
        setSessionHandoff(SessionStateKey.from(server.scope(), SessionRouteKey.fromLegacy(slug)), {
          prompt: link.prompt,
        })
      }
      const href = link.prompt ? `/${slug}/session?prompt=${encodeURIComponent(link.prompt)}` : `/${slug}/session`
      navigateWithSidebarReset(href)
    }
  }

  onMount(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ urls: string[] }>).detail
      const urls = detail?.urls ?? []
      if (urls.length === 0) return
      handleDeepLinks(urls)
    }

    handleDeepLinks(drainPendingDeepLinks(window))
    makeEventListener(window, deepLinkEvent, handler as EventListener)
  })

  const renameWorkspace = (directory: string, next: string, projectId?: string, branch?: string) => {
    const current = workspaceName(directory, projectId, branch) ?? branch ?? getFilename(directory)
    if (current === next) return
    setWorkspaceName(directory, next, projectId, branch)
  }

  function closeProject(directory: string) {
    const list = layout.projects.list()
    const key = pathKey(directory)
    const index = list.findIndex((x) => pathKey(x.worktree) === key)
    const active = pathKey(currentProject()?.worktree ?? "") === key
    if (index === -1) return

    if (!active) {
      layout.projects.close(directory)
      return
    }

    if (list.length === 1) {
      layout.projects.close(directory)
      navigate("/")
      return
    }

    const next = list[index + 1] ?? list[index - 1]

    layout.projects.close(directory)
    void navigateToProject(next.worktree)
  }

  function hasWorkspaceIdentity(project: LocalProject | undefined) {
    return project?.id?.startsWith("workspace:") ?? false
  }

  function isWorkspaceRootProject(project: LocalProject | undefined) {
    if (!project) return false
    if (hasWorkspaceIdentity(project)) return true
    const root = `${pathKey(project.worktree)}/`
    return project.sandboxes?.some((directory) => pathKey(directory).startsWith(root)) ?? false
  }

  function chooseProject() {
    const conn = server.current
    if (!conn) return
    function resolve(result: string | string[] | null) {
      if (Array.isArray(result)) {
        for (const directory of result) {
          void openProject(directory, false)
        }
        void navigateToProject(result[0])
      } else if (result) {
        void openProject(result)
      }
    }

    pickDirectory({
      server: conn,
      title: language.t("command.project.open"),
      multiple: true,
      onCreateWorkspace: createEmptyWorkspace,
      onSelect: resolve,
    })
  }

  const removeFromWorkspace = async (root: string, directory: string, leaveRemovedWorkspace = false) => {
    const removedKey = pathKey(directory)
    if (removedKey === pathKey(root)) return

    const current = currentDir()
    const currentKey = pathKey(current)
    const shouldLeave = leaveRemovedWorkspace || (!!params.dir && currentKey === removedKey)
    if (!leaveRemovedWorkspace && shouldLeave) {
      navigateWithSidebarReset(sessionHref(root, undefined, root))
    }

    setBusy(directory, true)

    const sessions = await listAllSessions(serverSDK().api.session, { directory, order: "desc" }).catch(() => [])

    const result = await serverSDK()
      .client.worktree.remove({ directory: root, worktreeRemoveInput: { directory, workspaceOnly: true } })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: "Failed to remove from workspace",
          description: errorMessage(err, language.t("common.requestFailed")),
        })
        return undefined
      })

    setBusy(directory, false)

    if (!result?.removed) return
    WorktreeState.clear(serverSDK().scope, directory)

    clearWorkspaceTerminals(
      directory,
      sessions.map((session) => session.id),
      platform,
      serverSDK().scope,
    )
    await serverSDK()
      .client.instance.dispose({ directory })
      .catch(() => undefined)

    if (pathKey(store.lastProjectSession[root]?.directory ?? "") === pathKey(directory)) {
      clearLastProjectSession(root)
    }

    setStore(
      "workspaceOrder",
      produce((draft) => {
        for (const key of Object.keys(draft)) {
          draft[key] = draft[key]?.filter((workspace) => pathKey(workspace) !== removedKey) ?? []
        }
      }),
    )
    setStore(
      produce((draft) => {
        delete draft.workspaceName[removedKey]
        delete draft.workspaceName[directory]
        delete draft.workspaceExpanded[removedKey]
        delete draft.workspaceExpanded[directory]
      }),
    )

    if (result.workspaceRootDirectory) {
      closeProject(result.workspaceRootDirectory)
      if (pathKey(root) === pathKey(result.workspaceRootDirectory)) return
    }

    layout.projects.close(directory)
    layout.projects.open(root)
    const project = layout.projects.list().find((item) => item.worktree === root)
    if (project) await refreshWorkspaceList(project, true)

    if (shouldLeave) return

    const nextCurrent = currentDir()
    const nextKey = pathKey(nextCurrent)
    const dirs = project
      ? effectiveWorkspaceOrder(root, [root, ...(project.sandboxes ?? [])], store.workspaceOrder[root])
      : [root]
    const valid = dirs.some((item) => pathKey(item) === nextKey)

    if (params.dir && projectRoot(nextCurrent) === root && !valid) {
      navigateWithSidebarReset(sessionHref(root, undefined, root))
    }
  }

  const resetWorkspace = async (root: string, directory: string) => {
    if (directory === root) return
    setBusy(directory, true)

    const progress = showToast({
      persistent: true,
      title: language.t("workspace.resetting.title"),
      description: language.t("workspace.resetting.description"),
    })
    const dismiss = () => dismissToast(progress)

    const sessions = await listAllSessions(serverSDK().api.session, { directory, order: "desc" }).catch(() => [])

    clearWorkspaceTerminals(
      directory,
      sessions.map((s) => s.id),
      platform,
      serverSDK().scope,
    )
    await serverSDK()
      .client.instance.dispose({ directory })
      .catch(() => undefined)

    const result = await serverSDK()
      .client.worktree.reset({ directory: root, worktreeResetInput: { directory } })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: language.t("workspace.reset.failed.title"),
          description: errorMessage(err, language.t("common.requestFailed")),
        })
        return false
      })

    if (!result) {
      setBusy(directory, false)
      dismiss()
      return
    }

    if ((await serverSDK().protocol) === "v1")
      await Promise.all(
        sessions
          .filter((session) => session.time.archived === undefined)
          .map((session) =>
            serverSDK()
              .client.session.update({
                sessionID: session.id,
                directory: session.directory,
                time: { archived: Date.now() },
              })
              .catch(() => undefined),
          ),
      )

    setBusy(directory, false)
    dismiss()

    showToast({
      title: language.t("workspace.reset.success.title"),
      description: language.t("workspace.reset.success.description"),
      actions: [
        {
          label: language.t("command.session.new"),
          onClick: () => {
            navigateToNewSession(directory, root)
          },
        },
        {
          label: language.t("common.dismiss"),
          onClick: "dismiss",
        },
      ],
    })
  }

  function DialogRemoveFromWorkspace(props: { root: string; directory: string }) {
    const name = createMemo(() => getFilename(props.directory))

    const handleRemove = () => {
      const leaveRemovedWorkspace = !!params.dir && pathKey(currentDir()) === pathKey(props.directory)
      if (leaveRemovedWorkspace) {
        navigateWithSidebarReset(sessionHref(props.root, undefined, props.root))
      }
      dialog.close()
      void removeFromWorkspace(props.root, props.directory, leaveRemovedWorkspace)
    }

    return (
      <Dialog title="Remove from workspace" fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <div class="flex flex-col gap-1">
            <span class="text-14-regular text-text-strong">Remove "{name()}" from this workspace?</span>
            <span class="text-12-regular text-text-weak">
              This removes the project from the workspace without deleting the project files.
            </span>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button variant="primary" size="large" onClick={handleRemove}>
              Remove from workspace
            </Button>
          </div>
        </div>
      </Dialog>
    )
  }

  function DialogResetWorkspace(props: { root: string; directory: string }) {
    const name = createMemo(() => getFilename(props.directory))
    const [state, setState] = createStore({
      status: "loading" as "loading" | "ready" | "error",
      dirty: false,
      sessions: [] as Session[],
    })

    const refresh = async () => {
      const sessions = await listAllSessions(serverSDK().api.session, {
        directory: props.directory,
        order: "desc",
      }).catch(() => [])
      const active = sessions.filter((session) => session.time.archived === undefined)
      setState({ sessions: active })
    }

    onMount(() => {
      serverSDK()
        .api.vcs.status({ location: { directory: props.directory } })
        .then((result) => {
          const files = result.data
          const dirty = files.length > 0
          setState({ status: "ready", dirty })
          void refresh()
        })
        .catch(() => {
          setState({ status: "error", dirty: false })
        })
    })

    const handleReset = () => {
      dialog.close()
      void resetWorkspace(props.root, props.directory)
    }

    const archivedCount = () => state.sessions.length

    const description = () => {
      if (state.status === "loading") return language.t("workspace.status.checking")
      if (state.status === "error") return language.t("workspace.status.error")
      if (!state.dirty) return language.t("workspace.status.clean")
      return language.t("workspace.status.dirty")
    }

    const archivedLabel = () => {
      const count = archivedCount()
      if (count === 0) return language.t("workspace.reset.archived.none")
      if (count === 1) return language.t("workspace.reset.archived.one")
      return language.t("workspace.reset.archived.many", { count })
    }

    return (
      <Dialog title={language.t("workspace.reset.title")} fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <div class="flex flex-col gap-1">
            <span class="text-14-regular text-text-strong">
              {language.t("workspace.reset.confirm", { name: name() })}
            </span>
            <span class="text-12-regular text-text-weak">
              {description()} {archivedLabel()} {language.t("workspace.reset.note")}
            </span>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button variant="primary" size="large" disabled={state.status === "loading"} onClick={handleReset}>
              {language.t("workspace.reset.button")}
            </Button>
          </div>
        </div>
      </Dialog>
    )
  }

  const activeRoute = {
    session: "",
    sessionProject: "",
    directory: "",
  }

  createEffect(
    on(
      () => {
        return [pageReady(), route().slug, params.id, currentProject()?.worktree, currentDir()] as const
      },
      ([ready, slug, id, root, dir]) => {
        if (!ready || !slug || !dir) {
          activeRoute.session = ""
          activeRoute.sessionProject = ""
          activeRoute.directory = ""
          return
        }

        if (!id) {
          activeRoute.session = ""
          activeRoute.sessionProject = ""
          activeRoute.directory = ""
          return
        }

        const session = `${slug}/${id}`

        if (!root) {
          activeRoute.session = session
          activeRoute.directory = dir
          activeRoute.sessionProject = ""
          return
        }

        if (server.projects.last() !== root) server.projects.touch(root)

        const changed = session !== activeRoute.session || dir !== activeRoute.directory
        if (changed) {
          activeRoute.session = session
          activeRoute.directory = dir
          activeRoute.sessionProject = syncSessionRoute(dir, id, root)
          return
        }

        if (root === activeRoute.sessionProject) return
        activeRoute.directory = dir
        activeRoute.sessionProject = rememberSessionRoute(dir, id, root)
      },
    ),
  )

  createEffect(() => {
    document.documentElement.style.setProperty(
      "--dialog-left-margin",
      `${layout.sidebar.opened() ? layout.sidebar.width() : 48}px`,
    )
  })

  const side = createMemo(() => Math.max(layout.sidebar.width(), 244))
  const panel = createMemo(() => Math.max(side() - 64, 0))

  const loadedSessionDirs = new Set<string>()

  createEffect(
    on(
      visibleSessionDirs,
      (dirs) => {
        if (dirs.length === 0) {
          loadedSessionDirs.clear()
          return
        }

        const next = new Set(dirs)
        for (const directory of next) {
          if (loadedSessionDirs.has(directory)) continue
          void serverSync().project.loadSessions(directory)
        }

        loadedSessionDirs.clear()
        for (const directory of next) {
          loadedSessionDirs.add(directory)
        }
      },
      { defer: true },
    ),
  )

  function handleDragStart(event: unknown) {
    const id = getDraggableId(event)
    if (!id) return
    setHoverProject(undefined)
    setStore("activeProject", id)
  }

  function handleDragOver(event: DragEvent) {
    const { draggable, droppable } = event
    if (draggable && droppable) {
      const projects = layout.projects.list()
      const fromIndex = projects.findIndex((p) => p.worktree === draggable.id.toString())
      const toIndex = projects.findIndex((p) => p.worktree === droppable.id.toString())
      if (fromIndex !== toIndex && toIndex !== -1) {
        layout.projects.move(draggable.id.toString(), toIndex)
      }
    }
  }

  function handleDragEnd() {
    setStore("activeProject", undefined)
  }

  function workspaceIds(project: LocalProject | undefined) {
    if (!project) return []
    const local = project.worktree
    const pending = Object.values(state.pendingWorkspaces)
      .filter((item) => pathKey(item.root) === pathKey(local))
      .map((item) => item.directory)
    const dirs = [local, ...pending, ...(project.sandboxes ?? [])].filter(
      (directory, index, list) => list.findIndex((item) => pathKey(item) === pathKey(directory)) === index,
    )
    const active = currentProject()
    const directory = pathKey(active?.worktree ?? "") === pathKey(project.worktree) ? currentDir() : undefined
    const extra =
      directory && pathKey(directory) !== pathKey(local) && !dirs.some((item) => pathKey(item) === pathKey(directory))
        ? directory
        : undefined
    const extraPending = extra ? WorktreeState.get(serverSDK().scope, extra)?.status === "pending" : false

    const ordered = effectiveWorkspaceOrder(local, dirs, store.workspaceOrder[project.worktree])
    if (extraPending && extra) return [local, extra, ...ordered.filter((item) => item !== local)]
    if (!extra) return ordered
    if (extraPending) return ordered
    return [...ordered, extra]
  }

  const sidebarProject = createMemo(() => {
    const opening = state.openingProject
    if (opening) {
      const project = layout.projects.list().find((item) => pathKey(item.worktree) === pathKey(opening))
      if (project) return project
    }
    if (layout.sidebar.opened()) return currentProject()
    const hovered = hoverProjectData()
    if (hovered) return hovered
    return currentProject()
  })

  function handleWorkspaceDragStart(event: unknown) {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeWorkspace", id)
  }

  function handleWorkspaceDragOver(event: DragEvent) {
    const { draggable, droppable } = event
    if (!draggable || !droppable) return

    const project = sidebarProject()
    if (!project) return

    const ids = workspaceIds(project)
    const fromIndex = ids.findIndex((dir) => dir === draggable.id.toString())
    const toIndex = ids.findIndex((dir) => dir === droppable.id.toString())
    if (fromIndex === -1 || toIndex === -1) return
    if (fromIndex === toIndex) return

    const result = ids.slice()
    const [item] = result.splice(fromIndex, 1)
    if (!item) return
    result.splice(toIndex, 0, item)
    setStore(
      "workspaceOrder",
      project.worktree,
      result.filter((directory) => pathKey(directory) !== pathKey(project.worktree)),
    )
  }

  function handleWorkspaceDragEnd() {
    setStore("activeWorkspace", undefined)
  }

  function DialogCreateWorkspace(props: { project: LocalProject }) {
    const [data, setData] = createStore({ name: "" })
    const submit = (event: SubmitEvent) => {
      event.preventDefault()
      const name = data.name.trim()
      if (!name) return
      dialog.close()
      void createWorkspace(props.project, name)
    }

    return (
      <Dialog title="Create workspace" class="w-full max-w-[480px] mx-auto" fit>
        <form data-component="create-workspace-dialog" onSubmit={submit} class="flex flex-col gap-4 px-6 pb-5">
          <TextField
            autofocus
            placeholder="Workspace name"
            value={data.name}
            onChange={(value) => setData("name", value)}
          />
          <div class="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" size="large" disabled={!data.name.trim()}>
              Create workspace
            </Button>
          </div>
        </form>
      </Dialog>
    )
  }

  const createWorkspace = async (source: LocalProject, name?: string, owner?: LocalProject) => {
    clearSidebarHoverState()
    const created = await serverSDK()
      .client.worktree.create({
        directory: source.worktree,
        worktreeCreateInput: name ? { name, mode: "workspace-member" } : undefined,
      })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: language.t("workspace.create.failed.title"),
          description: errorMessage(err, language.t("common.requestFailed")),
        })
        return undefined
      })

    if (!created?.directory) return

    const workspaceRoot = created.root
    const project: LocalProject =
      owner ??
      (workspaceRoot
        ? (layout.projects.list().find((item) => pathKey(item.worktree) === pathKey(workspaceRoot)) ?? {
            worktree: workspaceRoot,
            expanded: true,
          })
        : source)
    void admitProject(project.worktree)

    setWorkspaceName(
      created.directory,
      created.description ?? created.branch ?? getFilename(created.directory),
      project.id,
      created.branch,
    )

    const local = project.worktree
    const key = pathKey(created.directory)
    const root = pathKey(local)

    WorktreeState.pending(serverSDK().scope, created.directory)
    setBusy(
      created.directory,
      WorktreeState.get(serverSDK().scope, created.directory)?.status === "pending",
      project.worktree,
    )
    setStore("workspaceExpanded", key, true)
    if (key !== created.directory) {
      setStore("workspaceExpanded", created.directory, true)
    }
    setStore("workspaceOrder", project.worktree, (prev) => {
      const existing = prev ?? []
      const next = existing.filter((item) => {
        const id = pathKey(item)
        return id !== root && id !== key
      })
      return [created.directory, ...next]
    })
    await refreshWorkspaceList(project, true)

    serverSync().child(created.directory)
    navigateWithSidebarReset(sessionHref(created.directory, undefined, project.worktree))
  }

  function showCreateWorkspaceDialog(project: LocalProject) {
    dialog.show(() => <DialogCreateWorkspace project={project} />)
  }

  async function addProjectToWorkspace(workspaceProject: LocalProject) {
    const conn = server.current
    if (!conn) return
    const name = displayName(workspaceProject)
    const workspace = getFilename(workspaceProject.worktree)
    const create = async (directory: string | undefined) => {
      if (!directory) return
      await createWorkspace({ worktree: directory, expanded: true }, workspace || name, workspaceProject)
    }

    pickDirectory({
      server: conn,
      title: language.t("command.project.open"),
      onSelect: (result) => void create((Array.isArray(result) ? result[0] : result) ?? undefined),
    })
  }

  const workspaceSidebarCtx: WorkspaceSidebarContext = {
    currentDir,
    navList: currentSessions,
    sidebarExpanded,
    sidebarHovering,
    clearHoverProjectSoon,
    prefetchSession,
    archiveSession,
    workspaceName,
    renameWorkspace,
    editorOpen,
    openEditor,
    closeEditor,
    setEditor,
    InlineEditor,
    isBusy,
    workspaceExpanded: (directory, local) => store.workspaceExpanded[directory] ?? local,
    setWorkspaceExpanded: (directory, value) => setStore("workspaceExpanded", directory, value),
    showResetWorkspaceDialog: (root, directory) =>
      dialog.show(() => <DialogResetWorkspace root={root} directory={directory} />),
    showRemoveFromWorkspaceDialog: (root, directory) =>
      dialog.show(() => <DialogRemoveFromWorkspace root={root} directory={directory} />),
    isWorkspaceMember: (root, directory) => !!state.memberDirectories[pathKey(root)]?.includes(pathKey(directory)),
    openRemoteVSCode,
    canOpenRemoteVSCode,
    setScrollContainerRef: (el, mobile) => {
      if (!mobile) scrollContainerRef = el
    },
  }

  const projectSidebarCtx: ProjectSidebarContext = {
    currentDir,
    currentProject: sidebarProject,
    sidebarOpened: () => layout.sidebar.opened(),
    sidebarHovering,
    hoverProject: () => state.hoverProject,
    onProjectMouseEnter: (worktree, event) => aim.enter(worktree, event),
    onProjectMouseLeave: (worktree) => aim.leave(worktree),
    onProjectFocus: (worktree) => aim.activate(worktree),
    onHoverOpenChanged: (worktree, hoverOpen) => {
      if (!hoverOpen && state.hoverProject && state.hoverProject !== worktree) return
      setState("hoverProject", hoverOpen ? worktree : undefined)
    },
    navigateToProject,
    openSidebar: () => layout.sidebar.open(),
    closeProject,
    openRemoteVSCode,
    canOpenRemoteVSCode,
    workspacesEnabled: (project) => project.vcs === "git" || isWorkspaceRootProject(project),
    workspaceProject: (project) => {
      if (isWorkspaceRootProject(project)) return true
      const prefix = `${pathKey(project.worktree)}/`
      return workspaceIds(project).some((directory) => pathKey(directory).startsWith(prefix))
    },
    addProjectToWorkspace: (project) => void addProjectToWorkspace(project),
    showCreateWorkspaceDialog,
    projectPending: (directory) =>
      !!state.pendingProjects[pathKey(directory)] || pathKey(state.openingProject ?? "") === pathKey(directory),
    workspaceIds,
    workspaceLabel,
    sessionProps: {
      navList: currentSessions,
      sidebarExpanded,
      clearHoverProjectSoon,
      prefetchSession,
      archiveSession,
    },
  }

  const SidebarPanel = (panelProps: {
    project: Accessor<LocalProject | undefined>
    mobile?: boolean
    merged?: boolean
  }) => {
    const project = panelProps.project
    const merged = createMemo(() => panelProps.mobile || (panelProps.merged ?? layout.sidebar.opened()))
    const hover = createMemo(() => !panelProps.mobile && panelProps.merged === false && !layout.sidebar.opened())
    const empty = createMemo(() => !params.dir && layout.projects.list().length === 0)
    const projectName = createMemo(() => {
      const item = project()
      if (!item) return ""
      return item.name || getFilename(item.worktree)
    })
    const worktree = createMemo(() => project()?.worktree ?? "")
    const slug = createMemo(() => {
      const dir = worktree()
      if (!dir) return ""
      return base64Encode(dir)
    })
    const workspaces = createMemo(() => {
      const item = project()
      if (!item) return [] as string[]
      return workspaceIds(item)
    })
    const workspaceRows = createMemo(() => {
      const item = project()
      if (!item) return [] as string[]
      return workspaces().filter((directory) => pathKey(directory) !== pathKey(item.worktree))
    })
    const workspaceProject = createMemo(() => {
      const item = project()
      if (isWorkspaceRootProject(item)) return true
      const root = worktree()
      if (!root) return false
      const prefix = `${pathKey(root)}/`
      return workspaces().some((directory) => pathKey(directory).startsWith(prefix))
    })
    const unseenCount = createMemo(() =>
      workspaces().reduce((total, directory) => total + notification.project.unseenCount(directory), 0),
    )
    const clearNotifications = () =>
      workspaces()
        .filter((directory) => notification.project.unseenCount(directory) > 0)
        .forEach((directory) => notification.project.markViewed(directory))
    const workspacesEnabled = createMemo(() => {
      const item = project()
      if (!item) return false
      if (item.vcs !== "git" && !isWorkspaceRootProject(item)) return false
      return true
    })
    const homedir = createMemo(() => serverSync().data.path.home)

    return (
      <div
        classList={{
          "flex flex-col min-h-0 min-w-0 box-border rounded-tl-[12px] px-3": true,
          "border border-b-0 border-border-weak-base": !merged(),
          "border-l border-t border-border-weaker-base": merged(),
          "bg-background-base": merged() || hover(),
          "bg-background-stronger": !merged() && !hover(),
          "flex-1 min-w-0": panelProps.mobile,
          "max-w-full overflow-hidden": panelProps.mobile,
        }}
        style={{
          width: panelProps.mobile ? undefined : `${panel()}px`,
        }}
      >
        <Show
          when={project()}
          fallback={
            <Show when={empty()}>
              <div class="flex-1 min-h-0 -mt-4 flex items-center justify-center px-6 pb-64 text-center">
                <div class="mt-8 flex max-w-60 flex-col items-center gap-6 text-center">
                  <div class="flex flex-col gap-3">
                    <div class="text-14-medium text-text-strong">{language.t("sidebar.empty.title")}</div>
                    <div class="text-14-regular text-text-base" style={{ "line-height": "var(--line-height-normal)" }}>
                      {language.t("sidebar.empty.description")}
                    </div>
                  </div>
                  <Button size="large" icon="folder-add-left" onClick={chooseProject}>
                    {language.t("command.project.open")}
                  </Button>
                </div>
              </div>
            </Show>
          }
          keyed
        >
          {(project) => (
            <>
              <div class="shrink-0 pl-1 py-1">
                <div class="group/project flex items-start justify-between gap-2 py-2 pl-2 pr-0">
                  <div class="flex flex-col min-w-0">
                    <span class="text-14-medium text-text-strong truncate">{projectName()}</span>

                    <Tooltip
                      placement="bottom"
                      gutter={2}
                      value={worktree()}
                      class="shrink-0"
                      contentStyle={{
                        "max-width": "640px",
                        transform: "translate3d(52px, 0, 0)",
                      }}
                    >
                      <span class="text-12-regular text-text-base truncate select-text">
                        {worktree().replace(homedir(), "~")}
                      </span>
                    </Tooltip>
                  </div>

                  <DropdownMenu modal={!sidebarHovering()}>
                    <DropdownMenu.Trigger
                      as={IconButton}
                      icon="dot-grid"
                      variant="ghost"
                      data-action="project-menu"
                      data-project={slug()}
                      class="shrink-0 size-6 rounded-md transition-opacity data-[expanded]:bg-surface-base-active"
                      classList={{
                        "opacity-100": panelProps.mobile || merged(),
                        "opacity-0 group-hover/project:opacity-100 group-focus-within/project:opacity-100 data-[expanded]:opacity-100":
                          !panelProps.mobile && !merged(),
                      }}
                      aria-label={language.t("common.moreOptions")}
                    />
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content class="mt-1">
                        <Show when={canOpenRemoteVSCode()}>
                          <DropdownMenu.Item
                            data-action="project-open-vscode"
                            data-project={slug()}
                            onSelect={() => openRemoteVSCode(project.worktree)}
                          >
                            <DropdownMenu.ItemLabel>
                              {language.t("session.header.open.ariaLabel", {
                                app: language.t("session.header.open.app.vscode"),
                              })}
                            </DropdownMenu.ItemLabel>
                          </DropdownMenu.Item>
                        </Show>
                        <Show when={workspacesEnabled()}>
                          <DropdownMenu.Item
                            onSelect={() => {
                              if (workspaceProject()) {
                                void addProjectToWorkspace(project)
                                return
                              }
                              showCreateWorkspaceDialog(project)
                            }}
                          >
                            <DropdownMenu.ItemLabel>
                              {workspaceProject() ? "Add project" : language.t("workspace.new")}
                            </DropdownMenu.ItemLabel>
                          </DropdownMenu.Item>
                        </Show>
                        <DropdownMenu.Item
                          data-action="project-clear-notifications"
                          data-project={slug()}
                          disabled={unseenCount() === 0}
                          onSelect={clearNotifications}
                        >
                          <DropdownMenu.ItemLabel>
                            {language.t("sidebar.project.clearNotifications")}
                          </DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <DropdownMenu.Separator />
                        <DropdownMenu.Item
                          data-action="project-close-menu"
                          data-project={slug()}
                          onSelect={() => {
                            const dir = worktree()
                            if (!dir) return
                            closeProject(dir)
                          }}
                        >
                          <DropdownMenu.ItemLabel>{language.t("common.close")}</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu>
                </div>
              </div>

              <div class="flex-1 min-h-0 flex flex-col">
                <Show
                  when={workspacesEnabled()}
                  fallback={
                    <>
                      <div class="shrink-0 py-4">
                        <Button
                          size="large"
                          class="w-full"
                          onClick={() => {
                            const dir = worktree()
                            if (!dir) return
                            navigateToNewSession(dir)
                          }}
                        >
                          <IconV2 name="edit" size="small" />
                          {language.t("command.session.new")}
                        </Button>
                      </div>
                      <div class="flex-1 min-h-0">
                        <LocalWorkspace
                          ctx={workspaceSidebarCtx}
                          project={project}
                          sortNow={sortNow}
                          mobile={panelProps.mobile}
                        />
                      </div>
                    </>
                  }
                >
                  <>
                    <div class="shrink-0 py-4">
                      <Button
                        size="large"
                        icon="new-session"
                        class="w-full"
                        onClick={() => navigateToNewSession(project.worktree)}
                      >
                        {language.t("command.session.new")}
                      </Button>
                    </div>
                    <div class="relative flex-1 min-h-0">
                      <DragDropProvider
                        onDragStart={handleWorkspaceDragStart}
                        onDragEnd={handleWorkspaceDragEnd}
                        onDragOver={handleWorkspaceDragOver}
                        collisionDetector={closestCenter}
                      >
                        <DragDropSensors />
                        <ConstrainDragXAxis />
                        <div
                          ref={(el) => {
                            if (!panelProps.mobile) scrollContainerRef = el
                          }}
                          class="size-full flex flex-col py-2 gap-4 overflow-y-auto no-scrollbar [overflow-anchor:none]"
                        >
                          <LocalWorkspaceSessions
                            ctx={workspaceSidebarCtx}
                            project={project}
                            sortNow={sortNow}
                            mobile={panelProps.mobile}
                          />
                          <SortableProvider ids={workspaceRows()}>
                            <For each={workspaceRows()}>
                              {(directory) => (
                                <SortableWorkspace
                                  ctx={workspaceSidebarCtx}
                                  directory={directory}
                                  project={project}
                                  sortNow={sortNow}
                                  mobile={panelProps.mobile}
                                />
                              )}
                            </For>
                          </SortableProvider>
                        </div>
                        <DragOverlay>
                          <WorkspaceDragOverlay
                            sidebarProject={sidebarProject}
                            activeWorkspace={() => store.activeWorkspace}
                            workspaceLabel={workspaceLabel}
                          />
                        </DragOverlay>
                      </DragDropProvider>
                    </div>
                  </>
                </Show>
              </div>
            </>
          )}
        </Show>

        <div
          class="shrink-0 px-3 py-3"
          classList={{
            hidden: store.gettingStartedDismissed || !(providers.all().size > 0 && providers.paid().length === 0),
          }}
        >
          <div class="rounded-xl bg-background-base shadow-xs-border-base" data-component="getting-started">
            <div class="p-3 flex flex-col gap-6">
              <div class="flex flex-col gap-2">
                <div class="text-14-medium text-text-strong">{language.t("sidebar.gettingStarted.title")}</div>
                <div class="text-14-regular text-text-base" style={{ "line-height": "var(--line-height-normal)" }}>
                  {language.t("sidebar.gettingStarted.line1")}
                </div>
                <div class="text-14-regular text-text-base" style={{ "line-height": "var(--line-height-normal)" }}>
                  {language.t("sidebar.gettingStarted.line2")}
                </div>
              </div>
              <div data-component="getting-started-actions">
                <Button size="large" icon="plus-small" onClick={connectProvider}>
                  {language.t("command.provider.connect")}
                </Button>
                <Button size="large" variant="ghost" onClick={() => setStore("gettingStartedDismissed", true)}>
                  {language.t("toast.update.action.notYet")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const projects = () => layout.projects.list()
  const projectOverlay = () => <ProjectDragOverlay projects={projects} activeProject={() => store.activeProject} />
  const sidebarContent = (mobile?: boolean) => (
    <SidebarContent
      mobile={mobile}
      opened={() => layout.sidebar.opened()}
      aimMove={aim.move}
      projects={projects}
      renderProject={(project) => (
        <SortableProject ctx={projectSidebarCtx} project={project} sortNow={sortNow} mobile={mobile} />
      )}
      handleDragStart={handleDragStart}
      handleDragEnd={handleDragEnd}
      handleDragOver={handleDragOver}
      openProjectLabel={language.t("command.project.open")}
      openProjectKeybind={() => command.keybind("project.open")}
      onOpenProject={chooseProject}
      renderProjectOverlay={projectOverlay}
      renderPanel={() =>
        mobile ? <SidebarPanel project={sidebarProject} mobile /> : <SidebarPanel project={sidebarProject} merged />
      }
    />
  )

  return (
    <div
      class="relative bg-background-base flex-1 min-h-0 min-w-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
      style={{
        "padding-top": "env(safe-area-inset-top, 0px)",
        "padding-bottom": "env(safe-area-inset-bottom, 0px)",
      }}
    >
      {autoselecting() ?? ""}
      <Titlebar
        update={titlebarUpdate}
        debugTools={
          import.meta.env.DEV && import.meta.env.VITE_DISABLE_DEBUG_BAR !== "1"
            ? { visible: state.debugTools, toggle: () => setState("debugTools", (value) => !value) }
            : undefined
        }
      />
      <Show when={updateVersion() !== undefined}>
        <UpdateAvailableToast version={updateVersion() ?? ""} install={installUpdate} language={language} />
      </Show>
      <div class="flex-1 min-h-0 min-w-0 flex">
        <div class="flex-1 min-h-0 relative">
          <div class="size-full relative overflow-x-hidden">
            <Show when={desktopSidebar()}>
              <nav
                aria-label={language.t("sidebar.nav.projectsAndSessions")}
                data-component="sidebar-nav-desktop"
                class="absolute inset-y-0 start-0 z-10"
                style={{ width: `${side()}px` }}
                ref={(el) => {
                  setState("nav", el)
                }}
                onMouseEnter={() => {
                  disarm()
                }}
                onMouseLeave={() => {
                  aim.reset()
                  if (!sidebarHovering()) return

                  arm(800)
                }}
              >
                <div class="@container w-full h-full contain-strict">{sidebarContent()}</div>
              </nav>
            </Show>

            <Show when={layout.sidebar.opened()}>
              <div
                class="hidden xl:block absolute inset-y-0 z-30 w-0 overflow-visible"
                style={{ "inset-inline-start": `${side()}px` }}
                onPointerDown={() => setState("sizing", true)}
              >
                <ResizeHandle
                  direction="horizontal"
                  size={layout.sidebar.width()}
                  min={244}
                  max={typeof window === "undefined" ? 1000 : window.innerWidth * 0.3 + 64}
                  onResize={(w) => {
                    setState("sizing", true)
                    if (sizet !== undefined) clearTimeout(sizet)
                    sizet = window.setTimeout(() => setState("sizing", false), 120)
                    layout.sidebar.resize(w)
                  }}
                />
              </div>
            </Show>

            <div
              class="hidden xl:block pointer-events-none absolute top-0 end-0 z-0 border-t border-border-weaker-base"
              style={{ "inset-inline-start": "calc(4rem + 12px)" }}
            />

            <Show when={!desktopSidebar()}>
              <div>
                <div
                  classList={{
                    "fixed inset-x-0 z-40 transition-opacity duration-200": true,
                    "opacity-100 pointer-events-auto": layout.mobileSidebar.opened(),
                    "opacity-0 pointer-events-none": !layout.mobileSidebar.opened(),
                  }}
                  style={{
                    top: "calc(2.5rem + env(safe-area-inset-top, 0px))",
                    bottom: "env(safe-area-inset-bottom, 0px)",
                  }}
                  onClick={(e) => {
                    if (e.target === e.currentTarget) layout.mobileSidebar.hide()
                  }}
                />
                <nav
                  aria-label={language.t("sidebar.nav.projectsAndSessions")}
                  data-component="sidebar-nav-mobile"
                  classList={{
                    "@container fixed start-0 z-50 w-full max-w-[400px] overflow-hidden border-e border-border-weaker-base bg-background-base transition-transform duration-200 ease-out": true,
                    "translate-x-0": layout.mobileSidebar.opened(),
                    "ltr:-translate-x-full rtl:translate-x-full": !layout.mobileSidebar.opened(),
                  }}
                  style={{
                    top: "calc(2.5rem + env(safe-area-inset-top, 0px))",
                    bottom: "env(safe-area-inset-bottom, 0px)",
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  {sidebarContent(true)}
                </nav>
              </div>
            </Show>

            <div
              classList={{
                "absolute inset-0": true,
                "xl:inset-y-0 xl:end-0 xl:start-[var(--main-left)]": true,
                "z-20": true,
                "transition-[inset-inline-start] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[inset-inline-start] motion-reduce:transition-none":
                  !state.sizing,
              }}
              style={{
                "--main-left": layout.sidebar.opened() ? `${side()}px` : "4rem",
              }}
            >
              <main
                classList={{
                  "size-full overflow-x-hidden flex flex-col items-start contain-strict border-t border-border-weak-base bg-background-base xl:border-s xl:rounded-ss-[12px]": true,
                }}
              >
                <Show when={!autoselecting.loading} fallback={<div class="size-full" />}>
                  {props.children}
                </Show>
              </main>
            </div>

            <div
              classList={{
                "hidden xl:flex absolute inset-y-0 start-16 z-30": true,
                "opacity-100 translate-x-0 pointer-events-auto": state.peeked && !layout.sidebar.opened(),
                "opacity-0 ltr:-translate-x-2 rtl:translate-x-2 pointer-events-none":
                  !state.peeked || layout.sidebar.opened(),
                "transition-[opacity,transform] motion-reduce:transition-none": true,
                "duration-180 ease-out": state.peeked && !layout.sidebar.opened(),
                "duration-120 ease-in": !state.peeked || layout.sidebar.opened(),
              }}
              onMouseMove={disarm}
              onMouseEnter={() => {
                disarm()
                aim.reset()
              }}
              onPointerDown={disarm}
              onMouseLeave={() => {
                arm()
              }}
            >
              <Show when={peekProject()}>
                <SidebarPanel project={peekProject} merged={false} />
              </Show>
            </div>

            <div
              classList={{
                "hidden xl:block pointer-events-none absolute inset-y-0 end-0 z-25 overflow-hidden": true,
                "opacity-100 translate-x-0": state.peeked && !layout.sidebar.opened(),
                "opacity-0 ltr:-translate-x-2 rtl:translate-x-2": !state.peeked || layout.sidebar.opened(),
                "transition-[opacity,transform] motion-reduce:transition-none": true,
                "duration-180 ease-out": state.peeked && !layout.sidebar.opened(),
                "duration-120 ease-in": !state.peeked || layout.sidebar.opened(),
              }}
              style={{ "inset-inline-start": `calc(4rem + ${panel()}px)` }}
            >
              <div class="h-full w-px" style={{ "box-shadow": "var(--shadow-sidebar-overlay)" }} />
            </div>
          </div>
        </div>
        {import.meta.env.DEV && import.meta.env.VITE_DISABLE_DEBUG_BAR !== "1" && state.debugTools && <DebugBar />}
      </div>
      <TabsInfoPopup />
      <ToastRegion v2={false} />
    </div>
  )
}

function UpdateAvailableToast(props: {
  version: string
  install: () => void
  language: ReturnType<typeof useLanguage>
}) {
  let toastId: number | undefined

  onMount(() => {
    toastId = showToast({
      persistent: true,
      icon: "download",
      title: props.language.t("toast.update.title"),
      description: props.language.t("toast.update.description", { version: props.version }),
      actions: [
        {
          label: props.language.t("toast.update.action.installRestart"),
          onClick: props.install,
        },
        {
          label: props.language.t("toast.update.action.notYet"),
          onClick: "dismiss",
        },
      ],
    })
  })

  onCleanup(() => {
    if (toastId === undefined) return
    dismissToast(toastId)
  })

  return null
}
