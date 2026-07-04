import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, untrack, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { createStore } from "solid-js/store"
import { createMediaQuery } from "@solid-primitives/media"
import { Tabs } from "@opencode-ai/ui/tabs"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon } from "@opencode-ai/ui/icon"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Mark } from "@opencode-ai/ui/logo"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import type { SnapshotFileDiff, VcsFileDiff } from "@opencode-ai/sdk/v2"
import { ConstrainDragYAxis, getDraggableId } from "@/utils/solid-dnd"
import { useDialog } from "@opencode-ai/ui/context/dialog"

import FileTree from "@/components/file-tree"
import { Terminal } from "@/components/terminal"
import { SessionContextUsage } from "@/components/session-context-usage"
import { SessionContextTab, SortableTab, SortableTerminalTab, FileVisual } from "@/components/session"
import { useCommand } from "@/context/command"
import { useFile, type SelectedLineRange } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { useTerminal } from "@/context/terminal"
import { createFileTabListSync } from "@/pages/session/file-tab-scroll"
import { FileTabContent } from "@/pages/session/file-tabs"
import { terminalTabLabel } from "@/pages/session/terminal-label"
import {
  createOpenSessionFileTab,
  createSessionTabs,
  focusTerminalById,
  shouldStealFocusForTerminal,
  getTabReorderIndex,
  shouldShowFileTree,
  type Sizing,
} from "@/pages/session/helpers"
import { setSessionHandoff } from "@/pages/session/handoff"
import { useSessionLayout } from "@/pages/session/session-layout"
import {
  WORKSPACE_PANEL_TAB_BY_ID,
  WORKSPACE_PANEL_TAB_IDS,
  WORKSPACE_PANEL_TABS,
  canonicalWorkspacePanelTab,
  type WorkspacePanelTabID,
} from "@/workspace-tabs/registry"

type RenderDiff = (SnapshotFileDiff & { file: string }) | VcsFileDiff
const PANEL_TERMINAL_TAB = "panel://terminal" satisfies WorkspacePanelTabID
const PANEL_BROWSER_TAB = "panel://browser" satisfies WorkspacePanelTabID
const PANEL_PREVIEW_TAB = "panel://preview" satisfies WorkspacePanelTabID
const PANEL_OPEN_DESIGN_TAB = "panel://open-design" satisfies WorkspacePanelTabID
const PANEL_MAC_VIEW_TAB = "panel://mac-view" satisfies WorkspacePanelTabID
const PANEL_ACCOUNTS_TAB = "panel://accounts" satisfies WorkspacePanelTabID
const PANEL_ROUTINES_TAB = "panel://routines" satisfies WorkspacePanelTabID
const PANEL_ENVIRONMENT_TAB = "panel://environment" satisfies WorkspacePanelTabID
const PANEL_RESOURCES_TAB = "panel://resources" satisfies WorkspacePanelTabID
const PANEL_ARTIFACTS_TAB = "panel://artifacts" satisfies WorkspacePanelTabID
const PANEL_FILE_BROWSER_TAB = "panel://file-browser" satisfies WorkspacePanelTabID
const PANEL_QUEUE_TAB = "panel://queue"
const ARTIFACT_VIEWER_TAB_PREFIX = "artifact://"
const FILE_BROWSER_STATE_KEY = "opencode:workspace-suite:file-browser"
const PREVIEW_STATE_KEY = "opencode:workspace-suite:preview"
const PANEL_TABS = new Set([...WORKSPACE_PANEL_TAB_IDS, PANEL_QUEUE_TAB])
const MOBILE_PANEL_SHELL_MIN_HEIGHT_CLASS = "max-md:min-h-[calc(100svh-5rem)]"
const MOBILE_PANEL_TABS_MIN_HEIGHT_CLASS = "max-md:min-h-[calc(100svh-6rem)]"
const MOBILE_PANEL_CONTENT_MIN_HEIGHT_CLASS = "max-md:min-h-[calc(100svh-8rem)]"
const MOBILE_PANEL_BODY_MIN_HEIGHT_CLASS = "max-md:min-h-[calc(100svh-9rem)]"
const WORKSPACE_PANEL_CONTENT_LAYOUT_CLASS = `flex h-full min-h-0 flex-1 basis-0 flex-col overflow-hidden contain-layout ${MOBILE_PANEL_CONTENT_MIN_HEIGHT_CLASS}`
const WORKSPACE_PANEL_CONTENT_STRICT_CLASS = `flex h-full min-h-0 flex-1 basis-0 flex-col overflow-hidden contain-strict ${MOBILE_PANEL_CONTENT_MIN_HEIGHT_CLASS}`

function renderDiff(value: SnapshotFileDiff | VcsFileDiff): value is RenderDiff {
  return typeof value.file === "string"
}

function isPanelTab(tab: string) {
  return PANEL_TABS.has(tab) || tab.startsWith(ARTIFACT_VIEWER_TAB_PREFIX)
}

function canonicalPanelTab(tab: string) {
  return canonicalWorkspacePanelTab(tab) ?? tab
}

function artifactViewerTab(file: any) {
  return `${ARTIFACT_VIEWER_TAB_PREFIX}${encodeURIComponent(
    JSON.stringify({
      name: file.name,
      path: file.path,
      url: file.url,
      kind: file.kind,
      contentType: file.contentType,
      size: file.size,
    }),
  )}`
}

function artifactFromTab(tab: string) {
  if (!tab.startsWith(ARTIFACT_VIEWER_TAB_PREFIX)) return undefined
  try {
    return JSON.parse(decodeURIComponent(tab.slice(ARTIFACT_VIEWER_TAB_PREFIX.length)))
  } catch {
    return undefined
  }
}

function readFileBrowserState() {
  if (typeof window === "undefined") return {}
  try {
    return JSON.parse(window.localStorage.getItem(FILE_BROWSER_STATE_KEY) || "{}") as {
      currentPath?: string
      mode?: "list" | "icons"
      query?: string
      selectedPath?: string
    }
  } catch {
    return {}
  }
}

function writeFileBrowserState(state: {
  currentPath?: string
  mode: "list" | "icons"
  query: string
  selectedPath?: string
}) {
  if (typeof window === "undefined") return
  window.localStorage.setItem(FILE_BROWSER_STATE_KEY, JSON.stringify(state))
}

function panelTabLabel(tab: string) {
  const artifact = artifactFromTab(tab)
  if (artifact) return artifact.name ?? "Artifact"
  if (tab === PANEL_TERMINAL_TAB) return "Terminal"
  const definition = WORKSPACE_PANEL_TAB_BY_ID[canonicalPanelTab(tab) as WorkspacePanelTabID]
  if (definition) return definition.label
  if (tab === PANEL_QUEUE_TAB) return "Queue"
  return tab
}

function panelTabIcon(tab: string) {
  const artifact = artifactFromTab(tab)
  if (artifact?.kind === "image") return <Icon name="photo" size="small" />
  if (artifact?.kind === "video" || artifact?.kind === "audio") return <Icon name="photo" size="small" />
  if (artifact) return <Icon name="code" size="small" />
  const definition = WORKSPACE_PANEL_TAB_BY_ID[canonicalPanelTab(tab) as WorkspacePanelTabID]
  if (definition?.badge)
    return <span class="text-[9px] leading-none font-semibold tracking-[0]">{definition.badge}</span>
  if (definition?.icon) return <Icon name={definition.icon as any} size="small" />
  if (tab === PANEL_QUEUE_TAB) return <Icon name="checklist" size="small" />
}

function PanelGlyph(props: { tab: string }) {
  return (
    <span class="size-4 shrink-0 inline-flex items-center justify-center text-[#f97316]">
      {panelTabIcon(props.tab)}
    </span>
  )
}

function PanelTab(props: { tab: string; onClose: (tab: string) => void; onActivate: (tab: string) => void }) {
  const command = useCommand()
  const language = useLanguage()
  return (
    <Tabs.Trigger
      value={props.tab}
      data-panel-tab-id={props.tab}
      class="shrink-0"
      classes={{ button: "max-w-44 max-sm:w-9 max-sm:px-0 max-sm:justify-center" }}
      closeButton={
        <TooltipKeybind
          title={language.t("common.closeTab")}
          keybind={command.keybind("tab.close")}
          placement="bottom"
          gutter={10}
        >
          <IconButton
            icon="close-small"
            variant="ghost"
            class="h-5 w-5"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              props.onClose(props.tab)
            }}
            aria-label={language.t("common.closeTab")}
          />
        </TooltipKeybind>
      }
      hideCloseButton
      onClick={() => props.onActivate(props.tab)}
      onMiddleClick={() => props.onClose(props.tab)}
    >
      <div class="flex min-w-0 items-center gap-2">
        <PanelGlyph tab={props.tab} />
        <span class="truncate max-sm:sr-only">{panelTabLabel(props.tab)}</span>
      </div>
    </Tabs.Trigger>
  )
}

function PanelMenuButton(props: { tab: string; onSelect: () => void }) {
  return (
    <button
      type="button"
      data-panel-menu-item-id={props.tab}
      class="flex h-8 w-full items-center gap-2 rounded-md px-3 text-left text-13-regular text-text-base hover:bg-surface-base-hover"
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        props.onSelect()
      }}
    >
      <PanelGlyph tab={props.tab} />
      <span>{panelTabLabel(props.tab)}</span>
    </button>
  )
}

function SessionTerminalTab() {
  const terminal = useTerminal()
  const language = useLanguage()
  const command = useCommand()
  const { view } = useSessionLayout()
  const [store, setStore] = createStore({
    activeDraggable: undefined as string | undefined,
    recovered: {} as Record<string, boolean>,
  })

  createEffect(() => {
    if (view().terminal.opened()) view().terminal.close()
  })

  createEffect(() => {
    if (!terminal.ready()) return
    if (terminal.all().length > 0) return
    terminal.new()
  })

  const all = terminal.all
  const ids = createMemo(() => all().map((pty) => pty.id))

  const focus = (id: string) => {
    const wrapperID = `terminal-wrapper-${id}`
    const tryFocus = () => {
      if (terminal.active() !== id) return
      if (!shouldStealFocusForTerminal(wrapperID)) return
      focusTerminalById(id)
    }
    tryFocus()
    const frame = requestAnimationFrame(tryFocus)
    const timer = window.setTimeout(tryFocus, 180)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
    }
  }

  createEffect(() => {
    const id = terminal.active()
    if (!id) return
    const stop = focus(id)
    onCleanup(stop)
  })

  const recoverTerminal = (key: string, id: string, clone: (id: string) => Promise<void>) => {
    if (store.recovered[key]) return
    setStore("recovered", key, true)
    void clone(id)
  }

  const terminalRecoveryKey = (pty: { id: string; title: string; titleNumber: number }) => {
    return String(pty.titleNumber || pty.title || pty.id)
  }

  const markTerminalConnected = (key: string, id: string, trim: (id: string) => void) => {
    setStore("recovered", key, false)
    trim(id)
  }

  const handleTerminalDragStart = (event: unknown) => {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeDraggable", id)
  }

  const handleTerminalDragOver = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (!draggable || !droppable) return
    const terminals = terminal.all()
    const fromIndex = terminals.findIndex((t) => t.id === draggable.id.toString())
    const toIndex = terminals.findIndex((t) => t.id === droppable.id.toString())
    if (fromIndex !== -1 && toIndex !== -1 && fromIndex !== toIndex) {
      terminal.move(draggable.id.toString(), toIndex)
    }
  }

  const handleTerminalDragEnd = () => {
    setStore("activeDraggable", undefined)
    const activeId = terminal.active()
    if (!activeId) return
    requestAnimationFrame(() => {
      if (terminal.active() !== activeId) return
      focusTerminalById(activeId)
    })
  }

  return (
    <TabChrome
      title="Terminal"
      iconTab={PANEL_TERMINAL_TAB}
      bodyClass="flex min-h-0 flex-1 flex-col overflow-hidden p-0"
    >
      <Show
        when={terminal.ready()}
        fallback={
          <div class="flex-1 flex items-center justify-center text-12-regular text-text-weak">Loading terminal...</div>
        }
      >
        <DragDropProvider
          onDragStart={handleTerminalDragStart}
          onDragEnd={handleTerminalDragEnd}
          onDragOver={handleTerminalDragOver}
          collisionDetector={closestCenter}
        >
          <DragDropSensors />
          <ConstrainDragYAxis />
          <div class="flex min-h-0 flex-1 flex-col">
            <Tabs
              variant="alt"
              value={terminal.active()}
              onChange={(id) => terminal.open(id)}
              class="!h-auto !flex-none"
            >
              <Tabs.List class="h-10 border-b border-border-weaker-base">
                <SortableProvider ids={ids()}>
                  <For each={all()}>{(pty) => <SortableTerminalTab terminal={pty} />}</For>
                </SortableProvider>
                <div class="h-full flex items-center justify-center">
                  <TooltipKeybind
                    title={language.t("command.terminal.new")}
                    keybind={command.keybind("terminal.new")}
                    class="flex items-center"
                  >
                    <IconButton
                      icon="plus-small"
                      variant="ghost"
                      iconSize="large"
                      onClick={terminal.new}
                      aria-label={language.t("command.terminal.new")}
                    />
                  </TooltipKeybind>
                </div>
              </Tabs.List>
            </Tabs>
            <div class="flex-1 min-h-0 relative">
              <Show when={terminal.active()} keyed>
                {(id) => {
                  const ops = terminal.bind()
                  return (
                    <Show when={all().find((pty) => pty.id === id)}>
                      {(pty) => (
                        <div id={`terminal-wrapper-${id}`} class="absolute inset-0">
                          <Terminal
                            pty={pty()}
                            autoFocus
                            onConnect={() => markTerminalConnected(terminalRecoveryKey(pty()), id, ops.trim)}
                            onCleanup={ops.update}
                            onConnectError={() => recoverTerminal(terminalRecoveryKey(pty()), id, ops.clone)}
                          />
                        </div>
                      )}
                    </Show>
                  )
                }}
              </Show>
            </div>
          </div>
          <DragOverlay>
            <Show when={store.activeDraggable} keyed>
              {(id) => (
                <Show when={all().find((pty) => pty.id === id)}>
                  {(t) => (
                    <div class="relative p-1 h-10 flex items-center bg-background-stronger text-14-regular">
                      {terminalTabLabel({
                        title: t().title,
                        titleNumber: t().titleNumber,
                        t: language.t as (key: string, vars?: Record<string, string | number | boolean>) => string,
                      })}
                    </div>
                  )}
                </Show>
              )}
            </Show>
          </DragOverlay>
        </DragDropProvider>
      </Show>
    </TabChrome>
  )
}

type BrowserLaunchRequest = { url: string; nonce: number }

type LiveBrowserStatus = {
  ok?: boolean
  currentURL?: string
  title?: string
  mode?: string
  display?: string
  viewport?: {
    width?: number
    height?: number
  }
  error?: string
  exposureBlocked?: boolean
  requiredAccessBoundary?: string
  streamURL?: string
  proxiedLiveURL?: string
  optimizedViewer?: {
    ok?: boolean
    proxiedURL?: string
    apiBase?: string
  }
  noVNC?: {
    viewer?: string
    defaultMode?: string
    modes?: Record<
      string,
      {
        qualityLevel?: number
        compressionLevel?: number
        scaleViewport?: boolean
        resizeSession?: boolean
        clipViewport?: boolean
        dragViewport?: boolean
        showDotCursor?: boolean
      }
    >
  }
  profilePolicy?: {
    status?: string
    accessBoundaryReady?: boolean
    profileRoot?: string
    persistentAuth?: { enabled?: boolean; status?: string }
    extensions?: { enabled?: boolean; status?: string }
    lastPass?: { enabled?: boolean; status?: string }
    surfaces?: Array<{ id?: string; label?: string; purpose?: string; exposed?: boolean; safeWhilePublic?: boolean }>
  }
  access?: {
    mode?: string
    email?: string | null
    warnings?: string[]
  }
  browserUse?: {
    ok?: boolean
    liveURL?: string
    activeSessions?: number
    health?: {
      browserUseVersion?: string
      model?: string
    }
    error?: string
  }
}

function liveBrowserViewportFromStatus(status?: Pick<LiveBrowserStatus, "viewport">) {
  const width = Number(status?.viewport?.width)
  const height = Number(status?.viewport?.height)
  return {
    width: Number.isFinite(width) && width > 0 ? width : 1920,
    height: Number.isFinite(height) && height > 0 ? height : 1400,
  }
}

function BrowserTabContent(props: { sessionID?: string; launch?: BrowserLaunchRequest }) {
  const narrowBrowser = createMediaQuery("(max-width: 767px)")
  const [streamKey, setStreamKey] = createSignal(Date.now())
  const [status, setStatus] = createSignal<LiveBrowserStatus>({})
  const [browserUrl, setBrowserUrl] = createSignal("")
  const [browserText, setBrowserText] = createSignal("")
  const [selector, setSelector] = createSignal("")
  const [note, setNote] = createSignal("")
  const [browserBusy, setBrowserBusy] = createSignal(false)
  const [browserError, setBrowserError] = createSignal<string | undefined>()
  const [previewReady, setPreviewReady] = createSignal(false)
  const [useNoVNC, setUseNoVNC] = createSignal(true)
  const [vncConnected, setVncConnected] = createSignal(false)
  const [vncFailed, setVncFailed] = createSignal(false)
  const [vncPerformance, setVncPerformance] = createSignal<"fast" | "balanced" | "sharp" | "mobile">(
    narrowBrowser() ? "mobile" : "fast",
  )
  const [annotating, setAnnotating] = createSignal(false)
  const [drawing, setDrawing] = createSignal(false)
  const [lastArtifact, setLastArtifact] = createSignal<{ url: string; name: string } | undefined>()
  let consumedLaunch = 0
  let imageRef: HTMLImageElement | undefined
  let canvasRef: HTMLCanvasElement | undefined

  const browserExposureBlocked = createMemo(() => !!status().exposureBlocked)
  const profilePolicy = createMemo(() => status().profilePolicy)
  const controlsDisabled = createMemo(() => browserBusy() || browserExposureBlocked())
  const liveViewport = createMemo(() => liveBrowserViewportFromStatus(status()))
  const streamSrc = createMemo(() => `${status().streamURL ?? "/experimental/browser/live/stream"}?t=${streamKey()}`)
  const vncPreset = createMemo(() => {
    const fallback = {
      fast: { qualityLevel: 4, compressionLevel: 0, scaleViewport: true, resizeSession: false },
      balanced: { qualityLevel: 6, compressionLevel: 1, scaleViewport: true, resizeSession: false },
      sharp: { qualityLevel: 8, compressionLevel: 2, scaleViewport: true, resizeSession: false },
      mobile: {
        qualityLevel: 4,
        compressionLevel: 0,
        scaleViewport: false,
        resizeSession: false,
        clipViewport: true,
        dragViewport: true,
      },
    }[vncPerformance()]
    return status().noVNC?.modes?.[vncPerformance()] ?? fallback
  })
  const applyVNCPerformanceParams = (value: string) => {
    const parsed = new URL(value, window.location.href)
    const preset = vncPreset()
    parsed.searchParams.set("quality", String(preset.qualityLevel ?? 4))
    parsed.searchParams.set("compression", String(preset.compressionLevel ?? 0))
    parsed.searchParams.set("scaleViewport", String(preset.scaleViewport ?? true))
    parsed.searchParams.set("resizeSession", String(preset.resizeSession ?? false))
    parsed.searchParams.set("clipViewport", String(preset.clipViewport ?? false))
    parsed.searchParams.set("dragViewport", String(preset.dragViewport ?? false))
    parsed.searchParams.set(
      "showDotCursor",
      String(("showDotCursor" in preset ? preset.showDotCursor : undefined) ?? true),
    )
    parsed.searchParams.set("performance", vncPerformance())
    return parsed.toString()
  }
  const interactiveUrl = createMemo(() => {
    if (browserExposureBlocked()) return undefined
    if (!useNoVNC()) return undefined

    const optimized = status().optimizedViewer
    if (optimized?.ok && optimized.proxiedURL) {
      try {
        const parsed = new URL(optimized.proxiedURL, window.location.href)
        if (!(window.location.protocol === "https:" && parsed.protocol !== "https:")) {
          parsed.searchParams.set("frame", String(streamKey()))
          return parsed.toString()
        }
      } catch {
        // fall through to the classic proxied viewer below
      }
    }

    const proxiedURL = status().proxiedLiveURL
    const liveURL = status().browserUse?.liveURL

    const url = proxiedURL || liveURL
    if (!url) return undefined
    try {
      const parsed = new URL(url, window.location.href)
      if (window.location.protocol === "https:" && parsed.protocol !== "https:") return undefined
      parsed.searchParams.set("frame", String(streamKey()))
      return applyVNCPerformanceParams(parsed.toString())
    } catch {
      return undefined
    }
  })

  createEffect(() => {
    const url = interactiveUrl()
    setVncConnected(false)
    setVncFailed(false)
    if (!url || annotating()) return

    const timeout = window.setTimeout(() => {
      if (vncConnected()) return
      setVncFailed(true)
      setUseNoVNC(false)
      setPreviewReady(false)
      setBrowserError("Interactive VNC did not connect; showing screenshot stream fallback.")
    }, 8000)

    onCleanup(() => window.clearTimeout(timeout))
  })

  createEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return
      const data = event.data
      if (!data || typeof data !== "object") return
      if (data.type !== "opencode-browser-vnc") return

      if (data.state === "connected") {
        setVncConnected(true)
        setVncFailed(false)
        setPreviewReady(true)
        setBrowserError(undefined)
        return
      }

      setVncConnected(false)
      if (data.state === "disconnected" || data.state === "credentialsrequired" || data.state === "error") {
        setVncFailed(true)
        setUseNoVNC(false)
        setPreviewReady(false)
        setBrowserError("Interactive VNC disconnected; showing screenshot stream fallback.")
      }
    }

    window.addEventListener("message", onMessage)
    onCleanup(() => window.removeEventListener("message", onMessage))
  })

  const displayUrl = createMemo(() => status().currentURL || browserUrl() || "about:blank")

  const refreshStatus = async () => {
    try {
      const response = await fetch("/experimental/browser/live/status", { cache: "no-store" })
      const body = await response.json().catch(() => ({}))
      setStatus(body)
      if (typeof body.currentURL === "string" && !browserUrl()) setBrowserUrl(body.currentURL)
      if (body.exposureBlocked) setPreviewReady(false)
      setBrowserError(body.error)
    } catch (error) {
      setBrowserError(error instanceof Error ? error.message : String(error))
    }
  }

  const runLiveInput = async (body: Record<string, unknown>) => {
    if (browserExposureBlocked()) {
      setBrowserError(status().error)
      return false
    }
    if (browserBusy()) return false
    setBrowserBusy(true)
    setBrowserError(undefined)
    try {
      const response = await fetch("/experimental/browser/live/input", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok || result?.ok === false) throw new Error(result?.error ?? "Browser action failed")
      await refreshStatus()
      return true
    } catch (error) {
      setBrowserError(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      setBrowserBusy(false)
    }
  }

  const submitBrowserUrl = () => {
    const url = browserUrl().trim()
    if (!url) return
    void runLiveInput({ action: "goto", url })
  }

  const sendBrowserText = () => {
    const text = browserText()
    if (!text) return
    setBrowserText("")
    void runLiveInput({ action: "type", text })
  }

  const browserKey = (key: string) => {
    const aliases: Record<string, string> = {
      ArrowLeft: "ArrowLeft",
      ArrowRight: "ArrowRight",
      ArrowUp: "ArrowUp",
      ArrowDown: "ArrowDown",
      Backspace: "Backspace",
      Delete: "Delete",
      Enter: "Enter",
      Escape: "Escape",
      Tab: "Tab",
    }
    return aliases[key] ?? key
  }

  const pointForEvent = (event: MouseEvent) => {
    const image = imageRef
    if (!image) return
    const rect = image.getBoundingClientRect()
    const viewport = liveViewport()
    const width = image.naturalWidth || viewport.width
    const height = image.naturalHeight || viewport.height
    const x = Math.round(((event.clientX - rect.left) / rect.width) * width)
    const y = Math.round(((event.clientY - rect.top) / rect.height) * height)
    return { x, y }
  }

  const handleViewportClick: JSX.EventHandler<HTMLDivElement, MouseEvent> = (event) => {
    event.currentTarget.focus()
    if (annotating()) return
    const point = pointForEvent(event)
    if (!point) return
    void runLiveInput({ action: "click", ...point })
  }

  const handleViewportWheel: JSX.EventHandler<HTMLDivElement, WheelEvent> = (event) => {
    event.preventDefault()
    void runLiveInput({ action: "scroll", deltaX: event.deltaX, deltaY: event.deltaY })
  }

  const handleViewportKeyDown: JSX.EventHandler<HTMLDivElement, KeyboardEvent> = (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || browserBusy()) return
    if (event.key.length === 1) {
      event.preventDefault()
      void runLiveInput({ action: "type", text: event.key })
      return
    }

    const allowed = new Set([
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Backspace",
      "Delete",
      "Enter",
      "Escape",
      "Tab",
    ])
    if (!allowed.has(event.key)) return
    event.preventDefault()
    void runLiveInput({ action: "key", key: browserKey(event.key) })
  }

  const resizeCanvas = () => {
    const canvas = canvasRef
    const image = imageRef
    if (!canvas || !image) return
    const rect = image.getBoundingClientRect()
    const ratio = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.round(rect.width * ratio))
    canvas.height = Math.max(1, Math.round(rect.height * ratio))
    canvas.style.width = `${rect.width}px`
    canvas.style.height = `${rect.height}px`
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.scale(ratio, ratio)
    ctx.lineCap = "round"
    ctx.lineJoin = "round"
    ctx.lineWidth = 3
    ctx.strokeStyle = "#f97316"
  }

  const annotationPoint = (event: PointerEvent) => {
    const canvas = canvasRef
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  const startAnnotation: JSX.EventHandler<HTMLCanvasElement, PointerEvent> = (event) => {
    const canvas = canvasRef
    const point = annotationPoint(event)
    if (!canvas || !point) return
    canvas.setPointerCapture(event.pointerId)
    setDrawing(true)
    const ctx = canvas.getContext("2d")
    ctx?.beginPath()
    ctx?.moveTo(point.x, point.y)
  }

  const drawAnnotation: JSX.EventHandler<HTMLCanvasElement, PointerEvent> = (event) => {
    if (!drawing()) return
    const point = annotationPoint(event)
    const ctx = canvasRef?.getContext("2d")
    if (!point || !ctx) return
    ctx.lineTo(point.x, point.y)
    ctx.stroke()
  }

  const stopAnnotation: JSX.EventHandler<HTMLCanvasElement, PointerEvent> = () => setDrawing(false)

  const clearAnnotation = () => {
    const canvas = canvasRef
    const ctx = canvas?.getContext("2d")
    if (!canvas || !ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
  }

  const captureAnnotatedDataURL = async () => {
    const image = imageRef
    const canvas = canvasRef
    if (!image) return undefined
    const out = document.createElement("canvas")
    out.width = image.naturalWidth || 1280
    out.height = image.naturalHeight || 889
    const ctx = out.getContext("2d")
    if (!ctx) return undefined
    await image.decode().catch(() => undefined)
    ctx.drawImage(image, 0, 0, out.width, out.height)
    if (canvas) ctx.drawImage(canvas, 0, 0, out.width, out.height)
    return out.toDataURL("image/png")
  }

  const saveScreenshot = async (attach: boolean) => {
    if (!props.sessionID || browserBusy()) return
    setBrowserBusy(true)
    setBrowserError(undefined)
    try {
      const annotationDataURL = annotating() ? await captureAnnotatedDataURL() : undefined
      const response = await fetch(`/experimental/browser/${encodeURIComponent(props.sessionID)}/live/screenshot`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ annotationDataURL, note: note().trim(), selector: selector().trim() }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body?.ok === false) throw new Error(body?.error ?? "Screenshot failed")
      setLastArtifact({ url: body.url, name: body.name })
      if (attach) {
        const dataUrl = annotationDataURL || (await captureAnnotatedDataURL())
        if (dataUrl) {
          window.dispatchEvent(
            new CustomEvent("opencode:add-image-attachment", {
              detail: {
                dataUrl,
                filename: body.name || "browser-screenshot.png",
                mime: "image/png",
                sourcePath: body.path,
              },
            }),
          )
        }
      }
    } catch (error) {
      setBrowserError(error instanceof Error ? error.message : String(error))
    } finally {
      setBrowserBusy(false)
    }
  }

  const highlightSelector = async () => {
    const value = selector().trim()
    if (!value || browserBusy()) return
    setBrowserBusy(true)
    setBrowserError(undefined)
    try {
      const response = await fetch("/experimental/browser/live/selector", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ selector: value }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body?.ok === false) throw new Error(body?.error ?? "Selector not found")
    } catch (error) {
      setBrowserError(error instanceof Error ? error.message : String(error))
    } finally {
      setBrowserBusy(false)
    }
  }

  createEffect(() => {
    void refreshStatus()
    const interval = window.setInterval(() => {
      void refreshStatus()
    }, 2500)
    onCleanup(() => window.clearInterval(interval))
  })

  createEffect(() => {
    if (narrowBrowser() && vncPerformance() === "fast") setVncPerformance("mobile")
  })

  createEffect(() => {
    if (!annotating()) return
    resizeCanvas()
    const onResize = () => resizeCanvas()
    window.addEventListener("resize", onResize)
    onCleanup(() => window.removeEventListener("resize", onResize))
  })

  createEffect(() => {
    const launch = props.launch
    if (!launch?.url || launch.nonce === consumedLaunch) return
    consumedLaunch = launch.nonce
    setBrowserUrl(launch.url)
    void runLiveInput({ action: "goto", url: launch.url })
  })

  return (
    <TabChrome
      iconTab={PANEL_BROWSER_TAB}
      headerClass="h-12 shrink-0 border-b border-border-weaker-base bg-background-stronger px-2 py-1.5"
      bodyClass="relative flex h-full min-h-0 flex-1 basis-0 overflow-hidden bg-background-base p-0"
      toolbar={
        <div class="flex h-full min-w-0 items-center gap-1 rounded-md border border-border-weaker-base bg-background-base px-1.5">
          <IconButton
            icon="arrow-left"
            variant="ghost"
            class="h-7 w-7 shrink-0"
            disabled={controlsDisabled()}
            onClick={() => void runLiveInput({ action: "back" })}
            aria-label="Back"
          />
          <IconButton
            icon="arrow-right"
            variant="ghost"
            class="h-7 w-7 shrink-0"
            disabled={controlsDisabled()}
            onClick={() => void runLiveInput({ action: "forward" })}
            aria-label="Forward"
          />
          <IconButton
            icon="reset"
            variant="ghost"
            class="h-7 w-7 shrink-0"
            disabled={controlsDisabled()}
            onClick={() => void runLiveInput({ action: "reload" })}
            aria-label="Reload page"
          />
          <form
            class="flex min-w-0 flex-1 items-center"
            onSubmit={(event) => {
              event.preventDefault()
              submitBrowserUrl()
            }}
          >
            <input
              value={browserUrl() || status().currentURL || ""}
              onInput={(event) => setBrowserUrl(event.currentTarget.value)}
              class="h-8 min-w-0 flex-1 bg-transparent px-2 text-13-regular text-text-strong outline-none"
              placeholder="Search or enter URL"
            />
            <IconButton
              icon="enter"
              variant="ghost"
              class="h-7 w-7 shrink-0"
              disabled={controlsDisabled()}
              onClick={submitBrowserUrl}
              aria-label="Open URL"
            />
          </form>
          <div class="hidden min-w-0 items-center gap-1 md:flex">
            <span class="max-w-40 truncate px-1 text-11-regular text-text-weak">
              {browserExposureBlocked()
                ? "blocked"
                : browserBusy()
                  ? "working"
                  : useNoVNC() && vncConnected() && !annotating()
                    ? "interactive VNC"
                    : vncFailed()
                      ? "stream fallback"
                      : previewReady()
                        ? "screenshot stream"
                        : "connecting"}
            </span>
            <span
              class="h-2 w-2 shrink-0 rounded-full"
              classList={{
                "bg-[#f97316]": !!status().browserUse?.ok && !browserExposureBlocked(),
                "bg-text-disabled": !status().browserUse?.ok || browserExposureBlocked(),
              }}
              title={
                browserExposureBlocked()
                  ? "Browser exposure blocked"
                  : status().browserUse?.ok
                    ? "Browser Use ready"
                    : "Browser Use unavailable"
              }
            />
          </div>
          <IconButton
            icon="photo"
            variant="ghost"
            class="h-7 w-7 shrink-0"
            disabled={controlsDisabled()}
            onClick={() => void saveScreenshot(false)}
            aria-label="Save screenshot"
          />
          <IconButton
            icon="pencil-line"
            variant="ghost"
            class="h-7 w-7 shrink-0"
            disabled={controlsDisabled()}
            onClick={() => setAnnotating(!annotating())}
            aria-label={annotating() ? "Stop annotating" : "Annotate screenshot"}
          />
          <IconButton
            icon="share"
            variant="ghost"
            class="h-7 w-7 shrink-0"
            disabled={controlsDisabled()}
            onClick={() => void saveScreenshot(true)}
            aria-label="Send screenshot to chat"
          />
          <details class="group relative shrink-0" data-prevent-autofocus>
            <summary class="flex h-7 w-7 cursor-pointer list-none items-center justify-center rounded text-text-weak hover:bg-surface-raised-base-hover hover:text-text-strong [&::-webkit-details-marker]:hidden">
              <Icon name="sliders" size="small" />
            </summary>
            <div class="absolute right-0 top-9 z-20 flex w-[min(520px,calc(100vw-2rem))] flex-col gap-2 rounded-md border border-border-weaker-base bg-background-stronger p-2 shadow-lg">
              <form
                class="flex items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  sendBrowserText()
                }}
              >
                <Icon name="keyboard" size="small" />
                <input
                  value={browserText()}
                  onInput={(event) => setBrowserText(event.currentTarget.value)}
                  class="h-8 min-w-0 flex-1 rounded border border-border-weaker-base bg-background-base px-2 text-13-regular text-text-strong outline-none"
                  placeholder="Type into focused page"
                />
                <IconButton
                  icon="enter"
                  variant="ghost"
                  class="h-8 w-8"
                  disabled={controlsDisabled() || !browserText()}
                  onClick={sendBrowserText}
                  aria-label="Type into page"
                />
              </form>
              <form
                class="flex items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  void highlightSelector()
                }}
              >
                <Icon name="selector" size="small" />
                <input
                  value={selector()}
                  onInput={(event) => setSelector(event.currentTarget.value)}
                  class="h-8 min-w-0 flex-1 rounded border border-border-weaker-base bg-background-base px-2 text-13-regular text-text-strong outline-none"
                  placeholder="CSS selector to highlight"
                />
                <IconButton
                  icon="enter"
                  variant="ghost"
                  class="h-8 w-8"
                  disabled={controlsDisabled() || !selector()}
                  onClick={highlightSelector}
                  aria-label="Highlight selector"
                />
              </form>
              <input
                value={note()}
                onInput={(event) => setNote(event.currentTarget.value)}
                class="h-8 rounded border border-border-weaker-base bg-background-base px-2 text-13-regular text-text-strong outline-none"
                placeholder="Optional screenshot note"
              />
              <div class="flex flex-wrap items-center gap-2 text-12-regular text-text-weak">
                <span class="text-text-strong">Browser Use</span>
                <span>{status().browserUse?.ok ? "ready" : "unavailable"}</span>
                <Show when={status().browserUse?.health?.browserUseVersion}>
                  {(version) => <span>v{version()}</span>}
                </Show>
                <Show when={status().browserUse?.health?.model}>{(model) => <span>{model()}</span>}</Show>
                <Show when={status().browserUse?.activeSessions !== undefined}>
                  <span>{status().browserUse?.activeSessions} sessions</span>
                </Show>
                <Show when={status().proxiedLiveURL || status().browserUse?.liveURL}>
                  <button
                    class="ml-auto rounded px-2 py-0.5 text-text-strong hover:bg-surface-raised-base-hover disabled:text-text-disabled"
                    type="button"
                    disabled={browserExposureBlocked()}
                    onClick={() => {
                      setPreviewReady(false)
                      setVncConnected(false)
                      setVncFailed(false)
                      setBrowserError(undefined)
                      setUseNoVNC(!useNoVNC())
                    }}
                  >
                    {useNoVNC() ? "Use screenshot stream" : "Use interactive VNC"}
                  </button>
                </Show>
                <Show when={status().browserUse?.liveURL}>
                  {(url) => (
                    <button
                      class="rounded px-2 py-0.5 text-text-strong hover:bg-surface-raised-base-hover disabled:text-text-disabled"
                      type="button"
                      disabled={browserExposureBlocked()}
                      onClick={() => window.open(url(), "_blank", "noopener,noreferrer")}
                    >
                      Open VNC viewer
                    </button>
                  )}
                </Show>
              </div>
              <div class="flex flex-wrap items-center gap-2 text-12-regular text-text-weak">
                <span class="text-text-strong">VNC performance</span>
                <For
                  each={
                    [
                      { id: "fast", label: "Fast" },
                      { id: "balanced", label: "Balanced" },
                      { id: "sharp", label: "Sharp" },
                      { id: "mobile", label: "Mobile" },
                    ] as const
                  }
                >
                  {(mode) => (
                    <button
                      class="rounded px-2 py-0.5 hover:bg-surface-raised-base-hover"
                      classList={{
                        "bg-surface-raised-base text-text-strong": vncPerformance() === mode.id,
                        "text-text-weak": vncPerformance() !== mode.id,
                      }}
                      type="button"
                      onClick={() => {
                        setPreviewReady(false)
                        setVncConnected(false)
                        setVncFailed(false)
                        setBrowserError(undefined)
                        setUseNoVNC(true)
                        setVncPerformance(mode.id)
                      }}
                    >
                      {mode.label}
                    </button>
                  )}
                </For>
                <span class="ml-auto">
                  {vncPreset().qualityLevel ?? 4}q / {vncPreset().compressionLevel ?? 0}c
                </span>
              </div>
              <div class="grid grid-cols-1 gap-2 text-12-regular text-text-weak md:grid-cols-3">
                <StatusPill
                  label="Profile"
                  value={profilePolicy()?.persistentAuth?.status ?? "unknown"}
                  active={!!profilePolicy()?.persistentAuth?.enabled}
                />
                <StatusPill
                  label="Extensions"
                  value={profilePolicy()?.extensions?.status ?? "unknown"}
                  active={!!profilePolicy()?.extensions?.enabled}
                />
                <StatusPill
                  label="LastPass"
                  value={profilePolicy()?.lastPass?.status ?? "unknown"}
                  active={!!profilePolicy()?.lastPass?.enabled}
                />
              </div>
              <Show when={browserError()}>
                {(error) => <div class="text-12-regular text-text-weak break-all">{error()}</div>}
              </Show>
              <Show when={(status().access?.warnings ?? []).length > 0}>
                <div class="rounded border border-[#f97316]/30 bg-[#f97316]/10 p-2 text-12-regular text-[#f97316]">
                  <For each={status().access?.warnings ?? []}>{(warning) => <div>{warning}</div>}</For>
                </div>
              </Show>
              <Show when={lastArtifact()}>
                {(artifact) => (
                  <div class="text-12-regular text-text-weak">
                    Saved{" "}
                    <a class="text-text-strong underline" href={artifact().url} target="_blank" rel="noreferrer">
                      {artifact().name}
                    </a>
                  </div>
                )}
              </Show>
            </div>
          </details>
          <IconButton
            icon="square-arrow-top-right"
            variant="ghost"
            class="h-7 w-7 shrink-0"
            disabled={!displayUrl()}
            onClick={() => window.open(displayUrl(), "_blank", "noopener,noreferrer")}
            aria-label="Open in external browser"
          />
        </div>
      }
    >
      <div
        class="absolute inset-0 bg-background-base outline-none"
        tabIndex={0}
        onClick={handleViewportClick}
        onWheel={handleViewportWheel}
        onKeyDown={handleViewportKeyDown}
      >
        <Show
          when={!browserExposureBlocked()}
          fallback={
            <div class="flex size-full items-center justify-center p-6 text-center">
              <div class="max-w-md rounded-md border border-border-weaker-base bg-background-stronger p-4">
                <div class="mx-auto mb-3 flex h-9 w-9 items-center justify-center rounded-full bg-[#f97316]/15 text-11-medium text-[#f97316]">
                  LOCK
                </div>
                <div class="text-14-medium text-text-strong">Browser exposure is blocked</div>
                <div class="mt-2 text-13-regular text-text-weak">
                  {status().error ??
                    "Live browser viewing and control are disabled until code.hustletogether.com is protected by Cloudflare Access."}
                </div>
                <div class="mt-3 text-12-regular text-text-weak">
                  {status().requiredAccessBoundary ?? "Cloudflare Access GitHub login for code.hustletogether.com"}
                </div>
                <div class="mt-4 grid grid-cols-1 gap-2 text-left">
                  <StatusPill
                    label="Profile"
                    value={profilePolicy()?.persistentAuth?.status ?? "blocked"}
                    active={!!profilePolicy()?.persistentAuth?.enabled}
                  />
                  <StatusPill
                    label="Extensions"
                    value={profilePolicy()?.extensions?.status ?? "blocked"}
                    active={!!profilePolicy()?.extensions?.enabled}
                  />
                  <StatusPill
                    label="LastPass"
                    value={profilePolicy()?.lastPass?.status ?? "blocked"}
                    active={!!profilePolicy()?.lastPass?.enabled}
                  />
                </div>
                <Show when={profilePolicy()?.profileRoot}>
                  {(profileRoot) => <div class="mt-3 break-all text-11-regular text-text-weak">{profileRoot()}</div>}
                </Show>
              </div>
            </div>
          }
        >
          <Show when={!previewReady() && (!interactiveUrl() || annotating())}>
            <div class="absolute inset-0 flex items-center justify-center text-center text-12-regular text-text-weak">
              Starting CDP live Chromium...
            </div>
          </Show>
          <Show
            when={!annotating() && useNoVNC() && !vncFailed() ? interactiveUrl() : undefined}
            fallback={
              <div class="relative size-full min-h-0 overflow-auto">
                <img
                  ref={(el) => (imageRef = el)}
                  src={streamSrc()}
                  alt="Live Chromium browser"
                  class="block h-auto w-full select-none"
                  classList={{ invisible: !previewReady() }}
                  onLoad={() => {
                    setPreviewReady(true)
                    if (annotating()) resizeCanvas()
                  }}
                  onError={() => setPreviewReady(false)}
                />
              </div>
            }
          >
            {(url) => (
              <iframe
                src={url()}
                title="Interactive Chromium browser"
                class="absolute inset-0 block h-full w-full border-0 bg-white"
                allow="clipboard-read; clipboard-write"
                onLoad={() => {
                  setPreviewReady(false)
                }}
              />
            )}
          </Show>
          <Show when={annotating()}>
            <canvas
              ref={(el) => (canvasRef = el)}
              class="absolute left-0 top-0 cursor-crosshair touch-none"
              onPointerDown={startAnnotation}
              onPointerMove={drawAnnotation}
              onPointerUp={stopAnnotation}
              onPointerCancel={stopAnnotation}
            />
            <button
              class="absolute right-3 top-3 rounded bg-background-base px-2 py-1 text-12-regular text-text-strong shadow"
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                clearAnnotation()
              }}
            >
              Clear
            </button>
          </Show>
        </Show>
      </div>
    </TabChrome>
  )
}

function readPreviewState() {
  if (typeof window === "undefined") return {}
  try {
    return JSON.parse(window.localStorage.getItem(PREVIEW_STATE_KEY) || "{}") as { url?: string }
  } catch {
    return {}
  }
}

function writePreviewState(state: { url?: string }) {
  if (typeof window === "undefined") return
  window.localStorage.setItem(PREVIEW_STATE_KEY, JSON.stringify(state))
}

function normalizePreviewURL(value: string) {
  const input = value.trim()
  if (!input) return ""
  if (input.startsWith("/") || /^[a-z]+:\/\//i.test(input)) return input
  if (input.includes("localhost") || input.includes("127.0.0.1") || input.includes("100.")) return `http://${input}`
  return `https://${input}`
}

function previewURLKind(value: string) {
  if (!value) return "empty"
  if (value.startsWith("/")) return "same-origin"
  try {
    const parsed = new URL(value, window.location.origin)
    if (parsed.origin === window.location.origin) return "same-origin"
    if (
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname.startsWith("100.") ||
      parsed.hostname.endsWith(".tailf704e2.ts.net")
    )
      return "local"
    return "external"
  } catch {
    return "invalid"
  }
}

function previewIframeSrc(url: string, kind: string) {
  if (kind !== "local") return url
  try {
    const parsed = new URL(url, window.location.origin)
    // CT100-local apps are unreachable from the viewer's machine; route them
    // through the same-origin preview proxy served by opencode-public-proxy.
    return `/experimental/preview/proxy/${parsed.host}${parsed.pathname}${parsed.search}`
  } catch {
    return url
  }
}

function PreviewTabContent(props: { sessionID?: string }) {
  const initial = readPreviewState().url ?? ""
  const [address, setAddress] = createSignal(initial)
  const [currentURL, setCurrentURL] = createSignal(initial)
  const [lastPreviewStateAt, setLastPreviewStateAt] = createSignal<string | undefined>()
  const [externalMode, setExternalMode] = createSignal<"idle" | "loading" | "ready" | "failed">("idle")
  const [externalError, setExternalError] = createSignal<string | undefined>()
  const [externalKey, setExternalKey] = createSignal(Date.now())
  const [externalViewport, setExternalViewport] = createSignal({ width: 1920, height: 1400 })
  let externalImageRef: HTMLImageElement | undefined
  const currentKind = createMemo(() => previewURLKind(currentURL()))
  const externalStreamURL = createMemo(() =>
    props.sessionID
      ? `/experimental/browser/${encodeURIComponent(props.sessionID)}/screenshot?t=${externalKey()}`
      : `/experimental/browser/live/stream?t=${externalKey()}`,
  )
  const previewStateURL = createMemo(() =>
    props.sessionID ? `/experimental/preview/${encodeURIComponent(props.sessionID)}/state` : undefined,
  )
  const previewActionURL = createMemo(() =>
    props.sessionID ? `/experimental/preview/${encodeURIComponent(props.sessionID)}/action` : undefined,
  )

  const syncPreviewState = async () => {
    const url = previewStateURL()
    if (!url) return
    const response = await fetch(url, { cache: "no-store" }).catch(() => undefined)
    if (!response?.ok) return
    const state = await response.json().catch(() => undefined)
    const stateURL = typeof state?.url === "string" ? state.url : ""
    const updatedAt = typeof state?.updatedAt === "string" ? state.updatedAt : undefined
    if (!stateURL || !updatedAt || updatedAt === lastPreviewStateAt()) return
    setLastPreviewStateAt(updatedAt)
    if (stateURL !== currentURL()) {
      setAddress(stateURL)
      setCurrentURL(stateURL)
    }
  }

  const writePreviewServerState = async (url: string) => {
    const stateURL = previewStateURL()
    if (!stateURL) return
    const response = await fetch(stateURL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, action: "navigate", source: "client" }),
    }).catch(() => undefined)
    if (!response?.ok) return
    const state = await response.json().catch(() => undefined)
    if (typeof state?.updatedAt === "string") setLastPreviewStateAt(state.updatedAt)
  }

  const runExternalInput = async (body: Record<string, unknown>) => {
    const actionURL = previewActionURL()
    if (!actionURL) throw new Error("Preview actions require an active session.")
    const response = await fetch(actionURL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok || result?.ok === false) throw new Error(result?.error ?? "External preview action failed")
    setExternalKey(Date.now())
  }

  const refreshExternalViewport = async () => {
    const response = await fetch("/experimental/browser/live/status", { cache: "no-store" }).catch(() => undefined)
    if (!response?.ok) return
    const body = await response.json().catch(() => undefined)
    setExternalViewport(liveBrowserViewportFromStatus(body))
  }

  const externalPointForEvent = (event: MouseEvent) => {
    const image = externalImageRef
    if (!image) return
    const rect = image.getBoundingClientRect()
    const viewport = externalViewport()
    const width = image.naturalWidth || viewport.width
    const height = image.naturalHeight || viewport.height
    return {
      x: Math.round(((event.clientX - rect.left) / rect.width) * width),
      y: Math.round(((event.clientY - rect.top) / rect.height) * height),
    }
  }

  const handleExternalClick: JSX.EventHandler<HTMLDivElement, MouseEvent> = (event) => {
    event.currentTarget.focus()
    const point = externalPointForEvent(event)
    if (!point) return
    void runExternalInput({ action: "click", ...point }).catch((error) => {
      setExternalError(error instanceof Error ? error.message : String(error))
      setExternalMode("failed")
    })
  }

  const handleExternalWheel: JSX.EventHandler<HTMLDivElement, WheelEvent> = (event) => {
    event.preventDefault()
    void runExternalInput({ action: "scroll", deltaX: event.deltaX, deltaY: event.deltaY }).catch((error) => {
      setExternalError(error instanceof Error ? error.message : String(error))
      setExternalMode("failed")
    })
  }

  const handleExternalKeyDown: JSX.EventHandler<HTMLDivElement, KeyboardEvent> = (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key.length === 1) {
      event.preventDefault()
      void runExternalInput({ action: "type", text: event.key }).catch((error) => {
        setExternalError(error instanceof Error ? error.message : String(error))
        setExternalMode("failed")
      })
      return
    }
    if (
      !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Backspace", "Delete", "Enter", "Escape", "Tab"].includes(
        event.key,
      )
    )
      return
    event.preventDefault()
    void runExternalInput({ action: "key", key: event.key }).catch((error) => {
      setExternalError(error instanceof Error ? error.message : String(error))
      setExternalMode("failed")
    })
  }

  createEffect(() => writePreviewState({ url: currentURL() || address() }))

  void syncPreviewState()
  const previewStateTimer = window.setInterval(() => void syncPreviewState(), 2000)
  onCleanup(() => window.clearInterval(previewStateTimer))

  createEffect(() => {
    const url = currentURL()
    if (!url || currentKind() !== "external") {
      setExternalMode("idle")
      setExternalError(undefined)
      return
    }
    setExternalMode("loading")
    setExternalError(undefined)
    void refreshExternalViewport()
    runExternalInput({ action: "goto", url })
      .then(() => {
        setExternalMode("ready")
      })
      .catch((error) => {
        setExternalError(error instanceof Error ? error.message : String(error))
        setExternalMode("failed")
      })
  })

  const openAddress = () => {
    const next = normalizePreviewURL(address())
    setAddress(next)
    setCurrentURL(next)
    if (next) void writePreviewServerState(next)
  }

  const refreshPreview = () => {
    const current = currentURL()
    if (!current) return
    setCurrentURL("")
    queueMicrotask(() => setCurrentURL(current))
  }

  return (
    <TabChrome
      iconTab={PANEL_PREVIEW_TAB}
      headerClass="h-12 shrink-0 border-b border-border-weaker-base bg-background-stronger px-2 py-1.5"
      bodyClass="relative flex h-full min-h-0 flex-1 basis-0 overflow-hidden"
      toolbar={
        <div class="flex h-full min-w-0 items-center gap-1 rounded-md border border-border-weaker-base bg-background-base px-1.5">
          <form
            class="flex min-w-0 flex-1 items-center"
            onSubmit={(event) => {
              event.preventDefault()
              openAddress()
            }}
          >
            <input
              value={address()}
              onInput={(event) => setAddress(event.currentTarget.value)}
              class="h-8 min-w-0 flex-1 bg-transparent px-2 text-13-regular text-text-strong outline-none"
              placeholder="Preview URL, route, or local app"
            />
            <IconButton
              icon="enter"
              variant="ghost"
              class="h-7 w-7 shrink-0"
              disabled={!address().trim()}
              onClick={openAddress}
              aria-label="Open preview URL"
            />
          </form>
          <IconButton
            icon="reset"
            variant="ghost"
            class="h-7 w-7 shrink-0"
            disabled={!currentURL()}
            onClick={refreshPreview}
            aria-label="Refresh preview"
          />
          <IconButton
            icon="square-arrow-top-right"
            variant="ghost"
            class="h-7 w-7 shrink-0"
            disabled={!currentURL()}
            onClick={() => window.open(currentURL(), "_blank", "noopener,noreferrer")}
            aria-label="Open preview externally"
          />
        </div>
      }
    >
      <Show
        when={currentURL()}
        fallback={
          <div class="flex flex-1 items-center justify-center p-6 text-center text-13-regular text-text-weak">
            Enter a hosted route, project URL, or local preview URL.
          </div>
        }
      >
        {(url) => (
          <Show
            when={currentKind() !== "external"}
            fallback={
              <div
                class="absolute inset-0 overflow-auto bg-background-base outline-none"
                tabIndex={0}
                onClick={handleExternalClick}
                onWheel={handleExternalWheel}
                onKeyDown={handleExternalKeyDown}
              >
                <Show
                  when={externalMode() !== "failed"}
                  fallback={
                    <div class="flex size-full items-center justify-center p-6 text-center">
                      <div class="max-w-md rounded-lg border border-border-weaker-base bg-background-base p-5 text-13-regular text-text-weak">
                        <div class="mb-2 text-14-medium text-text-strong">External preview failed</div>
                        <div>{externalError() ?? "The Chromium preview renderer could not open this URL."}</div>
                        <div class="mt-4 flex justify-center gap-2">
                          <button
                            type="button"
                            class="rounded-md border border-border-weaker-base px-3 py-1.5 text-12-regular text-text-strong hover:bg-surface-raised-base-hover"
                            onClick={() => window.open(url(), "_blank", "noopener,noreferrer")}
                          >
                            Open external
                          </button>
                        </div>
                      </div>
                    </div>
                  }
                >
                  <Show when={externalMode() === "loading"}>
                    <div class="absolute inset-0 z-10 flex items-center justify-center bg-background-base/70 text-12-regular text-text-weak">
                      Opening external site in Chromium preview...
                    </div>
                  </Show>
                  <img
                    ref={(el) => (externalImageRef = el)}
                    src={externalStreamURL()}
                    alt="External site preview"
                    class="block w-full select-none bg-white object-contain"
                    style={{ "aspect-ratio": `${externalViewport().width} / ${externalViewport().height}` }}
                    onLoad={() => setExternalMode("ready")}
                    onError={() => {
                      setExternalError("Chromium preview stream is unavailable.")
                      setExternalMode("failed")
                    }}
                  />
                  <div class="absolute bottom-3 left-3 rounded bg-background-base/90 px-2 py-1 text-11-regular text-text-weak shadow">
                    external-browser-render
                  </div>
                </Show>
              </div>
            }
          >
            <>
              <iframe
                src={previewIframeSrc(url(), currentKind())}
                title="Preview"
                class="absolute inset-0 block h-full w-full border-0 bg-white"
                sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-downloads"
                allow="clipboard-read; clipboard-write"
              />
              <Show when={currentKind() === "local"}>
                <div class="absolute bottom-3 left-3 rounded bg-background-base/90 px-2 py-1 text-11-regular text-text-weak shadow">
                  proxied via CT100
                </div>
              </Show>
            </>
          </Show>
        )}
      </Show>
    </TabChrome>
  )
}

function createPolledJson<T>(url: () => string | undefined, intervalMs = 10000, timeoutMs = 8000) {
  const [data, setData] = createSignal<T | undefined>()
  const [error, setError] = createSignal<string | undefined>()
  const [pending, setPending] = createSignal(false)
  const refresh = async () => {
    const current = url()
    if (!current) return
    if (pending()) return
    setPending(true)
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(current, { cache: "no-store", signal: controller.signal })
      const body = await response.json()
      if (!response.ok) throw new Error(JSON.stringify(body))
      setData(() => body as T)
      setError(undefined)
    } catch (err) {
      setError(
        err instanceof DOMException && err.name === "AbortError"
          ? `Timed out loading ${current}`
          : err instanceof Error
            ? err.message
            : String(err),
      )
    } finally {
      window.clearTimeout(timer)
      setPending(false)
    }
  }
  createEffect(() => {
    if (!url()) return
    void refresh()
    const timer = window.setInterval(() => void refresh(), intervalMs)
    onCleanup(() => window.clearInterval(timer))
  })
  return { data, error, pending, refresh }
}

function StatusRow(props: { label: string; value?: string | number | boolean | null }) {
  return (
    <div class="rounded-md border border-border-weaker-base bg-background-stronger p-3">
      <div class="text-12-regular text-text-weak">{props.label}</div>
      <div class="text-14-regular text-text-strong break-all">{String(props.value ?? "Not available")}</div>
    </div>
  )
}

function StatusPill(props: { label: string; value?: string | number | boolean | null; active?: boolean }) {
  return (
    <div class="min-w-0 rounded-md border border-border-weaker-base bg-background-base px-2.5 py-2">
      <div class="flex min-w-0 items-center gap-2">
        <span
          class="h-2 w-2 shrink-0 rounded-full"
          classList={{ "bg-[#f97316]": !!props.active, "bg-text-disabled": !props.active }}
        />
        <span class="shrink-0 text-11-medium text-text-strong">{props.label}</span>
      </div>
      <div class="mt-1 truncate text-11-regular text-text-weak">
        {String(props.value ?? "unknown").replaceAll("_", " ")}
      </div>
    </div>
  )
}

function TabChrome(props: {
  title?: string
  iconTab: string
  onRefresh?: () => void
  actions?: JSX.Element
  toolbar?: JSX.Element
  headerClass?: string
  bodyClass?: string
  children: JSX.Element
}) {
  const [toolsOpen, setToolsOpen] = createSignal(false)
  const definition = createMemo(
    () => WORKSPACE_PANEL_TAB_BY_ID[canonicalPanelTab(props.iconTab) as WorkspacePanelTabID],
  )
  const hasHeader = createMemo(() => !!props.title || !!props.toolbar || !!props.onRefresh || !!props.actions)
  const copyTabState = async () => {
    const tab = definition()
    if (!tab || typeof navigator === "undefined" || !navigator.clipboard) return
    await navigator.clipboard.writeText(
      JSON.stringify(
        {
          tab,
          tool: "workspace_tabs",
          examples: [
            { action: "state", tab: tab.id },
            { action: "open", tab: tab.id },
            { action: "run_action", tab: tab.id, tabAction: tab.actions[0] },
          ],
        },
        null,
        2,
      ),
    )
  }
  const MenuButton = (props: { label: string; children: JSX.Element }) => (
    <MenuV2 gutter={5} modal={false} placement="bottom-start">
      <MenuV2.Trigger class="h-7 rounded-md px-1.5 text-11-regular text-text-weak outline-none hover:bg-surface-base-hover hover:text-text-strong data-[expanded]:bg-surface-base-active data-[expanded]:text-text-strong sm:px-2 sm:text-12-regular">
        {props.label}
      </MenuV2.Trigger>
      <MenuV2.Portal>
        <MenuV2.Content class="min-w-[220px] max-w-[min(320px,calc(100vw-1rem))]">{props.children}</MenuV2.Content>
      </MenuV2.Portal>
    </MenuV2>
  )
  const ToolsModal = () => (
    <Show when={definition()}>
      {(tab) => (
        <Portal>
          <div
            class="fixed inset-0 z-[1200] flex items-center justify-center bg-background-base/60 p-4 backdrop-blur-sm"
            onPointerDown={() => setToolsOpen(false)}
          >
            <div
              class="flex max-h-[min(720px,calc(100vh-2rem))] w-[min(720px,calc(100vw-2rem))] flex-col overflow-hidden rounded-lg border border-border-base bg-background-stronger shadow-2xl"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <div class="flex min-w-0 items-center gap-3 border-b border-border-weaker-base px-4 py-3">
                <PanelGlyph tab={tab().id} />
                <div class="min-w-0 flex-1">
                  <div class="text-14-medium text-text-strong">{tab().label} Tools</div>
                  <div class="truncate text-12-regular text-text-weak">{tab().description}</div>
                </div>
                <IconButton
                  icon="close-small"
                  variant="ghost"
                  class="h-7 w-7"
                  onClick={() => setToolsOpen(false)}
                  aria-label="Close tools"
                />
              </div>
              <div class="grid min-h-0 gap-3 overflow-auto p-4 md:grid-cols-2">
                <div class="rounded-md border border-border-weaker-base bg-background-base p-3">
                  <div class="mb-2 text-13-medium text-text-strong">LLM Tools</div>
                  <div class="flex flex-wrap gap-1.5">
                    <For each={tab().toolIDs}>
                      {(tool) => (
                        <span class="rounded bg-background-stronger px-2 py-1 text-11-regular text-text-strong">
                          @{tool}
                        </span>
                      )}
                    </For>
                  </div>
                </div>
                <div class="rounded-md border border-border-weaker-base bg-background-base p-3">
                  <div class="mb-2 text-13-medium text-text-strong">Mentions</div>
                  <div class="flex flex-wrap gap-1.5">
                    <For each={tab().mentionIDs}>
                      {(mention) => (
                        <span class="rounded bg-background-stronger px-2 py-1 text-11-regular text-text-strong">
                          @{mention}
                        </span>
                      )}
                    </For>
                  </div>
                </div>
                <div class="rounded-md border border-border-weaker-base bg-background-base p-3 md:col-span-2">
                  <div class="mb-2 text-13-medium text-text-strong">Registry Actions</div>
                  <div class="flex flex-wrap gap-1.5">
                    <For each={tab().actions}>
                      {(action) => (
                        <span class="rounded bg-background-stronger px-2 py-1 text-11-regular text-text-weak">
                          {action.replaceAll("_", " ")}
                        </span>
                      )}
                    </For>
                  </div>
                </div>
                <div class="rounded-md border border-border-weaker-base bg-background-base p-3 md:col-span-2">
                  <div class="mb-2 text-13-medium text-text-strong">Tool Contract</div>
                  <pre class="max-h-56 overflow-auto whitespace-pre-wrap rounded bg-background-stronger p-3 text-11-regular text-text-weak">
                    {JSON.stringify(
                      {
                        tool: "workspace_tabs",
                        examples: [
                          { action: "open", tab: tab().id },
                          { action: "focus", tab: tab().id },
                          { action: "run_action", tab: tab().id, tabAction: tab().actions[0] },
                          { action: "attach_to_chat", tab: tab().id },
                        ],
                        canSnapshot: tab().canSnapshot,
                        canAttachToChat: tab().canAttachToChat,
                        safetyPolicy: tab().safetyPolicy,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </div>
              </div>
            </div>
          </div>
        </Portal>
      )}
    </Show>
  )
  const PanelTopMenus = () => (
    <Show when={definition()}>
      {(tab) => (
        <div class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-visible pr-1 [scrollbar-width:none]">
          <MenuButton label="Tab">
            <MenuV2.Group>
              <MenuV2.GroupLabel>{tab().label}</MenuV2.GroupLabel>
              <MenuV2.Item disabled>{tab().id}</MenuV2.Item>
              <MenuV2.Separator />
              <MenuV2.Item onSelect={() => setToolsOpen(true)}>Show tab tools</MenuV2.Item>
              <MenuV2.Item onSelect={() => void copyTabState()}>Copy tab JSON</MenuV2.Item>
            </MenuV2.Group>
            <MenuV2.Separator />
            <MenuV2.Group>
              <MenuV2.GroupLabel>Open Workspace Tab</MenuV2.GroupLabel>
              <For each={WORKSPACE_PANEL_TABS.filter((item) => !item.hidden)}>
                {(item) => (
                  <MenuV2.Item
                    data-panel-menu-item-id={`topbar:${item.id}`}
                    onSelect={() => {
                      window.dispatchEvent(
                        new CustomEvent("opencode:workspace-tab-action", {
                          detail: {
                            type: "workspace_tab",
                            action: "open",
                            tab: item.id,
                            source: "panel-topbar",
                            actionID: `topbar-${Date.now()}`,
                          },
                        }),
                      )
                    }}
                  >
                    <span class="flex min-w-0 items-center gap-2">
                      <PanelGlyph tab={item.id} />
                      <span class="truncate">{item.label}</span>
                    </span>
                  </MenuV2.Item>
                )}
              </For>
            </MenuV2.Group>
          </MenuButton>
          <MenuButton label="View">
            <MenuV2.Group>
              <MenuV2.GroupLabel>View</MenuV2.GroupLabel>
              <MenuV2.Item disabled>{tab().description}</MenuV2.Item>
              <MenuV2.Separator />
              <MenuV2.Item disabled={!props.onRefresh} onSelect={() => props.onRefresh?.()}>
                Refresh
              </MenuV2.Item>
              <MenuV2.Item disabled={!tab().canSnapshot}>Snapshot available</MenuV2.Item>
            </MenuV2.Group>
          </MenuButton>
          <MenuButton label="Tools">
            <MenuV2.Group>
              <MenuV2.GroupLabel>LLM-visible tools</MenuV2.GroupLabel>
              <For each={tab().toolIDs}>{(tool) => <MenuV2.Item disabled>@{tool}</MenuV2.Item>}</For>
              <MenuV2.Separator />
              <MenuV2.Item onSelect={() => setToolsOpen(true)}>Open tools details</MenuV2.Item>
            </MenuV2.Group>
          </MenuButton>
          <MenuButton label="Actions">
            <MenuV2.Group>
              <MenuV2.GroupLabel>Actions</MenuV2.GroupLabel>
              <For each={tab().actions}>
                {(action) => <MenuV2.Item disabled>{action.replaceAll("_", " ")}</MenuV2.Item>}
              </For>
              <MenuV2.Separator />
              <MenuV2.Item disabled>{tab().safetyPolicy}</MenuV2.Item>
            </MenuV2.Group>
          </MenuButton>
          <Show when={toolsOpen()}>
            <ToolsModal />
          </Show>
        </div>
      )}
    </Show>
  )
  return (
    <div
      class={`flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background-base ${MOBILE_PANEL_SHELL_MIN_HEIGHT_CLASS}`}
      data-workspace-panel-shell={props.iconTab}
    >
      <Show when={hasHeader()}>
        <div
          class={
            props.headerClass ??
            "flex min-h-10 shrink-0 items-center justify-between gap-2 border-b border-border-weaker-base px-3 py-1"
          }
        >
          <Show
            when={props.toolbar}
            fallback={
              <>
                <div class="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                  <PanelTopMenus />
                  <Show when={props.title}>
                    {(title) => (
                      <div class="hidden min-w-0 items-center gap-2 text-14-medium text-text-strong xl:flex">
                        <PanelGlyph tab={props.iconTab} />
                        <span class="truncate">{title()}</span>
                      </div>
                    )}
                  </Show>
                </div>
                <div class="hidden shrink-0 items-center gap-1 xl:flex">
                  {props.actions}
                  <Show when={!!props.onRefresh}>
                    <IconButton
                      icon="reset"
                      variant="ghost"
                      class="h-7 w-7"
                      onClick={() => props.onRefresh?.()}
                      aria-label="Refresh"
                    />
                  </Show>
                </div>
              </>
            }
          >
            {(toolbar) => (
              <div class="flex h-full min-w-0 flex-1 items-center gap-2 overflow-hidden">
                <PanelTopMenus />
                <div class="min-w-0 flex-1">{toolbar()}</div>
              </div>
            )}
          </Show>
        </div>
      </Show>
      <div
        class={`${props.bodyClass ?? "flex h-full min-h-0 flex-1 basis-0 flex-col overflow-auto p-3"} ${MOBILE_PANEL_BODY_MIN_HEIGHT_CLASS}`}
        data-workspace-panel-body={props.iconTab}
      >
        {props.children}
      </div>
    </div>
  )
}

function OpenDesignTabContent(
  props: {
    bridgeState?: () => any
    onBridgeState?: (state: any) => void
  } = {},
) {
  const status = createPolledJson<any>(() => "/experimental/open-design/status")
  const [frameKey, setFrameKey] = createSignal(Date.now())
  const [localBridgeState, setLocalBridgeState] = createSignal<any>({ mode: "dashboard", active: false })
  const bridgeState = createMemo(() => props.bridgeState?.() ?? localBridgeState())
  const launchUrl = createMemo(() => {
    if (status.data()?.proxyReady === false) return undefined
    return status.data()?.proxyURL ?? "/experimental/open-design/proxy/"
  })
  const externalUrl = createMemo(() => status.data()?.publicURL ?? "https://design.hustletogether.com")
  const frameUrl = createMemo(() => {
    const base = launchUrl()
    if (!base) return undefined
    const url = new URL(base, window.location.origin)
    url.searchParams.set("embed", "opencode")
    url.searchParams.set("focus", "1")
    url.searchParams.set("parentOrigin", window.location.origin)
    url.searchParams.set("t", String(frameKey()))
    return url.toString()
  })
  const canEmbed = createMemo(() => !!launchUrl())
  const stateLabel = createMemo(() => {
    if (status.error()) return "offline"
    if (bridgeState()?.active) return "design mode"
    if (bridgeState()?.mode === "dashboard") return "dashboard"
    if (status.data()?.health?.ok) return "interactive"
    return "checking"
  })
  const bridgeSummary = createMemo(() => {
    const state = bridgeState()
    if (state?.active) {
      const project = state.projectName || state.projectId || "OpenDesign project"
      const chat = state.chatName || state.chatId
      return chat ? `${project} / ${chat}` : project
    }
    if (state?.mode === "dashboard") return "Dashboard"
    return "Waiting for bridge"
  })

  const openExternal = () => window.open(externalUrl(), "_blank", "noopener,noreferrer")
  const refresh = () => {
    status.refresh()
    setFrameKey(Date.now())
  }

  createEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data
      if (!data || typeof data !== "object" || data.type !== "opendesign:bridge-state") return
      const next = {
        ...(data.payload ?? {}),
        origin: event.origin,
        receivedAt: new Date().toISOString(),
      }
      setLocalBridgeState(next)
      props.onBridgeState?.(next)
    }
    window.addEventListener("message", onMessage)
    onCleanup(() => window.removeEventListener("message", onMessage))
  })

  return (
    <TabChrome
      iconTab={PANEL_OPEN_DESIGN_TAB}
      headerClass="h-12 shrink-0 border-b border-border-weaker-base bg-background-stronger px-2 py-1.5"
      bodyClass="relative flex h-full min-h-0 flex-1 basis-0 overflow-hidden"
      toolbar={
        <div class="flex h-full min-w-0 items-center gap-1 rounded-md border border-border-weaker-base bg-background-base px-1.5">
          <PanelGlyph tab={PANEL_OPEN_DESIGN_TAB} />
          <div class="min-w-0 flex-1 truncate px-2 text-13-regular text-text-strong">
            {launchUrl() ?? "Open Design proxy disabled"}
          </div>
          <Show when={bridgeState()?.active}>
            <span class="hidden shrink-0 rounded-full border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 text-11-medium text-blue-300 md:inline-flex">
              Design Mode
            </span>
          </Show>
          <span class="hidden max-w-56 shrink truncate px-1 text-11-regular text-text-weak lg:block">
            {bridgeSummary()}
          </span>
          <span class="hidden shrink-0 items-center gap-1 px-1 text-11-regular text-text-weak md:flex">
            <span
              class="h-2 w-2 rounded-full"
              classList={{
                "bg-blue-400": stateLabel() === "design mode",
                "bg-[#f97316]": stateLabel() === "interactive" || stateLabel() === "dashboard",
                "bg-text-disabled":
                  stateLabel() !== "design mode" && stateLabel() !== "interactive" && stateLabel() !== "dashboard",
              }}
            />
            {stateLabel()}
          </span>
          <IconButton
            icon="reset"
            variant="ghost"
            class="h-7 w-7 shrink-0"
            onClick={refresh}
            aria-label="Refresh Open Design"
          />
          <IconButton
            icon="square-arrow-top-right"
            variant="ghost"
            class="h-7 w-7 shrink-0"
            onClick={openExternal}
            aria-label="Open Open Design externally"
          />
          <details class="group relative shrink-0" data-prevent-autofocus>
            <summary class="flex h-7 w-7 cursor-pointer list-none items-center justify-center rounded text-text-weak hover:bg-surface-raised-base-hover hover:text-text-strong [&::-webkit-details-marker]:hidden">
              <Icon name="sliders" size="small" />
            </summary>
            <div class="absolute right-0 top-9 z-20 grid w-[min(420px,calc(100vw-2rem))] grid-cols-1 gap-2 rounded-md border border-border-weaker-base bg-background-stronger p-2 shadow-lg md:grid-cols-2">
              <StatusRow label="Daemon" value={status.data()?.daemonURL} />
              <StatusRow
                label="Frame mode"
                value={status.data()?.frameMode ?? (status.data()?.proxyReady === false ? "external blocked" : "proxy")}
              />
              <StatusRow label="Proxy" value={status.data()?.proxyReady ? "enabled" : "disabled"} />
              <StatusRow label="API token" value={status.data()?.tokenConfigured ? "configured" : "not configured"} />
              <StatusRow label="Health" value={status.data()?.health?.ok ? "healthy" : "not ready"} />
              <StatusRow label="Projects" value={status.data()?.projects?.count} />
              <StatusRow label="Bridge" value={stateLabel()} />
              <StatusRow label="Active project/chat" value={bridgeSummary()} />
            </div>
          </details>
        </div>
      }
    >
      <Show when={status.error()}>
        {(error) => (
          <div class="m-3 rounded-md border border-border-weaker-base bg-background-stronger p-3 text-12-regular text-text-weak">
            {error()}
          </div>
        )}
      </Show>
      <div class="absolute inset-0 overflow-hidden bg-background-base">
        <div class="absolute inset-0 overflow-hidden bg-background-stronger">
          <Show
            when={canEmbed()}
            fallback={
              <div class="flex h-full min-h-[360px] items-center justify-center p-5 text-center">
                <div class="max-w-md">
                  <div class="mx-auto mb-3 flex h-9 w-9 items-center justify-center rounded-full bg-[#f97316]/15 text-11-medium text-[#f97316]">
                    OD
                  </div>
                  <div class="text-14-medium text-text-strong">Open Design is not available</div>
                  <div class="mt-2 text-13-regular text-text-weak">
                    The embedded Open Design proxy is disabled or unavailable. Direct public embedding is blocked by
                    Cloudflare Access frame protection, so use the external route while the proxy is unavailable.
                  </div>
                  <button
                    type="button"
                    class="mt-4 rounded-md border border-border-weaker-base px-3 py-1.5 text-12-medium text-text-strong hover:bg-surface-raised-base-hover"
                    onClick={openExternal}
                  >
                    Open externally
                  </button>
                  <Show when={status.data()?.routeNote}>
                    {(note) => <div class="mt-3 text-12-regular text-text-weak">{note()}</div>}
                  </Show>
                  <Show when={status.data()?.frameBlockedReason}>
                    {(reason) => <div class="mt-3 text-12-regular text-text-weak">{reason()}</div>}
                  </Show>
                </div>
              </div>
            }
          >
            <iframe
              src={frameUrl() ?? "about:blank"}
              title="Open Design"
              class="absolute inset-0 block h-full w-full border-0 bg-white"
              allow="clipboard-read; clipboard-write"
            />
          </Show>
        </div>
      </div>
    </TabChrome>
  )
}

function MacViewTabContent() {
  const status = createPolledJson<any>(() => "/experimental/mac-view/status")
  const [streamKey, setStreamKey] = createSignal(Date.now())
  const [fps, setFps] = createSignal(30)
  const [width, setWidth] = createSignal(1280)
  const [quality, setQuality] = createSignal(8)
  const [bitrate, setBitrate] = createSignal(6000)
  const [transport, setTransport] = createSignal<"webrtc" | "video" | "mjpeg">("webrtc")
  const [transportTouched, setTransportTouched] = createSignal(false)
  const streamReconnectMs = 30_000

  const reconnect = setInterval(() => setStreamKey(Date.now()), streamReconnectMs)
  onCleanup(() => clearInterval(reconnect))

  createEffect(() => {
    const next = Number(status.data()?.fps)
    if (!Number.isFinite(next)) return
    setFps(next)
  })
  createEffect(() => {
    const next = Number(status.data()?.width)
    if (!Number.isFinite(next)) return
    setWidth(next)
  })
  createEffect(() => {
    const next = Number(status.data()?.quality)
    if (!Number.isFinite(next)) return
    setQuality(next)
  })
  createEffect(() => {
    const next = Number(status.data()?.bitrate)
    if (!Number.isFinite(next)) return
    setBitrate(next)
  })
  createEffect(() => {
    if (transportTouched()) return
    const next = status.data()?.transportOptions?.includes("webrtc") ? "webrtc" : status.data()?.transport
    if (next === "webrtc" || next === "video" || next === "mjpeg") setTransport(next)
  })

  const saveSettings = async (
    patch: Partial<{
      fps: number
      width: number
      quality: number
      bitrate: number
      transport: "webrtc" | "video" | "mjpeg"
    }>,
  ) => {
    const next = {
      fps: fps(),
      width: width(),
      quality: quality(),
      bitrate: bitrate(),
      transport: transport(),
      ...patch,
    }
    setFps(next.fps)
    setWidth(next.width)
    setQuality(next.quality)
    setBitrate(next.bitrate)
    setTransport(next.transport)
    if (patch.transport) setTransportTouched(true)
    setStreamKey(Date.now())
    try {
      const response = await fetch("/experimental/mac-view/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body?.ok === false) throw new Error(body?.error ?? "Mac View settings update failed")
      const settings = body.settings ?? next
      setFps(Number(settings.fps) || next.fps)
      setWidth(Number(settings.width) || next.width)
      setQuality(Number(settings.quality) || next.quality)
      setBitrate(Number(settings.bitrate) || next.bitrate)
      if (settings.transport === "webrtc" || settings.transport === "video" || settings.transport === "mjpeg")
        setTransport(settings.transport)
      void status.refresh()
    } catch {
      void status.refresh()
    } finally {
      setStreamKey(Date.now())
    }
  }

  const transportURL = createMemo(() =>
    transport() === "webrtc"
      ? `${status.data()?.webrtcURL ?? "/experimental/mac-view/webrtc/mac-view/"}?fps=${fps()}&width=${width()}&bitrate=${bitrate()}&t=${streamKey()}`
      : transport() === "video"
        ? `/experimental/mac-view/video?fps=${fps()}&width=${width()}&bitrate=${bitrate()}&t=${streamKey()}`
        : `/experimental/mac-view/stream?fps=${fps()}&width=${width()}&quality=${quality()}&t=${streamKey()}`,
  )
  const nativeCaptureLabel = createMemo(() =>
    status.data()?.nativeCapture?.available ? "SCK ready" : "SCK unavailable",
  )
  const webRTCLabel = createMemo(() =>
    status.data()?.webrtc?.status === "enabled"
      ? "WebRTC live"
      : status.data()?.webrtc?.status === "ready"
        ? "WebRTC ready"
        : "WebRTC held",
  )

  return (
    <TabChrome
      iconTab={PANEL_MAC_VIEW_TAB}
      headerClass="h-10 shrink-0 flex items-center justify-between gap-3 px-3 border-b border-border-weaker-base bg-background-stronger"
      bodyClass="flex h-full min-h-0 flex-1 basis-0 overflow-hidden"
      toolbar={
        <>
          <div class="flex min-w-0 items-center gap-2 text-14-medium text-text-strong">
            <PanelGlyph tab={PANEL_MAC_VIEW_TAB} />
            <span>Mac View</span>
            <span class="truncate text-12-regular text-text-weak">
              {status.data()?.health?.ok
                ? `${status.data()?.health?.body?.mode ?? "live"} · ${transport()} · ${width()}px${transport() === "video" ? ` · ${bitrate()}k` : ` · q${quality()}`}`
                : (status.data()?.note ?? "checking")}
            </span>
            <span class="hidden items-center gap-1 rounded bg-background-base px-1.5 py-0.5 text-11-regular text-text-weak md:inline-flex">
              {nativeCaptureLabel()}
            </span>
            <span class="hidden items-center gap-1 rounded bg-background-base px-1.5 py-0.5 text-11-regular text-text-weak md:inline-flex">
              {webRTCLabel()}
            </span>
          </div>
          <div class="flex min-w-0 items-center gap-1">
            <div class="hidden items-center gap-1 md:flex" aria-label="Mac View FPS">
              <For each={status.data()?.fpsOptions ?? [6, 12, 20, 30, 45, 60]}>
                {(option: number) => (
                  <button
                    type="button"
                    class="h-7 rounded px-2 text-11-regular"
                    classList={{
                      "bg-background-base text-text-strong": fps() === option,
                      "text-text-weak hover:bg-surface-raised-base-hover hover:text-text-strong": fps() !== option,
                    }}
                    onClick={() => void saveSettings({ fps: option })}
                  >
                    {option} fps
                  </button>
                )}
              </For>
            </div>
            <select
              class="hidden h-7 rounded-md border border-border-weaker-base bg-background-base px-2 text-11-regular text-text-strong md:block"
              value={width()}
              onChange={(event) => void saveSettings({ width: Number(event.currentTarget.value) })}
              aria-label="Mac View width"
            >
              <For each={status.data()?.widthOptions ?? [960, 1280, 1600]}>
                {(option: number) => <option value={option}>{option}px</option>}
              </For>
            </select>
            <select
              class="hidden h-7 rounded-md border border-border-weaker-base bg-background-base px-2 text-11-regular text-text-strong md:block"
              value={quality()}
              onChange={(event) => void saveSettings({ quality: Number(event.currentTarget.value) })}
              aria-label="Mac View quality"
            >
              <For each={status.data()?.qualityOptions ?? [6, 8, 10, 12]}>
                {(option: number) => <option value={option}>q{option}</option>}
              </For>
            </select>
            <select
              class="h-7 rounded-md border border-border-weaker-base bg-background-base px-2 text-11-regular text-text-strong"
              value={transport()}
              onChange={(event) => {
                const next = event.currentTarget.value
                setTransportTouched(true)
                void saveSettings({ transport: next === "webrtc" ? "webrtc" : next === "mjpeg" ? "mjpeg" : "video" })
              }}
              aria-label="Mac View transport"
            >
              <For each={status.data()?.transportOptions ?? ["webrtc", "video"]}>
                {(option: string) => (
                  <option value={option}>
                    {option === "webrtc" ? "WebRTC" : option === "video" ? "Video" : "MJPEG"}
                  </option>
                )}
              </For>
            </select>
            <select
              class="hidden h-7 rounded-md border border-border-weaker-base bg-background-base px-2 text-11-regular text-text-strong md:block"
              value={bitrate()}
              onChange={(event) => void saveSettings({ bitrate: Number(event.currentTarget.value) })}
              aria-label="Mac View bitrate"
            >
              <For each={status.data()?.bitrateOptions ?? [2500, 4000, 6000, 8000, 12000]}>
                {(option: number) => <option value={option}>{option}k</option>}
              </For>
            </select>
            <IconButton
              icon="reset"
              variant="ghost"
              class="h-7 w-7"
              onClick={() => {
                void status.refresh()
                setStreamKey(Date.now())
              }}
              aria-label="Refresh Mac View"
            />
            <Show when={status.data()?.feedURL}>
              {(feedURL) => (
                <IconButton
                  icon="square-arrow-top-right"
                  variant="ghost"
                  class="h-7 w-7"
                  onClick={() => window.open(feedURL(), "_blank", "noopener,noreferrer")}
                  aria-label="Open feed externally"
                />
              )}
            </Show>
          </div>
        </>
      }
    >
      <Show
        when={status.data()?.configured}
        fallback={
          <div class="flex flex-1 items-center justify-center p-6 text-center text-13-regular text-text-weak">
            Mac View needs OPENCODE_MAC_VIEW_URL pointed at the ScreenCaptureKit helper.
          </div>
        }
      >
        <div class="min-h-0 flex-1 overflow-auto bg-background-base">
          <Switch>
            <Match when={transport() === "webrtc"}>
              <iframe
                src={transportURL()}
                title="Mac View WebRTC"
                class="block h-full min-h-[520px] w-full border-0 bg-black"
                allow="autoplay; fullscreen; clipboard-read; clipboard-write"
                onLoad={() => void status.refresh()}
              />
            </Match>
            <Match when={transport() === "video"}>
              <video
                src={transportURL()}
                autoplay
                muted
                playsinline
                class="block h-auto w-full bg-black"
                onError={() => {
                  if (transport() !== "video") return
                  setTransportTouched(true)
                  setTransport(status.data()?.transportOptions?.includes("webrtc") ? "webrtc" : "mjpeg")
                  setStreamKey(Date.now())
                  void status.refresh()
                }}
              />
            </Match>
            <Match when={transport() === "mjpeg"}>
              <img
                src={transportURL()}
                alt="Live Mac screen"
                class="block h-auto w-full select-none"
                onError={() => {
                  if (transport() !== "mjpeg") return
                  if (status.data()?.transportOptions?.includes("webrtc")) {
                    setTransportTouched(true)
                    setTransport("webrtc")
                    setStreamKey(Date.now())
                  }
                  void status.refresh()
                }}
              />
            </Match>
          </Switch>
        </div>
      </Show>
    </TabChrome>
  )
}

function AccountsTabContent() {
  const status = createPolledJson<any>(() => "/experimental/workspace-suite/status", 30000, 5000)
  const codexStatus = createPolledJson<any>(() => "/experimental/codex-multi-auth/status", 8000, 8000)
  const workspace = createPolledJson<any>(() => "/__workspace-index", 15000, 6000)
  const [loginStarting, setLoginStarting] = createSignal(false)
  const [loginResult, setLoginResult] = createSignal<any>()
  const [proofStarting, setProofStarting] = createSignal(false)
  const [proofResult, setProofResult] = createSignal<any>()
  const codexAccounts = createMemo(() => status.data()?.codexAccounts ?? codexStatus.data())
  const authPanel = createMemo(() => loginResult() ?? codexAccounts()?.loginAttempt)
  const codexAccountCount = createMemo(() => {
    const count = codexAccounts()?.accountCount
    return typeof count === "number" ? count : 0
  })
  const codexAccountList = createMemo(() => (Array.isArray(codexAccounts()?.accounts) ? codexAccounts().accounts : []))
  const codexRuntimeReady = createMemo(() => codexAccounts()?.runtimeReady === true)
  const codexRouting = createMemo(() => codexAccounts()?.sendRouting ?? "unknown")
  const codexStorePath = createMemo(() => codexAccounts()?.accountStore?.path ?? null)
  const codexBaseProviderVisibility = createMemo(() => codexAccounts()?.baseProviderVisibility)
  const codexForcedAccount = createMemo(() => codexAccounts()?.forcedAccount ?? null)
  const codexForcedUntilLabel = createMemo(() => {
    const forcedUntil = codexAccounts()?.forcedUntil
    if (typeof forcedUntil !== "number") return null
    return new Date(forcedUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  })
  const codexBaseProviderLabel = createMemo(() => {
    const visibility = codexBaseProviderVisibility()
    if (!visibility) return "unknown"
    return visibility.hidden ? "hidden by Codex Multi-Auth" : "visible"
  })
  const codexStatusLabel = createMemo(() => {
    const accounts = codexAccounts()
    if (!accounts?.configured) return "not configured"
    if (!accounts?.ok) return "status error"
    if (codexAccountCount() > 0) return "ready"
    if (accounts.statusPhase === "account_written_or_already_authorized") return "verify account"
    if (accounts.statusPhase === "failed_before_device_code" || accounts.statusPhase === "failed_after_device_code")
      return "auth failed"
    return "needs account"
  })
  const codexStatusStrong = createMemo(() => !!codexAccounts()?.ok && codexAccountCount() > 0)

  const startCodexLogin = async () => {
    setLoginStarting(true)
    try {
      const response = await fetch("/experimental/codex-multi-auth/login", { method: "POST" })
      const body = await response.json()
      setLoginResult(body)
      void codexStatus.refresh()
    } catch (error) {
      setLoginResult({ ok: false, error: error instanceof Error ? error.message : String(error) })
    } finally {
      setLoginStarting(false)
    }
  }

  const openCodexAuthInAgentBrowser = async (url: string) => {
    setLoginResult((current: any) => ({ ...(current ?? {}), browserOpenPending: true, browserOpenError: undefined }))
    try {
      const response = await fetch("/experimental/browser/live/input", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "goto", url }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body?.ok === false)
        throw new Error(body?.error ?? "Could not open auth link in Agent Browser")
      window.dispatchEvent(
        new CustomEvent("opencode:workspace-tab-action", {
          detail: {
            type: "workspace_tab",
            action: "open",
            tab: PANEL_BROWSER_TAB,
            source: "codex-accounts-auth",
            actionID: `codex-auth-browser-${Date.now()}`,
          },
        }),
      )
      setLoginResult((current: any) => ({
        ...(current ?? {}),
        browserOpenPending: false,
        browserOpenedAt: new Date().toISOString(),
      }))
    } catch (error) {
      setLoginResult((current: any) => ({
        ...(current ?? {}),
        browserOpenPending: false,
        browserOpenError: error instanceof Error ? error.message : String(error),
      }))
    }
  }

  const copyText = async (value: string | undefined | null) => {
    if (!value || typeof navigator === "undefined" || !navigator.clipboard) return
    await navigator.clipboard.writeText(value)
  }

  const runCodexAccountAction = async (payload: Record<string, unknown>, pendingLabel: string, successLabel: string) => {
    setLoginResult((current: any) => ({ ...(current ?? {}), accountActionPending: pendingLabel, accountActionError: undefined }))
    try {
      const response = await fetch("/experimental/codex-multi-auth/account", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body?.ok === false) throw new Error(body?.error ?? "Could not update Codex account state")
      setLoginResult((current: any) => ({
        ...(current ?? {}),
        accountActionPending: undefined,
        accountActionNote: successLabel,
      }))
      void codexStatus.refresh()
      void status.refresh()
    } catch (error) {
      setLoginResult((current: any) => ({
        ...(current ?? {}),
        accountActionPending: undefined,
        accountActionError: error instanceof Error ? error.message : String(error),
      }))
    }
  }

  const setCodexActiveAccount = async (alias: string) =>
    runCodexAccountAction({ action: "set-active", alias }, `set-active:${alias}`, `Active Codex account set to ${alias}`)

  const forceCodexAccount = async (alias: string) =>
    runCodexAccountAction(
      { action: "force-account", alias, durationMinutes: 120 },
      `force-account:${alias}`,
      `Codex account forced to ${alias} for 2 hours`,
    )

  const clearCodexForce = async () =>
    runCodexAccountAction({ action: "clear-force" }, "clear-force", "Codex forced account override cleared")

  const setCodexAccountEnabled = async (alias: string, enabled: boolean) =>
    runCodexAccountAction(
      { action: "set-enabled", alias, enabled },
      `set-enabled:${alias}`,
      `Codex account ${alias} ${enabled ? "enabled" : "disabled"}`,
    )

  const removeCodexAccount = async (alias: string) => {
    if (typeof window !== "undefined" && !window.confirm(`Remove Codex account "${alias}" from the multi-auth store?`))
      return
    await runCodexAccountAction({ action: "remove-account", alias }, `remove-account:${alias}`, `Codex account ${alias} removed`)
  }

  const reauthCodexAccount = async (alias: string) => {
    setLoginResult((current: any) => ({ ...(current ?? {}), reauthTarget: alias }))
    await startCodexLogin()
  }

  const setCodexRotation = async (strategy: string) =>
    runCodexAccountAction({ action: "set-rotation", strategy }, `set-rotation:${strategy}`, `Codex rotation set to ${strategy}`)

  const runCodexRuntimeProof = async () => {
    setProofStarting(true)
    setProofResult(undefined)
    try {
      const response = await fetch("/experimental/codex-multi-auth/run-proof", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "Reply with exactly: MULTI_AUTH_RUNTIME_OK" }),
      })
      const body = await response.json().catch(() => ({}))
      const proofRunning = body?.state === "running"
      if (!response.ok || (body?.ok === false && !proofRunning))
        throw new Error(body?.error ?? body?.sendBlockReason ?? "Codex runtime proof failed")
      setProofResult(body)
      void codexStatus.refresh()
      void status.refresh()
      if (proofRunning) {
        window.setTimeout(() => {
          void codexStatus.refresh()
          void status.refresh()
        }, 12_000)
      }
    } catch (error) {
      setProofResult({ ok: false, error: error instanceof Error ? error.message : String(error) })
    } finally {
      setProofStarting(false)
    }
  }

  return (
    <TabChrome
      title="Accounts"
      iconTab={PANEL_ACCOUNTS_TAB}
      onRefresh={() => {
        void status.refresh()
        void codexStatus.refresh()
        void workspace.refresh()
      }}
    >
      <div class="flex flex-col gap-3">
        <StatusRow label="Hostname" value={status.data()?.hostname} />
        <StatusRow
          label="Open Design token"
          value={status.data()?.openDesign?.configured ? "configured" : "not configured"}
        />
        <StatusRow label="Mac View" value={status.data()?.macView?.configured ? "configured" : "not configured"} />
        <StatusRow label="Workspace projects" value={workspace.data()?.projects?.length} />
        <StatusRow label="Recent sessions" value={workspace.data()?.sessions?.length} />
        <div class="rounded-md border border-border-weaker-base bg-background-stronger p-3">
          <div class="mb-2 flex items-center justify-between gap-3">
            <div>
              <div class="text-12-regular text-text-weak">Codex accounts</div>
              <div class="mt-0.5 text-11-regular text-text-weak">
                Authorize each Codex account into the isolated multi-auth profile.
              </div>
            </div>
            <span
              class="rounded bg-background-base px-2 py-1 text-11-regular"
              classList={{ "text-text-strong": codexStatusStrong(), "text-text-weak": !codexStatusStrong() }}
            >
              {codexStatusLabel()}
            </span>
          </div>
          <Show when={codexAccounts()?.warning}>
            {(warning) => (
              <div class="mb-3 rounded-md border border-orange-500/20 bg-orange-500/10 px-3 py-2 text-12-regular text-orange-100">
                {warning()}
              </div>
            )}
          </Show>
          <div class="mb-3 grid gap-2 md:grid-cols-3">
            <StatusRow label="Provider owner" value={codexAccounts()?.providerID ?? "codex-multi-auth"} />
            <StatusRow label="Base OpenAI" value={codexBaseProviderLabel()} />
            <StatusRow label="Account count" value={codexAccountCount()} />
            <StatusRow label="Active account" value={codexAccounts()?.activeAccount ?? "none"} />
            <StatusRow
              label="Forced account"
              value={
                codexForcedAccount()
                  ? `${codexForcedAccount()}${codexForcedUntilLabel() ? ` until ${codexForcedUntilLabel()}` : ""}`
                  : "none"
              }
            />
            <StatusRow label="Rotation" value={codexAccounts()?.rotationStrategy ?? "not set"} />
            <StatusRow label="Runtime proof" value={codexRuntimeReady() ? "ready" : "not verified"} />
            <StatusRow label="Send routing" value={codexRouting()} />
            <StatusRow
              label="Usage / limits"
              value={
                codexAccounts()?.usageSummary ??
                "Weekly and 5-hour usage are not reported by the multi-auth wrapper yet. Per-account send counts below are local rotation counters, not OpenAI quota."
              }
            />
          </div>
          <details class="mb-3 rounded-md border border-border-weaker-base bg-background-base px-3 py-2 text-12-regular text-text-weak">
            <summary class="cursor-pointer text-12-medium text-text-strong">How Codex Multi-Auth works</summary>
            <ul class="mt-2 list-disc space-y-1 pl-4 text-11-regular">
              <li>
                All accounts live in one isolated multi-auth profile store (path shown below) - aliases share a single
                store, they are not separate .codex folders.
              </li>
              <li>Prompts route through the sidecar prompt adapter; each send picks an account via the rotation strategy.</li>
              <li>Force mode pins one account for 2 hours (or until cleared); rotation resumes afterwards.</li>
              <li>Enable/disable controls whether rotation may pick an account. Active marks the account used for the next send.</li>
              <li>
                The base OpenAI provider is hidden from the model picker while multi-auth is ready, so sends cannot
                silently bypass the account store. Set OPENCODE_SHOW_BASE_OPENAI_WITH_MULTI_AUTH=1 to restore it.
              </li>
            </ul>
          </details>
          <Show when={codexAccountCount() > 0}>
            <div class="mb-3 rounded-md border border-border-weaker-base bg-background-base p-3">
              <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div class="text-12-medium text-text-strong">Rotation strategy</div>
                  <div class="text-11-regular text-text-weak">
                    Rotation is used when no account is forced. Force mode also sets the active account for the current sidecar runner.
                  </div>
                </div>
                <Show when={codexForcedAccount()}>
                  <button
                    type="button"
                    class="rounded border border-border-weaker-base bg-background-stronger px-2 py-1 text-11-regular text-text-strong hover:bg-surface-raised-base-hover disabled:opacity-60"
                    disabled={loginResult()?.accountActionPending === "clear-force"}
                    onClick={() => void clearCodexForce()}
                  >
                    {loginResult()?.accountActionPending === "clear-force" ? "Clearing..." : "Clear force"}
                  </button>
                </Show>
              </div>
              <div class="flex flex-wrap gap-2">
                <For each={["round-robin", "least-used", "random", "weighted-round-robin"]}>
                  {(strategy) => (
                    <button
                      type="button"
                      class="rounded border px-2 py-1 text-11-regular hover:bg-surface-raised-base-hover disabled:opacity-60"
                      classList={{
                        "border-green-500/30 bg-green-500/10 text-green-100": codexAccounts()?.rotationStrategy === strategy,
                        "border-border-weaker-base bg-background-stronger text-text-strong": codexAccounts()?.rotationStrategy !== strategy,
                      }}
                      disabled={loginResult()?.accountActionPending === `set-rotation:${strategy}`}
                      onClick={() => void setCodexRotation(strategy)}
                    >
                      {loginResult()?.accountActionPending === `set-rotation:${strategy}` ? "Setting..." : strategy}
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>
          <Show when={codexBaseProviderVisibility()?.hidden}>
            <div class="mb-3 rounded-md border border-green-500/20 bg-green-500/10 px-3 py-2 text-12-regular text-green-100">
              Original OpenAI is hidden from the model picker while Codex Multi-Auth is ready. To temporarily restore it, set <span class="font-mono">OPENCODE_SHOW_BASE_OPENAI_WITH_MULTI_AUTH=1</span>.
            </div>
          </Show>
          <Show when={codexStorePath()}>
            {(storePath) => (
              <div class="mb-3 rounded bg-background-base px-3 py-2 text-11-regular text-text-weak">
                Isolated account store: <span class="font-mono text-text-strong">{storePath()}</span>
              </div>
            )}
          </Show>
          <Show when={codexAccountList().length > 0}>
            <div class="mb-3 flex flex-col gap-2" data-testid="codex-account-cards">
              <For each={codexAccountList()}>
                {(account: any) => {
                  const pending = (op: string) => loginResult()?.accountActionPending === `${op}:${account.alias}`
                  const isForced = () => codexForcedAccount() === account.alias
                  const reauth = () => account.reauthNeeded === true
                  return (
                    <div
                      class="rounded-lg border bg-background-base p-3"
                      classList={{
                        "border-green-500/40": account.active,
                        "border-orange-500/30": !account.active && reauth(),
                        "border-border-weaker-base": !account.active && !reauth(),
                      }}
                      data-testid="codex-account-card"
                      data-alias={account.alias}
                    >
                      <div class="flex items-start justify-between gap-3">
                        <div class="min-w-0">
                          <div class="flex items-center gap-2">
                            <span class="truncate text-13-medium text-text-strong">{account.alias ?? "account"}</span>
                            <Show when={account.active}>
                              <span class="rounded bg-green-500/15 px-1.5 py-0.5 text-10-medium uppercase tracking-wide text-green-200">active</span>
                            </Show>
                            <Show when={isForced()}>
                              <span class="rounded bg-orange-500/15 px-1.5 py-0.5 text-10-medium uppercase tracking-wide text-orange-100">forced</span>
                            </Show>
                            <Show when={reauth()}>
                              <span class="rounded bg-red-500/15 px-1.5 py-0.5 text-10-medium uppercase tracking-wide text-red-200">re-auth needed</span>
                            </Show>
                            <Show when={!reauth() && account.enabled === false}>
                              <span class="rounded bg-background-stronger px-1.5 py-0.5 text-10-medium uppercase tracking-wide text-text-weak">disabled</span>
                            </Show>
                          </div>
                          <div class="mt-0.5 truncate text-11-regular text-text-weak">{account.email ?? account.label ?? "email not reported"}</div>
                        </div>
                        <span class="shrink-0 rounded bg-background-stronger px-2 py-1 text-10-medium text-text-weak">
                          {account.planType ? `ChatGPT ${account.planType}` : "plan unknown"}
                        </span>
                      </div>
                      <div class="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-10-regular text-text-weak">
                        <span>{typeof account.usageCount === "number" ? `${account.usageCount} local rotation sends` : "no local send count"}</span>
                        <span>{account.lastUsed ? `last used ${new Date(account.lastUsed).toLocaleString()}` : "not used yet"}</span>
                      </div>
                      <Show when={reauth()}>
                        <div class="mt-2 rounded border border-red-500/20 bg-red-500/10 px-2 py-1.5 text-10-regular text-red-200">
                          This account's refresh token was invalidated ({account.disabledReason ?? "reauth_needed"}). It is disabled and cannot send until you re-authenticate it below. Re-enabling without re-auth will not work.
                        </div>
                      </Show>
                      <div class="mt-2.5 flex flex-wrap items-center gap-2">
                        <Show when={!account.active && account.enabled !== false && !reauth()}>
                          <button type="button" class="rounded border border-border-weaker-base bg-background-stronger px-2 py-1 text-11-regular text-text-strong hover:bg-surface-raised-base-hover disabled:opacity-60" disabled={pending("set-active")} onClick={() => void setCodexActiveAccount(account.alias)}>
                            {pending("set-active") ? "Setting..." : "Set active"}
                          </button>
                        </Show>
                        <Show when={reauth()}>
                          <button type="button" class="rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-11-regular text-red-100 hover:bg-red-500/20 disabled:opacity-60" disabled={loginStarting()} onClick={() => void reauthCodexAccount(account.alias)}>
                            {loginStarting() && loginResult()?.reauthTarget === account.alias ? "Starting re-auth..." : "Re-authenticate"}
                          </button>
                        </Show>
                        <button type="button" class="rounded border border-border-weaker-base bg-background-stronger px-2 py-1 text-11-regular text-text-strong hover:bg-surface-raised-base-hover disabled:opacity-60" disabled={pending("set-enabled") || (reauth() && account.enabled === false)} title={reauth() && account.enabled === false ? "Re-authenticate before enabling" : undefined} onClick={() => void setCodexAccountEnabled(account.alias, account.enabled === false)}>
                          {pending("set-enabled") ? "Updating..." : account.enabled === false ? "Enable" : "Disable"}
                        </button>
                        <Show when={!isForced() && account.enabled !== false && !reauth()}>
                          <button type="button" class="rounded border border-border-weaker-base bg-background-stronger px-2 py-1 text-11-regular text-text-strong hover:bg-surface-raised-base-hover disabled:opacity-60" disabled={pending("force-account")} onClick={() => void forceCodexAccount(account.alias)}>
                            {pending("force-account") ? "Forcing..." : "Force 2h"}
                          </button>
                        </Show>
                        <Show when={isForced()}>
                          <button type="button" class="rounded border border-orange-500/30 bg-background-stronger px-2 py-1 text-11-regular text-orange-100 hover:bg-surface-raised-base-hover disabled:opacity-60" disabled={loginResult()?.accountActionPending === "clear-force"} onClick={() => void clearCodexForce()}>
                            {loginResult()?.accountActionPending === "clear-force" ? "Clearing..." : "Unforce"}
                          </button>
                        </Show>
                        <button type="button" class="ml-auto rounded border border-red-500/30 bg-background-stronger px-2 py-1 text-11-regular text-red-200 hover:bg-red-500/10 disabled:opacity-60" disabled={pending("remove-account")} onClick={() => void removeCodexAccount(account.alias)}>
                          {pending("remove-account") ? "Removing..." : "Remove"}
                        </button>
                      </div>
                    </div>
                  )
                }}
              </For>
            </div>
            <Show when={codexAccountList().filter((a: any) => a.enabled !== false).length <= 1}>
              <div class="mb-3 rounded border border-border-weaker-base bg-background-base px-3 py-2 text-10-regular text-text-weak">
                Only one account is enabled, so rotation is effectively single-account. The model picker's Codex Multi-Auth lane always routes through the active account; base OpenAI stays hidden. OpenDesign design prompts use this same active lane.
              </div>
            </Show>
          </Show>
          <Show when={codexAccountList().length === 0}>
            <div class="mb-3 rounded-md border border-border-weaker-base bg-background-base px-3 py-2 text-12-regular text-text-weak">
              No isolated Codex multi-auth accounts are visible yet. Normal OpenAI sign-in is separate from this store.
            </div>
          </Show>
          <div class="mb-3 flex flex-wrap gap-2">
            <button
              type="button"
              class="rounded-md border border-border-weaker-base bg-background-base px-3 py-1.5 text-12-regular text-text-strong hover:bg-surface-raised-base-hover disabled:opacity-60"
              disabled={loginStarting()}
              onClick={startCodexLogin}
            >
              {loginStarting() ? "Starting auth..." : "Authenticate Codex account"}
            </button>
            <button
              type="button"
              class="rounded-md border border-border-weaker-base bg-background-base px-3 py-1.5 text-12-regular text-text-strong hover:bg-surface-raised-base-hover"
              onClick={() => {
                void codexStatus.refresh()
                void status.refresh()
              }}
            >
              Refresh status
            </button>
            <button
              type="button"
              class="rounded-md border border-border-weaker-base bg-background-base px-3 py-1.5 text-12-regular text-text-strong hover:bg-surface-raised-base-hover disabled:opacity-60"
              disabled={proofStarting() || codexAccountCount() === 0}
              onClick={() => void runCodexRuntimeProof()}
            >
              {proofStarting() ? "Running proof..." : "Run runtime proof"}
            </button>
          </div>
          <Show when={proofResult()}>
            {(result) => (
              <div
                class="mb-3 rounded-md border px-3 py-2 text-12-regular"
                classList={{
                  "border-green-500/20 bg-green-500/10 text-green-100": result().ok === true,
                  "border-orange-500/20 bg-orange-500/10 text-orange-100": result().ok !== true,
                }}
              >
                <div class="mb-1 text-12-medium">Runtime proof {result().ok === true ? "passed" : "failed"}</div>
                <div class="whitespace-pre-wrap break-words text-11-regular">
                  {result().text ?? result().error ?? result().sendBlockReason ?? result().outputPreview ?? "No proof output reported."}
                </div>
                <Show when={result().sessionID ?? result().durationMs}>
                  <div class="mt-1 text-11-regular opacity-80">
                    <Show when={result().sessionID}>{(sessionID) => <span>Session {sessionID()} </span>}</Show>
                    <Show when={result().durationMs}>{(durationMs) => <span>{durationMs()}ms</span>}</Show>
                  </div>
                </Show>
              </div>
            )}
          </Show>
          <Show when={codexStatus.error()}>
            {(error) => (
              <div class="mb-3 rounded-md border border-orange-500/20 bg-orange-500/10 px-3 py-2 text-12-regular text-orange-100">
                Codex status refresh failed: {error()}
              </div>
            )}
          </Show>
          <Show when={loginResult()?.accountActionNote}>
            {(note) => <div class="mb-3 rounded-md border border-green-500/20 bg-green-500/10 px-3 py-2 text-12-regular text-green-100">{note()}</div>}
          </Show>
          <Show when={loginResult()?.accountActionError}>
            {(error) => <div class="mb-3 rounded-md border border-orange-500/20 bg-orange-500/10 px-3 py-2 text-12-regular text-orange-100">{error()}</div>}
          </Show>
          <Show when={authPanel()}>
            {(result) => (
              <div class="mb-3 rounded-md border border-border-weaker-base bg-background-base p-3 text-12-regular" data-testid="codex-auth-panel">
                <div class="mb-2 flex items-center justify-between gap-2">
                  <div class="text-12-medium text-text-strong">
                    {loginResult()?.reauthTarget ? `Re-authenticate "${loginResult()?.reauthTarget}"` : "Add Codex account"}
                  </div>
                  <Show when={!/authorized|complete|written|success/i.test(String(result().phase ?? ""))}>
                    <span class="rounded-full bg-orange-500/15 px-2 py-0.5 text-10-medium text-orange-100">waiting for approval</span>
                  </Show>
                </div>
                <div class="mb-2 text-10-regular text-text-weak">
                  Open the link (or copy the code), approve in ChatGPT, then this panel refreshes automatically. The device-code flow needs no localhost callback.
                </div>
                <div class="mb-2 flex items-center justify-between gap-2">
                  <div class="text-12-medium text-text-strong">Auth command</div>
                  <button
                    type="button"
                    class="rounded px-2 py-1 text-11-regular text-text-weak hover:bg-surface-raised-base-hover hover:text-text-strong"
                    onClick={() => void copyText(result().terminalCommand)}
                  >
                    Copy command
                  </button>
                </div>
                <div class="break-all rounded bg-background-stronger px-2 py-1.5 font-mono text-11-regular text-text-strong">
                  {result().terminalCommand ?? result().command ?? "Command not reported"}
                </div>
                <Show when={result().phase}>
                  {(phase) => (
                    <div class="mt-3 rounded bg-background-stronger px-2 py-1.5 text-11-regular text-text-weak">
                      Auth state: <span class="text-text-strong">{phase()}</span>
                    </div>
                  )}
                </Show>
                <Show when={result().authorizationURL ?? result().authURL}>
                  {(url) => (
                    <div class="mt-3">
                      <div class="mb-1 text-11-medium text-text-weak">Auth link</div>
                      <div class="flex flex-wrap items-center gap-2">
                        <a
                          href={url()}
                          target="_blank"
                          rel="noreferrer"
                          class="break-all text-12-regular text-[#f97316] hover:underline"
                        >
                          {url()}
                        </a>
                        <button
                          type="button"
                          class="rounded px-2 py-1 text-11-regular text-text-weak hover:bg-surface-raised-base-hover hover:text-text-strong"
                          onClick={() => void copyText(url())}
                        >
                          Copy link
                        </button>
                        <button
                          type="button"
                          class="rounded border border-border-weaker-base bg-background-stronger px-2 py-1 text-11-regular text-text-strong hover:bg-surface-raised-base-hover disabled:opacity-60"
                          disabled={!!result().browserOpenPending}
                          onClick={() => void openCodexAuthInAgentBrowser(url())}
                        >
                          {result().browserOpenPending ? "Opening..." : "Open in Agent Browser"}
                        </button>
                      </div>
                    </div>
                  )}
                </Show>
                <Show when={result().browserOpenedAt}>
                  <div class="mt-2 rounded bg-background-stronger px-2 py-1.5 text-11-regular text-text-weak">
                    Opened in the server Agent Browser. Complete the approval there, then press Refresh status.
                  </div>
                </Show>
                <Show when={result().browserOpenError}>
                  {(error) => (
                    <div class="mt-2 rounded border border-orange-500/20 bg-orange-500/10 px-2 py-1.5 text-11-regular text-orange-100">
                      {error()}
                    </div>
                  )}
                </Show>
                <Show when={result().userCode}>
                  {(code) => (
                    <div class="mt-3">
                      <div class="mb-1 text-11-medium text-text-weak">Code</div>
                      <div class="flex flex-wrap items-center gap-2">
                        <span class="rounded bg-background-stronger px-2 py-1.5 font-mono text-14-medium text-text-strong">
                          {code()}
                        </span>
                        <button
                          type="button"
                          class="rounded px-2 py-1 text-11-regular text-text-weak hover:bg-surface-raised-base-hover hover:text-text-strong"
                          onClick={() => void copyText(code())}
                        >
                          Copy code
                        </button>
                      </div>
                    </div>
                  )}
                </Show>
                <div class="mt-3 text-12-regular text-text-weak">
                  {result().note ?? "Run this once per Codex account."}
                </div>
                <Show when={result().ok && result().phase === "waiting_for_device_approval"}>
                  <div class="mt-2 text-12-regular text-text-weak">
                    After the browser says the account is approved, press Refresh status. The count below should
                    increase from {codexAccountCount()}.
                  </div>
                </Show>
                <Show when={result().ok && result().phase === "waiting_for_browser_approval"}>
                  <div class="mt-2 text-12-regular text-text-weak">
                    Open this link in the server Agent Browser, not your Mac browser, so the localhost callback returns
                    to CT100. After approval, press Refresh status.
                  </div>
                </Show>
                <Show when={result().output ?? result().error}>
                  {(output) => (
                    <pre class="mt-3 max-h-52 overflow-auto whitespace-pre-wrap break-words rounded bg-background-stronger p-2 text-11-regular text-text-weak">
                      {output()}
                    </pre>
                  )}
                </Show>
              </div>
            )}
          </Show>
          <div class="whitespace-pre-wrap break-words rounded bg-background-base px-3 py-2 text-12-regular text-text-weak">
            {codexAccounts()?.healthOutput ??
              codexAccounts()?.listOutput ??
              codexAccounts()?.output ??
              codexAccounts()?.error ??
              codexAccounts()?.warning ??
              "No Codex account status reported yet."}
          </div>
        </div>
        <div class="rounded-md border border-border-weaker-base bg-background-stronger p-3">
          <div class="text-12-regular text-text-weak mb-2">Native tools</div>
          <div class="flex flex-wrap gap-2">
            <For each={status.data()?.tools ?? []}>
              {(tool: string) => (
                <span class="rounded bg-background-base px-2 py-1 text-12-regular text-text-strong">@{tool}</span>
              )}
            </For>
          </div>
        </div>
        <div class="rounded-md border border-border-weaker-base bg-background-stronger p-3">
          <div class="text-12-regular text-text-weak mb-2">Projects</div>
          <div class="flex flex-col gap-2">
            <For each={(workspace.data()?.projects ?? []).slice(0, 8)}>
              {(project: any) => (
                <div class="flex items-center justify-between gap-3 text-13-regular">
                  <span class="text-text-strong truncate">{project.name ?? project.worktree}</span>
                  <span class="text-text-weak shrink-0">{project.activeSessions ?? 0} sessions</span>
                </div>
              )}
            </For>
            <Show when={(workspace.data()?.projects ?? []).length === 0}>
              <div class="text-13-regular text-text-weak">No projects indexed yet.</div>
            </Show>
          </div>
        </div>
      </div>
    </TabChrome>
  )
}

function RoutinesTabContent() {
  const jobs = createPolledJson<any>(() => "/experimental/routines/jobs", 10000)
  const [selectedID, setSelectedID] = createSignal<string | undefined>()
  const routines = () => jobs.data()?.routines ?? []
  const selected = createMemo(() => routines().find((routine: any) => routine.id === selectedID()) ?? routines()[0])
  const logs = createPolledJson<any>(
    () => (selected()?.id ? `/experimental/routines/jobs/${encodeURIComponent(selected().id)}/logs` : undefined),
    10000,
  )

  createEffect(() => {
    const first = routines()[0]?.id
    if (!selectedID() && first) setSelectedID(first)
  })

  return (
    <TabChrome
      title="Routines"
      iconTab={PANEL_ROUTINES_TAB}
      onRefresh={() => {
        void jobs.refresh()
        void logs.refresh()
      }}
    >
      <div class="flex min-h-0 flex-1 flex-col gap-3">
        <Show when={jobs.error()}>
          {(error) => (
            <div class="rounded-md border border-border-weaker-base bg-background-stronger p-3 text-12-regular text-text-weak">
              {error()}
            </div>
          )}
        </Show>

        <div class="grid gap-3 xl:grid-cols-3">
          <EnvironmentSummaryCard
            label="Routines"
            value={String(jobs.data()?.status?.counts?.total ?? routines().length ?? 0)}
            detail="Configured recurring jobs"
            tone="ready"
          />
          <EnvironmentSummaryCard
            label="Enabled"
            value={String(jobs.data()?.status?.counts?.enabled ?? 0)}
            detail="Active schedules"
            tone={(jobs.data()?.status?.counts?.enabled ?? 0) > 0 ? "ready" : "warn"}
          />
          <EnvironmentSummaryCard
            label="Editing"
            value={jobs.data()?.status?.mutationsEnabled ? "enabled" : "held"}
            detail={
              jobs.data()?.status?.mutationsEnabled
                ? "Disabled draft writes are enabled. Manual runs stay separate."
                : "Disabled draft writes are off on this server."
            }
            tone={jobs.data()?.status?.mutationsEnabled ? "ready" : "warn"}
          />
        </div>

        <div class="grid min-h-0 flex-1 gap-3 xl:grid-cols-[minmax(220px,0.8fr)_minmax(0,1.2fr)]">
          <div class="min-h-0 overflow-auto rounded-md border border-border-weaker-base bg-background-stronger">
            <For each={routines()}>
              {(routine: any) => (
                <button
                  type="button"
                  class="flex w-full flex-col gap-1 border-b border-border-weaker-base px-3 py-3 text-left last:border-b-0 hover:bg-surface-base-hover"
                  classList={{ "bg-background-base": selected()?.id === routine.id }}
                  onClick={() => setSelectedID(routine.id)}
                >
                  <div class="flex items-center justify-between gap-3">
                    <span class="min-w-0 truncate text-13-regular text-text-strong">{routine.name}</span>
                    <span class="shrink-0 rounded bg-background-base px-2 py-1 text-11-regular text-text-weak">
                      {routine.enabled ? "enabled" : "off"}
                    </span>
                  </div>
                  <div class="truncate text-12-regular text-text-weak">{routine.schedule ?? "No schedule"}</div>
                </button>
              )}
            </For>
            <Show when={routines().length === 0}>
              <div class="p-4 text-13-regular text-text-weak">No routines configured yet.</div>
            </Show>
          </div>

          <div class="min-h-0 overflow-auto rounded-md border border-border-weaker-base bg-background-stronger p-3">
            <Show
              when={selected()}
              fallback={<div class="text-13-regular text-text-weak">Select a routine to view details.</div>}
            >
              {(routine) => (
                <div class="flex flex-col gap-3">
                  <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0">
                      <div class="truncate text-14-medium text-text-strong">{routine().name}</div>
                      <div class="mt-1 text-12-regular text-text-weak">{routine().description ?? "No description"}</div>
                    </div>
                    <EnvironmentPill
                      tone={routine().enabled ? "ready" : "warn"}
                      label={routine().enabled ? "enabled" : "off"}
                    />
                  </div>

                  <div class="grid gap-2 sm:grid-cols-2">
                    <EnvironmentInfoRow label="Schedule" value={routine().schedule} />
                    <EnvironmentInfoRow label="Last status" value={routine().lastStatus ?? "never"} />
                    <EnvironmentInfoRow label="Last run" value={routine().lastRunAt} />
                    <EnvironmentInfoRow label="Next run" value={routine().nextRunAt} />
                    <EnvironmentInfoRow label="Notify" value={(routine().notify ?? []).join(", ") || "in-app"} />
                    <EnvironmentInfoRow label="Tags" value={(routine().tags ?? []).join(", ") || "none"} />
                  </div>

                  <Show when={routine().command}>
                    <div class="rounded bg-background-base p-2">
                      <div class="mb-1 text-11-regular text-text-weak">Command</div>
                      <code class="whitespace-pre-wrap break-words text-12-regular text-text-strong">
                        {routine().command}
                      </code>
                    </div>
                  </Show>

                  <div class="rounded border border-border-weaker-base bg-background-base p-2 text-12-regular text-text-weak">
                    Disabled routine drafts can be created from the home Routines page. Enabling schedules and manual
                    runs remain separate server-side controls.
                  </div>

                  <div>
                    <div class="mb-2 text-13-medium text-text-strong">Logs</div>
                    <div class="flex max-h-72 flex-col gap-1 overflow-auto rounded bg-background-base p-2">
                      <For each={logs.data()?.logs ?? []}>
                        {(log: any) => (
                          <div class="grid gap-1 border-b border-border-weaker-base pb-2 last:border-b-0 text-12-regular">
                            <div class="flex items-center justify-between gap-2">
                              <span class="text-text-weak">{formatShortDate(log.time)}</span>
                              <EnvironmentPill
                                tone={log.level === "error" ? "blocked" : log.level === "warn" ? "warn" : "ready"}
                                label={log.level}
                              />
                            </div>
                            <div class="text-text-strong">{log.message}</div>
                          </div>
                        )}
                      </For>
                      <Show when={(logs.data()?.logs ?? []).length === 0}>
                        <div class="text-12-regular text-text-weak">No logs for this routine yet.</div>
                      </Show>
                    </div>
                  </div>
                </div>
              )}
            </Show>
          </div>
        </div>

        <StatusRow label="Store" value={jobs.data()?.status?.jobsFile} />
        <StatusRow label="Last checked" value={jobs.data()?.generatedAt} />
      </div>
    </TabChrome>
  )
}

function EnvironmentTabContent() {
  const environment = createPolledJson<any>(() => "/experimental/workspace-suite/environments", 15000)
  const workspaceEnv = createPolledJson<any>(() => "/experimental/workspace-env", 15000)
  const data = () => environment.data()
  const refreshAll = () => {
    void environment.refresh()
    void workspaceEnv.refresh()
  }

  return (
    <TabChrome title="Environment" iconTab={PANEL_ENVIRONMENT_TAB} onRefresh={refreshAll}>
      <div class="flex flex-col gap-3">
        <Show when={environment.error()}>
          {(error) => (
            <div class="rounded-md border border-border-weaker-base bg-background-stronger p-3 text-12-regular text-text-weak">
              {error()}
            </div>
          )}
        </Show>

        <div class="grid gap-3 xl:grid-cols-3">
          <EnvironmentSummaryCard
            label="Mode"
            value={data()?.mode ?? "checking"}
            detail={data()?.desiredInvariant}
            tone={data()?.mode === "live-only" ? "ready" : "warn"}
          />
          <EnvironmentSummaryCard
            label="Access"
            value={data()?.access?.status ?? "checking"}
            detail={data()?.access?.warning ?? "App password is configured."}
            tone={data()?.access?.appPasswordConfigured ? "ready" : "warn"}
          />
          <EnvironmentSummaryCard
            label="GitHub"
            value={data()?.gates?.find((gate: any) => gate.label === "GitHub push")?.status ?? "checking"}
            detail={data()?.gates?.find((gate: any) => gate.label === "GitHub push")?.detail}
            tone={
              data()?.gates?.find((gate: any) => gate.label === "GitHub push")?.status === "ready" ? "ready" : "blocked"
            }
          />
        </div>

        <div class="grid gap-3 xl:grid-cols-2">
          <div class="rounded-md border border-border-weaker-base bg-background-stronger p-3">
            <div class="mb-2 flex items-center justify-between gap-3">
              <div class="text-13-medium text-text-strong">Live Route</div>
              <EnvironmentPill tone="ready" label="single live" />
            </div>
            <div class="grid gap-2 sm:grid-cols-2">
              <EnvironmentInfoRow label="Public URL" value={data()?.routes?.liveURL} />
              <EnvironmentInfoRow label="Health" value={data()?.routes?.healthURL} />
              <EnvironmentInfoRow label="Proxy" value={data()?.routes?.publicProxy} />
              <EnvironmentInfoRow label="Internal" value={data()?.routes?.internalOpenCode} />
              <EnvironmentInfoRow label="Direct 8310" value={data()?.routes?.disabledDirectRuntime} />
              <EnvironmentInfoRow label="Legacy host" value={data()?.routes?.legacyHostnameState} />
            </div>
          </div>

          <div class="rounded-md border border-border-weaker-base bg-background-stronger p-3">
            <div class="mb-2 flex items-center justify-between gap-3">
              <div class="text-13-medium text-text-strong">Release</div>
              <EnvironmentPill tone="ready" label="current" />
            </div>
            <div class="grid gap-2">
              <EnvironmentInfoRow label="Current symlink" value={data()?.release?.currentSymlink} />
              <EnvironmentInfoRow label="Current release" value={data()?.release?.currentRelease} />
            </div>
            <div class="mt-3 flex flex-col gap-2">
              <div class="text-12-regular text-text-weak">Rollback candidates</div>
              <For each={data()?.release?.rollbackCandidates ?? []}>
                {(release: any) => (
                  <div class="flex items-center justify-between gap-3 rounded bg-background-base px-2 py-1.5 text-12-regular">
                    <span class="min-w-0 truncate text-text-strong">{release.name}</span>
                    <span class="shrink-0 text-text-weak">{formatShortDate(release.updatedAt)}</span>
                  </div>
                )}
              </For>
            </div>
          </div>
        </div>

        <div class="rounded-md border border-border-weaker-base bg-background-stronger p-3">
          <div class="mb-2 flex items-center justify-between gap-3">
            <div class="text-13-medium text-text-strong">Workspace Environment</div>
            <EnvironmentPill
              tone={(data()?.workspaceEnv?.enabledCount ?? 0) > 0 ? "ready" : "warn"}
              label={`${data()?.workspaceEnv?.enabledCount ?? 0} enabled`}
            />
          </div>
          <div class="grid gap-2 sm:grid-cols-2">
            <EnvironmentInfoRow label="Registry route" value={data()?.workspaceEnv?.route} />
            <EnvironmentInfoRow label="Registry path" value={data()?.workspaceEnv?.path} />
            <EnvironmentInfoRow label="Variables" value={data()?.workspaceEnv?.count} />
            <EnvironmentInfoRow label="Secrets" value={data()?.workspaceEnv?.secretCount} />
            <EnvironmentInfoRow
              label="Prompt summary"
              value={data()?.workspaceEnv?.promptSummaryConfigured ? "names/scopes only" : "not configured"}
            />
            <EnvironmentInfoRow
              label="Secret values exposed"
              value={data()?.workspaceEnv?.secretValuesExposed ? "yes" : "no"}
            />
          </div>
        </div>

        <div class="grid gap-3 xl:grid-cols-2">
          <GitEnvironmentCard title="OpenCode" repo={data()?.git?.opencode} />
          <GitEnvironmentCard title="LLM-Experiments" repo={data()?.git?.experiments} />
        </div>

        <div class="rounded-md border border-border-weaker-base bg-background-stronger p-3">
          <div class="mb-2 text-13-medium text-text-strong">Gates</div>
          <div class="grid gap-2 xl:grid-cols-3">
            <For each={data()?.gates ?? []}>
              {(gate: any) => (
                <div class="rounded bg-background-base p-2">
                  <div class="mb-1 flex items-center justify-between gap-2">
                    <span class="text-12-regular text-text-strong">{gate.label}</span>
                    <EnvironmentPill
                      tone={
                        gate.status === "ready" || gate.status === "available"
                          ? "ready"
                          : gate.status === "blocked"
                            ? "blocked"
                            : "warn"
                      }
                      label={gate.status}
                    />
                  </div>
                  <div class="text-12-regular text-text-weak">{gate.detail}</div>
                </div>
              )}
            </For>
          </div>
        </div>

        <EnvironmentVariableManager
          registry={workspaceEnv.data()?.registry}
          effective={workspaceEnv.data()?.effective}
          error={workspaceEnv.error()}
          onRefresh={refreshAll}
        />

        <StatusRow label="Last checked" value={data()?.generatedAt} />
      </div>
    </TabChrome>
  )
}

type EnvironmentDraft = {
  id?: string
  name: string
  value: string
  scope: string
  target: string
  enabled: boolean
  secret: boolean
  description: string
}

const emptyEnvironmentDraft = (): EnvironmentDraft => ({
  name: "",
  value: "",
  scope: "repos",
  target: "",
  enabled: true,
  secret: false,
  description: "",
})

function EnvironmentVariableManager(props: {
  registry?: any
  effective?: any
  error?: string
  onRefresh: () => void
}) {
  const [draft, setDraft] = createSignal<EnvironmentDraft>(emptyEnvironmentDraft())
  const [saving, setSaving] = createSignal(false)
  const [message, setMessage] = createSignal<string>()
  const entries = createMemo(() => props.registry?.entries ?? [])
  const editing = createMemo(() => !!draft().id)

  const updateDraft = (patch: Partial<EnvironmentDraft>) => setDraft((current) => ({ ...current, ...patch }))
  const loadEntry = (entry: any) => {
    setDraft({
      id: entry.id,
      name: entry.name ?? "",
      value: "",
      scope: entry.scope ?? "repos",
      target: entry.target ?? "",
      enabled: entry.enabled !== false,
      secret: !!entry.secret,
      description: entry.description ?? "",
    })
    setMessage("Loaded entry. Leave value blank to keep the current stored value.")
  }
  const resetDraft = () => {
    setDraft(emptyEnvironmentDraft())
    setMessage(undefined)
  }

  const saveDraft = async (event: SubmitEvent) => {
    event.preventDefault()
    const next = draft()
    setSaving(true)
    setMessage(undefined)
    try {
      const body: Record<string, unknown> = {
        action: "upsert",
        id: next.id,
        name: next.name,
        scope: next.scope,
        target: next.target || undefined,
        enabled: next.enabled,
        secret: next.secret,
        description: next.description || undefined,
      }
      if (!next.id || next.value !== "") body.value = next.value
      const response = await fetch("/experimental/workspace-env", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok || result?.ok === false) throw new Error(result?.error ?? "Could not save environment variable")
      setMessage(`Saved ${next.name}. New processes launched through OpenCode will inherit matching enabled variables.`)
      resetDraft()
      props.onRefresh()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const deleteEntry = async (entry: any) => {
    if (!entry?.id) return
    const confirmed = window.confirm(`Delete ${entry.name}? This removes it from future OpenCode-launched processes.`)
    if (!confirmed) return
    setSaving(true)
    setMessage(undefined)
    try {
      const response = await fetch("/experimental/workspace-env", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "delete", id: entry.id }),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok || result?.ok === false) throw new Error(result?.error ?? "Could not delete environment variable")
      setMessage(`Deleted ${entry.name}.`)
      if (draft().id === entry.id) resetDraft()
      props.onRefresh()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div class="rounded-md border border-border-weaker-base bg-background-stronger p-3">
      <div class="mb-3 flex items-center justify-between gap-3">
        <div>
          <div class="text-13-medium text-text-strong">Environment Variables</div>
          <div class="text-12-regular text-text-weak">
            Server-local registry for OpenCode-launched tools and terminals. Secret values stay redacted in the UI and prompt.
          </div>
        </div>
        <EnvironmentPill tone={(entries().length ?? 0) > 0 ? "ready" : "warn"} label={`${entries().length ?? 0} vars`} />
      </div>

      <Show when={props.error}>
        {(error) => <div class="mb-3 rounded bg-background-base p-2 text-12-regular text-text-weak">{error()}</div>}
      </Show>

      <div class="mb-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <EnvironmentInfoRow label="Registry path" value={props.registry?.path} />
        <EnvironmentInfoRow label="Repos root" value={props.effective?.reposRoot} />
        <EnvironmentInfoRow label="Inherited now" value={(props.effective?.inheritedBy ?? []).join(", ") || "terminal, bash"} />
        <EnvironmentInfoRow label="Planned next" value={(props.effective?.plannedScopes ?? []).join(", ") || "routines, browser, preview"} />
      </div>

      <form class="grid gap-2 xl:grid-cols-[1fr_1.2fr_0.8fr_1fr]" onSubmit={saveDraft}>
        <input
          value={draft().name}
          onInput={(event) => updateDraft({ name: event.currentTarget.value })}
          class="h-9 rounded border border-border-weaker-base bg-background-base px-2 text-13-regular text-text-strong outline-none"
          placeholder="VARIABLE_NAME"
          required
        />
        <input
          value={draft().value}
          onInput={(event) => updateDraft({ value: event.currentTarget.value })}
          class="h-9 rounded border border-border-weaker-base bg-background-base px-2 text-13-regular text-text-strong outline-none"
          placeholder={editing() ? "New value, or blank to keep current" : "Value"}
          type={draft().secret ? "password" : "text"}
        />
        <select
          value={draft().scope}
          onChange={(event) => updateDraft({ scope: event.currentTarget.value })}
          class="h-9 rounded border border-border-weaker-base bg-background-base px-2 text-13-regular text-text-strong outline-none"
        >
          <option value="repos">repos</option>
          <option value="global">global</option>
          <option value="project">project</option>
          <option value="terminal">terminal</option>
          <option value="bash">bash</option>
          <option value="routines">routines</option>
          <option value="browser">browser</option>
          <option value="preview">preview</option>
          <option value="open_design">open_design</option>
        </select>
        <input
          value={draft().target}
          onInput={(event) => updateDraft({ target: event.currentTarget.value })}
          class="h-9 rounded border border-border-weaker-base bg-background-base px-2 text-13-regular text-text-strong outline-none"
          placeholder="Optional project path"
        />
        <input
          value={draft().description}
          onInput={(event) => updateDraft({ description: event.currentTarget.value })}
          class="h-9 rounded border border-border-weaker-base bg-background-base px-2 text-13-regular text-text-strong outline-none xl:col-span-2"
          placeholder="Description shown to the LLM, no secrets"
        />
        <label class="flex h-9 items-center gap-2 rounded border border-border-weaker-base bg-background-base px-2 text-12-regular text-text-strong">
          <input
            type="checkbox"
            checked={draft().secret}
            onChange={(event) => updateDraft({ secret: event.currentTarget.checked })}
          />
          Secret
        </label>
        <label class="flex h-9 items-center gap-2 rounded border border-border-weaker-base bg-background-base px-2 text-12-regular text-text-strong">
          <input
            type="checkbox"
            checked={draft().enabled}
            onChange={(event) => updateDraft({ enabled: event.currentTarget.checked })}
          />
          Enabled
        </label>
        <div class="flex gap-2 xl:col-span-4">
          <button
            type="submit"
            class="rounded-md border border-border-weaker-base px-3 py-1.5 text-12-medium text-text-strong hover:bg-surface-raised-base-hover disabled:text-text-disabled"
            disabled={saving()}
          >
            {editing() ? "Update variable" : "Add variable"}
          </button>
          <button
            type="button"
            class="rounded-md border border-border-weaker-base px-3 py-1.5 text-12-medium text-text-weak hover:bg-surface-raised-base-hover"
            onClick={resetDraft}
          >
            Clear
          </button>
        </div>
      </form>

      <Show when={message()}>
        {(value) => <div class="mt-3 rounded bg-background-base p-2 text-12-regular text-text-weak">{value()}</div>}
      </Show>

      <div class="mt-3 flex flex-col gap-2">
        <For
          each={entries()}
          fallback={<div class="rounded bg-background-base p-3 text-12-regular text-text-weak">No variables yet.</div>}
        >
          {(entry: any) => (
            <div class="grid gap-2 rounded bg-background-base p-2 text-12-regular text-text-weak xl:grid-cols-[1fr_0.7fr_0.7fr_1fr_auto]">
              <div class="min-w-0">
                <div class="truncate text-text-strong">{entry.name}</div>
                <div class="truncate">{entry.description ?? "No description"}</div>
              </div>
              <div>{entry.scope}</div>
              <div>{entry.enabled ? "enabled" : "disabled"}</div>
              <div>{entry.secret ? "secret" : entry.valuePreview ?? (entry.hasValue ? "value set" : "empty")}</div>
              <div class="flex justify-end gap-2">
                <button class="rounded px-2 py-1 text-text-strong hover:bg-surface-raised-base-hover" type="button" onClick={() => loadEntry(entry)}>
                  Edit
                </button>
                <button class="rounded px-2 py-1 text-red-400 hover:bg-red-500/10" type="button" onClick={() => void deleteEntry(entry)}>
                  Delete
                </button>
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}

function EnvironmentSummaryCard(props: {
  label: string
  value?: string
  detail?: string
  tone: "ready" | "warn" | "blocked"
}) {
  return (
    <div class="rounded-md border border-border-weaker-base bg-background-stronger p-3">
      <div class="mb-2 flex items-center justify-between gap-2">
        <div class="text-12-regular text-text-weak">{props.label}</div>
        <EnvironmentPill tone={props.tone} label={props.value ?? "checking"} />
      </div>
      <div class="text-13-regular text-text-strong">{props.detail ?? "Not available"}</div>
    </div>
  )
}

function GitEnvironmentCard(props: { title: string; repo?: any }) {
  const repo = () => props.repo
  return (
    <div class="rounded-md border border-border-weaker-base bg-background-stronger p-3">
      <div class="mb-2 flex items-center justify-between gap-3">
        <div class="text-13-medium text-text-strong">{props.title}</div>
        <EnvironmentPill
          tone={repo()?.pushReady ? "ready" : "blocked"}
          label={repo()?.pushReady ? "push visible" : "blocked"}
        />
      </div>
      <div class="grid gap-2 sm:grid-cols-2">
        <EnvironmentInfoRow label="Branch" value={repo()?.branch} />
        <EnvironmentInfoRow label="Commit" value={repo()?.commit} />
        <EnvironmentInfoRow label="Dirty files" value={repo()?.dirtyCount} />
        <EnvironmentInfoRow label="Push remote" value={repo()?.pushRemote} />
      </div>
      <Show when={repo()?.remoteProbe?.error}>
        <div class="mt-3 rounded bg-background-base p-2 text-12-regular text-text-weak">
          {repo()?.remoteProbe?.error}
        </div>
      </Show>
      <Show when={(repo()?.dirtyPreview ?? []).length > 0}>
        <div class="mt-3">
          <div class="mb-1 text-12-regular text-text-weak">Dirty preview</div>
          <div class="flex flex-col gap-1">
            <For each={repo()?.dirtyPreview ?? []}>
              {(line: string) => (
                <code class="rounded bg-background-base px-2 py-1 text-11-regular text-text-strong">{line}</code>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}

function EnvironmentInfoRow(props: { label: string; value?: string | number | boolean | null }) {
  return (
    <div class="min-w-0 border-b border-border-weaker-base pb-2 last:border-b-0">
      <div class="text-11-regular text-text-weak">{props.label}</div>
      <div class="break-words text-12-regular text-text-strong">{String(props.value ?? "Not available")}</div>
    </div>
  )
}

function EnvironmentPill(props: { tone: "ready" | "warn" | "blocked"; label?: string }) {
  return (
    <span
      class="shrink-0 rounded px-2 py-1 text-11-regular"
      classList={{
        "bg-background-base text-text-strong": props.tone === "ready",
        "bg-[#f97316]/10 text-[#f97316]": props.tone === "warn",
        "bg-red-500/10 text-red-400": props.tone === "blocked",
      }}
    >
      {props.label ?? props.tone}
    </span>
  )
}

function formatShortDate(value?: string) {
  if (!value) return "n/a"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
}

function ResourcesTabContent() {
  const resources = createPolledJson<any>(() => "/experimental/resources/status", 15000)

  return (
    <TabChrome title="Resources" iconTab={PANEL_RESOURCES_TAB} onRefresh={resources.refresh}>
      <div class="flex flex-col gap-3">
        <Show when={resources.error()}>
          {(error) => (
            <div class="rounded-md border border-border-weaker-base bg-background-stronger p-3 text-12-regular text-text-weak">
              {error()}
            </div>
          )}
        </Show>
        <div class="grid gap-3 xl:grid-cols-2">
          <ResourceHostCard title="Server" status={resources.data()?.server} />
          <ResourceHostCard title="MacBook" status={resources.data()?.mac} />
        </div>
        <div class="rounded-md border border-border-weaker-base bg-background-stronger p-3 text-12-regular text-text-weak">
          Server metrics are local to CT100. Mac metrics require SSH from CT100 to the Mac; Mac View can still be live
          through the separate ScreenCaptureKit/Tailscale feed.
        </div>
        <StatusRow label="Last checked" value={resources.data()?.checkedAt} />
      </div>
    </TabChrome>
  )
}

function ResourceHostCard(props: { title: string; status?: any }) {
  const status = () => props.status
  return (
    <div class="rounded-md border border-border-weaker-base bg-background-stronger p-3">
      <div class="mb-3 flex items-center justify-between gap-3">
        <div class="flex items-center gap-2">
          <PanelGlyph tab={PANEL_RESOURCES_TAB} />
          <div class="text-14-regular text-text-strong">{props.title}</div>
        </div>
        <span
          class="rounded px-2 py-1 text-12-regular"
          classList={{
            "bg-background-base text-text-strong": !!status()?.online,
            "bg-background-base text-text-weak": !status()?.online,
          }}
        >
          {!status() ? "checking" : status()?.online ? "online" : "unavailable"}
        </span>
      </div>
      <div class="flex flex-col gap-2">
        <StatusRow
          label={status()?.online ? "Hostname" : "Status"}
          value={status()?.hostname ?? status()?.error ?? "checking"}
        />
        <StatusRow label="Last checked" value={status()?.checkedAt} />
        <StatusRow label="Uptime" value={formatDuration(status()?.uptimeSeconds)} />
        <StatusRow label="CPU" value={formatCpu(status()?.cpu)} />
        <StatusRow label="CPU pressure" value={formatCpuPressure(status()?.cpu)} />
        <ResourceMeter label="RAM" used={status()?.memory?.usedBytes} total={status()?.memory?.totalBytes} />
        <ResourceMeter label="Swap" used={status()?.swap?.usedBytes} total={status()?.swap?.totalBytes} />
        <For each={status()?.storage ?? []}>
          {(disk: any) => (
            <ResourceMeter label={`Storage ${disk.path}`} used={disk.usedBytes} total={disk.totalBytes} />
          )}
        </For>
      </div>
    </div>
  )
}

function ResourceMeter(props: { label: string; used?: number; total?: number }) {
  const pct = createMemo(() => {
    if (!props.total) return 0
    return Math.min(100, Math.max(0, Math.round(((props.used ?? 0) / props.total) * 100)))
  })

  return (
    <div class="flex flex-col gap-1">
      <div class="flex items-center justify-between gap-3 text-12-regular">
        <span class="min-w-0 truncate text-text-weak">{props.label}</span>
        <span class="shrink-0 text-text-strong">
          {formatBytes(props.used)} / {formatBytes(props.total)}
        </span>
      </div>
      <div class="h-1.5 overflow-hidden rounded bg-background-base">
        <div class="h-full bg-[#f97316]" style={{ width: `${pct()}%` }} />
      </div>
    </div>
  )
}

function formatBytes(value?: number) {
  if (!Number.isFinite(value)) return "n/a"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let amount = value ?? 0
  let index = 0
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024
    index += 1
  }
  return `${amount >= 10 || index === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[index]}`
}

function formatDuration(seconds?: number) {
  if (!Number.isFinite(seconds)) return "n/a"
  const days = Math.floor((seconds ?? 0) / 86400)
  const hours = Math.floor(((seconds ?? 0) % 86400) / 3600)
  const minutes = Math.floor(((seconds ?? 0) % 3600) / 60)
  return days > 0 ? `${days}d ${hours}h` : `${hours}h ${minutes}m`
}

function formatCpu(cpu?: {
  cores?: number
  load1?: number
  load5?: number
  load15?: number
  loadPercent1?: number
  loadPercent5?: number
  loadPercent15?: number
}) {
  if (!cpu) return "n/a"
  return `${cpu.cores ?? 0} cores, load ${formatLoad(cpu.load1)} / ${formatLoad(cpu.load5)} / ${formatLoad(cpu.load15)}`
}

function formatCpuPressure(cpu?: { loadPercent1?: number; loadPercent5?: number; loadPercent15?: number }) {
  if (!cpu) return "n/a"
  return `${formatPercent(cpu.loadPercent1)} / ${formatPercent(cpu.loadPercent5)} / ${formatPercent(cpu.loadPercent15)}`
}

function formatLoad(value?: number) {
  return Number.isFinite(value) ? (value ?? 0).toFixed(2) : "0.00"
}

function formatPercent(value?: number) {
  return Number.isFinite(value) ? `${Math.round(value ?? 0)}%` : "n/a"
}

function ArtifactsTabContent(props: { sessionID?: string }) {
  const { tabs } = useSessionLayout()
  const [selected, setSelected] = createSignal<any>()
  const artifacts = createPolledJson<any>(
    () => (props.sessionID ? `/experimental/browser/${encodeURIComponent(props.sessionID)}/artifacts` : undefined),
    8000,
  )

  createEffect(() => {
    const files = artifacts.data()?.files ?? []
    const current = selected()
    if (current && files.some((file: any) => file.name === current.name)) return
    setSelected(files[0])
  })

  const openArtifact = (file: any) => {
    const tab = artifactViewerTab(file)
    tabs().open(tab)
    tabs().setActive(tab)
  }

  return (
    <TabChrome title="Artifacts" iconTab={PANEL_ARTIFACTS_TAB} onRefresh={artifacts.refresh}>
      <div class="flex h-full min-h-0 flex-col gap-3">
        <StatusRow label="Artifact directory" value={artifacts.data()?.artifactDir} />
        <div class="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(220px,32%)_minmax(0,1fr)]">
          <div class="min-h-0 overflow-auto rounded-md border border-border-weaker-base bg-background-stronger">
            <For each={artifacts.data()?.files ?? []}>
              {(file: any) => (
                <button
                  class="flex w-full items-center gap-3 border-b border-border-weaker-base p-3 text-left last:border-b-0 hover:bg-surface-raised-base-hover"
                  classList={{ "bg-background-base": selected()?.name === file.name }}
                  onClick={() => {
                    setSelected(file)
                    openArtifact(file)
                  }}
                >
                  <PanelGlyph tab={PANEL_ARTIFACTS_TAB} />
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-14-regular text-text-strong">{file.name}</div>
                    <div class="text-12-regular text-text-weak">{file.size} bytes</div>
                  </div>
                </button>
              )}
            </For>
            <Show when={(artifacts.data()?.files ?? []).length === 0}>
              <div class="flex min-h-56 items-center justify-center p-6 text-center text-12-regular text-text-weak">
                No session artifacts yet.
              </div>
            </Show>
          </div>
          <div class="min-h-0 overflow-hidden rounded-md border border-border-weaker-base bg-background-stronger">
            <Show
              when={selected()}
              fallback={
                <div class="flex h-full min-h-56 items-center justify-center p-6 text-center text-12-regular text-text-weak">
                  Select an artifact to preview it here.
                </div>
              }
            >
              {(file) => <FilePreview file={file()} />}
            </Show>
          </div>
        </div>
      </div>
    </TabChrome>
  )
}

function FileBrowserTabContent() {
  const fileContext = useFile()
  const { tabs } = useSessionLayout()
  const initialState = readFileBrowserState()
  const [currentPath, setCurrentPath] = createSignal<string | undefined>(initialState.currentPath)
  const [mode, setMode] = createSignal<"list" | "icons">(initialState.mode ?? "list")
  const [query, setQuery] = createSignal(initialState.query ?? "")
  const [selectedPath, setSelectedPath] = createSignal<string | undefined>(initialState.selectedPath)
  const [selected, setSelected] = createSignal<any>()
  const browser = createPolledJson<any>(
    () => `/experimental/files/browse${currentPath() ? `?path=${encodeURIComponent(currentPath()!)}` : ""}`,
    12000,
  )
  createEffect(() =>
    writeFileBrowserState({ currentPath: currentPath(), mode: mode(), query: query(), selectedPath: selectedPath() }),
  )

  const opensInViewer = (entry: any) => ["image", "video", "audio", "pdf", "html", "json", "text"].includes(entry.kind)
  const openCodeFile = (entry: any) => {
    const tab = fileContext.tab(entry.path)
    tabs().open(tab)
    tabs().setActive(tab)
    void fileContext.load(entry.path)
  }

  const selectEntry = (entry: any) => {
    setSelected(entry)
    setSelectedPath(entry.path)
  }

  const openEntry = (entry: any) => {
    selectEntry(entry)
    if (entry.kind === "directory") {
      setSelected(undefined)
      setSelectedPath(undefined)
      setCurrentPath(entry.path)
      return
    }
    if (!opensInViewer(entry)) {
      openCodeFile(entry)
      return
    }
    const tab = artifactViewerTab(entry)
    tabs().open(tab)
    tabs().setActive(tab)
  }

  const entries = createMemo(() => {
    const all = browser.data()?.entries ?? []
    const needle = query().trim().toLowerCase()
    if (!needle) return all
    return all.filter((entry: any) =>
      `${entry.name} ${entry.kind} ${entry.contentType ?? ""}`.toLowerCase().includes(needle),
    )
  })

  createEffect(() => {
    const path = selectedPath()
    if (!path) {
      setSelected(undefined)
      return
    }
    const match = entries().find((entry: any) => entry.path === path)
    if (match) setSelected(match)
    else if (browser.data()) setSelected(undefined)
  })

  const details = createMemo(() => selected())

  return (
    <TabChrome
      iconTab={PANEL_FILE_BROWSER_TAB}
      headerClass="min-h-12 shrink-0 flex flex-wrap items-center gap-2 border-b border-border-weaker-base bg-background-base p-2"
      bodyClass="flex-1 min-h-0 overflow-hidden p-3"
      toolbar={
        <>
          <IconButton
            icon="arrow-left"
            variant="ghost"
            class="h-7 w-7"
            disabled={!browser.data()?.parent}
            onClick={() => {
              setSelected(undefined)
              setSelectedPath(undefined)
              setCurrentPath(browser.data()?.parent)
            }}
            aria-label="Parent folder"
          />
          <div class="min-w-[180px] flex-1 truncate rounded-md border border-border-weaker-base bg-background-stronger px-2 py-1 text-13-regular text-text-strong">
            {browser.data()?.path ?? "Loading..."}
          </div>
          <input
            class="h-8 min-w-[180px] rounded-md border border-border-weaker-base bg-background-stronger px-2 text-13-regular text-text-strong outline-none placeholder:text-text-weak"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search this folder"
          />
          <IconButton
            icon={mode() === "list" ? "dot-grid" : "bullet-list"}
            variant="ghost"
            class="h-7 w-7"
            onClick={() => setMode(mode() === "list" ? "icons" : "list")}
            aria-label="Toggle view"
          />
          <IconButton
            icon="reset"
            variant="ghost"
            class="h-7 w-7"
            onClick={() => browser.refresh()}
            aria-label="Refresh"
          />
        </>
      }
    >
      <div class="flex h-full min-h-0 flex-col gap-3">
        <Show when={browser.error()}>
          {(error) => (
            <div class="rounded-md border border-border-weaker-base bg-background-stronger p-3 text-12-regular text-text-weak">
              {error()}
            </div>
          )}
        </Show>
        <div class="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(280px,40%)]">
          <div class="min-h-0 overflow-auto rounded-md border border-border-weaker-base bg-background-stronger">
            <Switch>
              <Match when={mode() === "icons"}>
                <div class="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-2 p-2">
                  <For each={entries()}>
                    {(entry: any) => (
                      <button
                        class="min-h-24 rounded-md bg-background-base p-2 text-left hover:bg-surface-raised-base-hover"
                        classList={{ "ring-1 ring-[#f97316]": selected()?.path === entry.path }}
                        onClick={() => selectEntry(entry)}
                        onDblClick={() => openEntry(entry)}
                      >
                        <div class="mb-2 flex justify-center text-[#f97316]">
                          <Icon
                            name={entry.kind === "directory" ? "folder" : entry.kind === "image" ? "photo" : "code"}
                            size="large"
                          />
                        </div>
                        <div class="break-words text-center text-12-regular text-text-strong">{entry.name}</div>
                      </button>
                    )}
                  </For>
                </div>
              </Match>
              <Match when={true}>
                <div class="flex flex-col">
                  <For each={entries()}>
                    {(entry: any) => (
                      <button
                        class="flex items-center gap-3 border-b border-border-weaker-base px-3 py-2 text-left last:border-b-0 hover:bg-surface-raised-base-hover"
                        classList={{ "bg-background-base": selected()?.path === entry.path }}
                        onClick={() => selectEntry(entry)}
                        onDblClick={() => openEntry(entry)}
                      >
                        <span class="text-[#f97316]">
                          <Icon
                            name={entry.kind === "directory" ? "folder" : entry.kind === "image" ? "photo" : "code"}
                            size="small"
                          />
                        </span>
                        <span class="min-w-0 flex-1 truncate text-13-regular text-text-strong">{entry.name}</span>
                        <span class="shrink-0 text-12-regular text-text-weak">
                          {entry.kind === "directory" ? "folder" : `${entry.size ?? 0} bytes`}
                        </span>
                      </button>
                    )}
                  </For>
                  <Show when={entries().length === 0}>
                    <div class="flex min-h-40 items-center justify-center p-6 text-center text-12-regular text-text-weak">
                      No files match this search in the current folder.
                    </div>
                  </Show>
                </div>
              </Match>
            </Switch>
          </div>
          <div class="min-h-0 overflow-hidden rounded-md border border-border-weaker-base bg-background-stronger">
            <Show
              when={details()}
              fallback={
                <div class="flex h-full min-h-56 items-center justify-center p-6 text-center text-12-regular text-text-weak">
                  Select a file or folder to see details.
                </div>
              }
            >
              {(file) => <FileDetails file={file()} onOpen={() => openEntry(file())} />}
            </Show>
          </div>
        </div>
      </div>
    </TabChrome>
  )
}

function FileKindGlyph(props: { kind?: string; size?: "small" | "large" }) {
  const size = () => props.size ?? "small"
  if (props.kind === "directory") return <Icon name="folder" size={size()} />
  if (props.kind === "image") return <Icon name="photo" size={size()} />
  if (props.kind === "video" || props.kind === "audio") return <Icon name="photo" size={size()} />
  return <Icon name="code" size={size()} />
}

function FileDetails(props: { file: any; onOpen?: () => void }) {
  const file = () => props.file
  const actionLabel = createMemo(() => {
    if (file().kind === "directory") return "Open folder"
    if (["image", "video", "audio", "pdf", "html", "json", "text"].includes(file().kind)) return "Open viewer"
    return "Open code file"
  })
  const extension = createMemo(() => {
    const match = String(file().name ?? "").match(/\.([^.]+)$/)
    return match?.[1]?.toUpperCase() ?? "None"
  })
  return (
    <div class="flex h-full min-h-0 flex-col">
      <div class="flex shrink-0 items-center gap-3 border-b border-border-weaker-base px-3 py-3">
        <span class="flex size-10 items-center justify-center rounded-md border border-border-weaker-base bg-background-base text-[#f97316]">
          <FileKindGlyph kind={file().kind} size="large" />
        </span>
        <div class="min-w-0">
          <div class="truncate text-14-medium text-text-strong">{file().name}</div>
          <div class="text-12-regular text-text-weak">{file().kind ?? "file"}</div>
        </div>
      </div>
      <div class="min-h-0 flex-1 overflow-auto p-3">
        <div class="grid gap-2">
          <StatusRow label="Path" value={file().path} />
          <StatusRow label="Type" value={file().contentType ?? file().kind ?? "Unknown"} />
          <StatusRow label="Extension" value={extension()} />
          <StatusRow label="Size" value={file().kind === "directory" ? "Folder" : formatBytes(file().size)} />
          <StatusRow label="Modified" value={file().mtime ? new Date(file().mtime).toLocaleString() : "Unknown"} />
        </div>
      </div>
      <div class="flex shrink-0 items-center justify-end gap-2 border-t border-border-weaker-base p-3">
        <Show when={file().url}>
          <a
            class="flex h-8 items-center rounded-md border border-border-weaker-base bg-background-stronger px-3 text-13-regular text-text-strong hover:bg-surface-raised-base-hover"
            href={file().url}
            target="_blank"
            rel="noreferrer"
          >
            Open raw
          </a>
        </Show>
        <button
          class="h-8 rounded-md border border-border-weaker-base bg-background-stronger px-3 text-13-regular text-text-strong hover:bg-surface-raised-base-hover disabled:opacity-50"
          onClick={() => props.onOpen?.()}
        >
          {actionLabel()}
        </button>
      </div>
    </div>
  )
}

function FileViewerBar(props: { file: any; url?: string }) {
  const file = () => props.file
  return (
    <div class="flex h-full min-w-0 items-center gap-2">
      <span class="flex size-7 shrink-0 items-center justify-center rounded-md border border-border-weaker-base bg-background-stronger text-[#f97316]">
        <FileKindGlyph kind={file()?.kind} size="small" />
      </span>
      <div class="min-w-0 flex-1">
        <div class="truncate text-13-regular text-text-strong">{file()?.name ?? "Artifact"}</div>
        <div class="truncate text-11-regular text-text-weak">
          {[file()?.contentType ?? file()?.kind, formatBytes(file()?.size)].filter(Boolean).join(" · ")}
        </div>
      </div>
      <Show when={props.url}>
        {(href) => (
          <a
            class="shrink-0 rounded-md px-2 py-1 text-12-regular text-text-weak hover:bg-surface-base-hover hover:text-text-strong"
            href={href()}
            target="_blank"
            rel="noreferrer"
          >
            Open raw
          </a>
        )}
      </Show>
    </div>
  )
}

function FilePreview(props: { file: any; showHeader?: boolean }) {
  const file = () => props.file
  const url = () =>
    file().url ?? (file().path ? `/experimental/files/view?path=${encodeURIComponent(file().path)}` : undefined)
  const showHeader = () => props.showHeader !== false
  return (
    <div class="flex h-full min-h-0 flex-col">
      <Show when={showHeader()}>
        <div class="flex shrink-0 items-center justify-between gap-3 border-b border-border-weaker-base px-3 py-2">
          <FileViewerBar file={file()} url={url()} />
        </div>
      </Show>
      <div class="min-h-0 flex-1 overflow-auto">
        <Switch>
          <Match when={!url()}>
            <div class="flex h-full min-h-56 items-center justify-center p-6 text-center text-12-regular text-text-weak">
              This file does not have a viewable URL.
            </div>
          </Match>
          <Match when={file().kind === "image"}>
            <img src={url()} alt={file().name} class="block h-auto max-h-full w-full object-contain" />
          </Match>
          <Match when={file().kind === "video"}>
            <video src={url()} controls class="block h-full max-h-full w-full bg-black object-contain" />
          </Match>
          <Match when={file().kind === "audio"}>
            <div class="p-4">
              <audio src={url()} controls class="w-full" />
            </div>
          </Match>
          <Match when={file().kind === "pdf"}>
            <iframe src={url()} title={file().name} class="h-full min-h-96 w-full border-0" />
          </Match>
          <Match when={file().kind === "html"}>
            <iframe
              src={url()}
              title={file().name}
              class="h-full min-h-96 w-full border-0 bg-white"
              sandbox="allow-scripts allow-forms allow-same-origin"
            />
          </Match>
          <Match when={file().kind === "json" || file().kind === "text"}>
            <FileTextPreview url={url() ?? ""} />
          </Match>
          <Match when={true}>
            <div class="flex h-full min-h-56 items-center justify-center p-6 text-center text-12-regular text-text-weak">
              This file type can be opened externally or from the File Browser.
            </div>
          </Match>
        </Switch>
      </div>
    </div>
  )
}

function FileTextPreview(props: { url: string }) {
  const [content, setContent] = createSignal("Loading...")
  const [error, setError] = createSignal<string>()

  createEffect(() => {
    const currentUrl = props.url
    if (!currentUrl) {
      setContent("")
      setError("This file does not have a readable URL.")
      return
    }
    let cancelled = false
    setError(undefined)
    setContent("Loading...")
    fetch(currentUrl, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(`File request failed: ${response.status}`)
        return response.text()
      })
      .then((text) => {
        if (!cancelled) setContent(text)
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
    onCleanup(() => {
      cancelled = true
    })
  })

  return (
    <Show when={!error()} fallback={<div class="p-4 text-12-regular text-text-weak">{error()}</div>}>
      <pre class="min-h-full whitespace-pre-wrap break-words bg-background-base p-4 font-mono text-12-regular leading-5 text-text-strong">
        {content()}
      </pre>
    </Show>
  )
}

function ArtifactViewerTabContent(props: { tab: string }) {
  const file = createMemo(() => artifactFromTab(props.tab))
  const url = createMemo(() => {
    const current = file()
    return (
      current?.url ?? (current?.path ? `/experimental/files/view?path=${encodeURIComponent(current.path)}` : undefined)
    )
  })
  return (
    <TabChrome
      iconTab={props.tab}
      headerClass="h-10 shrink-0 flex items-center justify-between gap-3 px-3 border-b border-border-weaker-base bg-background-base"
      bodyClass="flex h-full min-h-0 flex-1 basis-0 overflow-hidden"
      toolbar={<FileViewerBar file={file()} url={url()} />}
    >
      <Show
        when={file()}
        fallback={
          <div class="flex h-full min-h-56 items-center justify-center p-6 text-center text-12-regular text-text-weak">
            Artifact tab data is unavailable.
          </div>
        }
      >
        {(artifact) => <FilePreview file={artifact()} showHeader={false} />}
      </Show>
    </TabChrome>
  )
}

function QueueTabContent(props: { sessionID?: string }) {
  const storageKey = createMemo(() => `opencode:message-queue:${props.sessionID ?? "draft"}`)
  const [draft, setDraft] = createSignal("")
  const [items, setItems] = createSignal<Array<{ id: string; text: string }>>([])

  const load = () => {
    try {
      setItems(JSON.parse(window.localStorage.getItem(storageKey()) || "[]"))
    } catch {
      setItems([])
    }
  }
  const save = (next: Array<{ id: string; text: string }>) => {
    setItems(next)
    window.localStorage.setItem(storageKey(), JSON.stringify(next))
  }
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text)
  }
  createEffect(load)

  const add = () => {
    const text = draft().trim()
    if (!text) return
    save([...items(), { id: `${Date.now()}`, text }])
    setDraft("")
  }
  const move = (id: string, direction: -1 | 1) => {
    const next = [...items()]
    const index = next.findIndex((item) => item.id === id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= next.length) return
    const [item] = next.splice(index, 1)
    if (!item) return
    next.splice(target, 0, item)
    save(next)
  }

  return (
    <TabChrome title="Queue" iconTab={PANEL_QUEUE_TAB}>
      <div class="flex flex-col gap-3">
        <textarea
          value={draft()}
          onInput={(event) => setDraft(event.currentTarget.value)}
          class="min-h-24 rounded-md border border-border-weaker-base bg-background-stronger p-3 text-14-regular text-text-strong outline-none resize-y"
          placeholder="Queue a steering message..."
        />
        <button
          class="h-8 px-3 rounded-md border border-border-weaker-base bg-background-stronger text-13-regular text-text-strong"
          onClick={add}
        >
          Add to queue
        </button>
        <For each={items()}>
          {(item) => (
            <div class="rounded-md border border-border-weaker-base bg-background-stronger p-3 flex gap-3">
              <div class="flex-1 min-w-0 text-13-regular text-text-strong whitespace-pre-wrap">{item.text}</div>
              <div class="flex flex-col gap-1">
                <IconButton
                  icon="arrow-up"
                  variant="ghost"
                  class="h-6 w-6"
                  onClick={() => move(item.id, -1)}
                  aria-label="Move up"
                />
                <IconButton
                  icon="arrow-down-to-line"
                  variant="ghost"
                  class="h-6 w-6"
                  onClick={() => move(item.id, 1)}
                  aria-label="Move down"
                />
                <IconButton
                  icon="copy"
                  variant="ghost"
                  class="h-6 w-6"
                  onClick={() => copy(item.text)}
                  aria-label="Copy"
                />
                <IconButton
                  icon="trash"
                  variant="ghost"
                  class="h-6 w-6"
                  onClick={() => save(items().filter((next) => next.id !== item.id))}
                  aria-label="Remove"
                />
              </div>
            </div>
          )}
        </For>
        <div class="rounded-md border border-border-weaker-base bg-background-stronger p-3 text-12-regular text-text-weak">
          MVP: queue and reorder steering messages per session. Direct injection into the composer/run loop is the next
          wiring step.
        </div>
      </div>
    </TabChrome>
  )
}

export function SessionSidePanel(props: {
  canReview: () => boolean
  diffs: () => (SnapshotFileDiff | VcsFileDiff)[]
  diffsReady: () => boolean
  empty: () => string
  hasReview: () => boolean
  reviewCount: () => number
  reviewPanel: () => JSX.Element
  activeDiff?: string
  focusReviewDiff: (path: string) => void
  reviewSnap: boolean
  mobile?: boolean
  size: Sizing
}) {
  const layout = useLayout()
  const settings = useSettings()
  const file = useFile()
  const language = useLanguage()
  const command = useCommand()
  const dialog = useDialog()
  const { sessionKey, tabs, view, params } = useSessionLayout()

  const isDesktop = createMediaQuery("(min-width: 768px)")
  const shown = settings.visibility.fileTree
  const mobile = createMemo(() => props.mobile === true)

  const reviewOpen = createMemo(() => mobile() || (isDesktop() && view().reviewPanel.opened()))
  const fileOpen = createMemo(
    () =>
      !mobile() &&
      isDesktop() &&
      shouldShowFileTree({
        visible: shown(),
        opened: layout.fileTree.opened(),
      }),
  )
  const open = createMemo(() => mobile() || reviewOpen() || fileOpen())
  const reviewTab = createMemo(() => mobile() || isDesktop())
  const panelWidth = createMemo(() => {
    if (mobile()) return "100%"
    if (!open()) return "0px"
    if (reviewOpen()) return "auto"
    return `${layout.fileTree.width()}px`
  })
  const treeWidth = createMemo(() => (fileOpen() ? `${layout.fileTree.width()}px` : "0px"))

  const diffs = createMemo(() => props.diffs().filter(renderDiff))
  const diffFiles = createMemo(() => diffs().map((d) => d.file))
  const kinds = createMemo(() => {
    const merge = (a: "add" | "del" | "mix" | undefined, b: "add" | "del" | "mix") => {
      if (!a) return b
      if (a === b) return a
      return "mix" as const
    }

    const normalize = (p: string) => p.replaceAll("\\\\", "/").replace(/\/+$/, "")

    const out = new Map<string, "add" | "del" | "mix">()
    for (const diff of diffs()) {
      const file = normalize(diff.file)
      const kind = diff.status === "added" ? "add" : diff.status === "deleted" ? "del" : "mix"

      out.set(file, kind)

      const parts = file.split("/")
      for (const [idx] of parts.slice(0, -1).entries()) {
        const dir = parts.slice(0, idx + 1).join("/")
        if (!dir) continue
        out.set(dir, merge(out.get(dir), kind))
      }
    }
    return out
  })

  const empty = (msg: string) => (
    <div class="h-full flex flex-col">
      <div class="h-6 shrink-0" aria-hidden />
      <div class="flex-1 pb-64 flex items-center justify-center text-center">
        <div class="text-12-regular text-text-weak">{msg}</div>
      </div>
    </div>
  )

  const nofiles = createMemo(() => {
    const state = file.tree.state("")
    if (!state?.loaded) return false
    return file.tree.children("").length === 0
  })

  createEffect(() => {
    if (view().terminal.opened()) view().terminal.close()
  })

  const normalizeTab = (tab: string) => {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  const openReviewPanel = () => {
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
  }

  const openTab = createOpenSessionFileTab({
    normalizeTab,
    openTab: tabs().open,
    pathFromTab: file.pathFromTab,
    loadFile: file.load,
    openReviewPanel,
    setActive: tabs().setActive,
  })

  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab,
    review: reviewTab,
    hasReview: props.canReview,
  })
  const contextOpen = tabState.contextOpen
  const openedTabs = tabState.openedTabs
  const activeTab = tabState.activeTab
  const openedPanelTabs = createMemo(() => {
    const result: string[] = []
    for (const tab of openedTabs()) {
      if (!isPanelTab(tab) || tab === PANEL_QUEUE_TAB) continue
      const canonical = canonicalPanelTab(tab)
      if (!result.includes(canonical)) result.push(canonical)
    }
    return result
  })
  const openedFileTabs = createMemo(() => openedTabs().filter((tab) => !isPanelTab(tab)))
  const activePanelTab = createMemo(() => {
    const active = activeTab()
    if (!active) return
    if (active === PANEL_QUEUE_TAB) return undefined
    return isPanelTab(active) ? canonicalPanelTab(active) : undefined
  })
  const activeFileTab = createMemo(() => {
    const active = activeTab()
    if (!active) return
    if (!openedFileTabs().includes(active)) return
    return active
  })
  const activeArtifactTab = createMemo(() => {
    const active = activePanelTab()
    if (!active?.startsWith(ARTIFACT_VIEWER_TAB_PREFIX)) return
    return active
  })

  createEffect(() => {
    const active = activeTab()
    if (!active || active === "empty" || active === "review" || active === "context") return
    if (!isPanelTab(active)) return

    const canonical = canonicalPanelTab(active)
    if (canonical !== active) {
      tabs().open(canonical)
      tabs().setActive(canonical)
      tabs().close(active)
      return
    }

    if (!openedTabs().includes(canonical)) tabs().open(canonical)
    // Only react to active-tab changes here. Tracking reviewPanel.opened() made the
    // header close button useless: closing the panel re-ran this effect and reopened it.
    if (!untrack(mobile) && !untrack(() => view().reviewPanel.opened())) view().reviewPanel.open()
  })

  createEffect(() => {
    const openPanelIDs = openedPanelTabs()
    const active = activePanelTab()
    if (!active || openPanelIDs.includes(active)) return
    tabs().open(active)
  })

  createEffect(() => {
    if (activeTab() !== PANEL_QUEUE_TAB) return
    tabs().close(PANEL_QUEUE_TAB)
    tabs().setActive("review")
  })

  const fileTreeTab = () => layout.fileTree.tab()

  const setFileTreeTabValue = (value: string) => {
    if (value !== "changes" && value !== "all") return
    layout.fileTree.setTab(value)
  }

  const showAllFiles = () => {
    if (fileTreeTab() !== "changes") return
    layout.fileTree.setTab("all")
  }

  const showFilePicker = () => {
    setPanelMenuOpen(false)
    void import("@/components/dialog-select-file").then((x) => {
      dialog.show(() => <x.DialogSelectFile mode="files" onOpenFile={showAllFiles} />)
    })
  }

  const openPanelTab = (tab: string) => {
    const nextTab = canonicalPanelTab(tab)
    setPanelMenuOpen(false)
    openReviewPanel()
    if (nextTab === PANEL_TERMINAL_TAB && view().terminal.opened()) view().terminal.close()
    tabs().open(nextTab)
    tabs().setActive(nextTab)
  }

  const changeActiveTab = (tab: string) => {
    setPanelMenuOpen(false)
    if (isPanelTab(tab) || tab === "review" || tab === "context" || tab === "empty") {
      const nextTab = isPanelTab(tab) ? canonicalPanelTab(tab) : tab
      if (isPanelTab(nextTab)) tabs().open(nextTab)
      tabs().setActive(nextTab)
      if (nextTab === PANEL_TERMINAL_TAB && view().terminal.opened()) view().terminal.close()
      return
    }
    openTab(tab)
  }

  const closePanelTab = (tab: string) => {
    const nextTab = canonicalPanelTab(tab)
    const current = activeTab()
    const wasActive = current === nextTab || (!!current && canonicalPanelTab(current) === nextTab)
    const remainingPanelTabs = openedPanelTabs().filter((id) => id !== nextTab)
    const remainingFileTabs = openedFileTabs().filter((id) => id !== nextTab)
    tabs().close(nextTab)
    if (!wasActive) return

    if (remainingPanelTabs.length > 0) {
      tabs().setActive(remainingPanelTabs[remainingPanelTabs.length - 1]!)
    } else if (reviewTab() && props.canReview()) {
      tabs().setActive("review")
    } else if (contextOpen()) {
      tabs().setActive("context")
    } else if (remainingFileTabs.length > 0) {
      tabs().setActive(remainingFileTabs[remainingFileTabs.length - 1]!)
    } else {
      tabs().setActive("empty")
    }
  }

  const [browserLaunch, setBrowserLaunch] = createSignal<BrowserLaunchRequest | undefined>()
  const [openDesignBridgeState, setOpenDesignBridgeState] = createSignal<any>({
    mode: "dashboard",
    active: false,
  })
  const workspaceTabClientID = (() => {
    if (typeof window === "undefined") return `server-${params.id ?? "unknown"}`
    const key = `opencode:workspace-tabs:client:${params.id ?? "global"}`
    const existing = window.sessionStorage.getItem(key)
    if (existing) return existing
    const generated = `wtc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    window.sessionStorage.setItem(key, generated)
    return generated
  })()
  const [panelMenuOpen, setPanelMenuOpen] = createSignal(false)

  const collectWorkspaceTabClientState = () => {
    const workspacePanelOpen = reviewOpen()
    const visibleActivePanelTab = workspacePanelOpen ? activePanelTab() : undefined
    const currentActiveTab = activeTab()
    return {
      sessionID: params.id,
      clientID: workspaceTabClientID,
      route: typeof window === "undefined" ? undefined : window.location.pathname,
      activeTab: isPanelTab(currentActiveTab ?? "") && !workspacePanelOpen ? undefined : currentActiveTab,
      rawActiveTab: currentActiveTab,
      activePanelTab: visibleActivePanelTab,
      rawActivePanelTab: activePanelTab(),
      openTabs: openedTabs(),
      openedTabs: openedTabs(),
      openPanelTabs: openedPanelTabs(),
      openedPanelTabs: openedPanelTabs(),
      openFileTabs: openedFileTabs(),
      openedFileTabs: openedFileTabs(),
      reviewOpen: workspacePanelOpen,
      panelOpen: workspacePanelOpen,
      rightRailOpen: open(),
      mobile: mobile(),
      desktop: isDesktop(),
      selected: {
        fileBrowser: readFileBrowserState(),
        activeArtifact: workspacePanelOpen ? activeArtifactTab() : undefined,
        activeFile: activeFileTab(),
        openDesign: openDesignBridgeState(),
      },
      bridges: {
        openDesign: openDesignBridgeState(),
      },
      visibleControls: {
        plusMenuOpen: panelMenuOpen(),
        canReview: props.canReview(),
        fileTreeOpen: fileOpen(),
        workspacePanelOpen,
      },
    }
  }

  const postWorkspaceTabClientState = async () => {
    if (typeof window === "undefined") return
    try {
      await fetch("/experimental/workspace-tabs/client-state", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(collectWorkspaceTabClientState()),
      })
    } catch {
      // Best-effort sync only; the visible UI must keep working if the status route is unavailable.
    }
  }

  createEffect(() => {
    if (typeof window === "undefined") return
    const state = openDesignBridgeState()
    const target = window as Window & {
      __opencodeOpenDesignBridgeState?: unknown
    }
    target.__opencodeOpenDesignBridgeState = state
    window.dispatchEvent(new CustomEvent("opencode:open-design-bridge-state", { detail: state }))
  })

  createEffect(() => {
    if (typeof window === "undefined") return
    const state = openDesignBridgeState()
    if (!state?.active) return
    if (activePanelTab() === PANEL_OPEN_DESIGN_TAB) return
    setOpenDesignBridgeState({
      ...state,
      active: false,
      mode: "inactive",
      reason: "open-design-panel-inactive",
      updatedAt: new Date().toISOString(),
    })
  })

  let workspaceTabStateTimer: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    JSON.stringify({
      activeTab: activeTab(),
      openTabs: openedTabs(),
      openPanelTabs: openedPanelTabs(),
      panelOpen: open(),
      mobile: mobile(),
      fileBrowser: readFileBrowserState(),
      openDesignBridge: openDesignBridgeState(),
    })
    if (workspaceTabStateTimer) clearTimeout(workspaceTabStateTimer)
    workspaceTabStateTimer = setTimeout(() => void postWorkspaceTabClientState(), 250)
  })
  onCleanup(() => {
    if (workspaceTabStateTimer) clearTimeout(workspaceTabStateTimer)
  })

  const ackWorkspaceTabAction = async (actionID: string, ok: boolean, error?: string) => {
    try {
      await fetch("/experimental/workspace-tabs/ack", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actionID, ok, error, state: collectWorkspaceTabClientState() }),
      })
    } catch {
      // The pending action will expire server-side by queue length if ack cannot be delivered.
    }
  }

  const applyWorkspaceTabAction = async (pending: any) => {
    const clientAction = pending?.clientAction ?? pending
    const actionID = clientAction?.actionID ?? pending?.id
    const action = clientAction?.action ?? pending?.action
    const tab = clientAction?.tab ?? pending?.tab
    if (!actionID || !action) return
    try {
      if (action === "close" && typeof tab === "string") {
        closePanelTab(canonicalPanelTab(tab))
      } else if ((action === "open" || action === "focus") && typeof tab === "string") {
        openPanelTab(tab)
      } else if (action === "run_action" && typeof tab === "string") {
        openPanelTab(tab)
        window.dispatchEvent(new CustomEvent("opencode:workspace-tab-run-action", { detail: clientAction }))
      } else if ((action === "attach_to_chat" || action === "snapshot") && typeof tab === "string") {
        openPanelTab(tab)
      }
      await ackWorkspaceTabAction(actionID, true)
      void postWorkspaceTabClientState()
    } catch (error) {
      await ackWorkspaceTabAction(actionID, false, error instanceof Error ? error.message : String(error))
    }
  }

  const appliedWorkspaceActions = new Set<string>()
  const pollWorkspaceTabActions = async () => {
    if (typeof window === "undefined") return
    try {
      const search = new URLSearchParams()
      if (params.id) search.set("sessionID", params.id)
      search.set("clientID", workspaceTabClientID)
      const query = `?${search.toString()}`
      const response = await fetch(`/experimental/workspace-tabs/pending${query}`)
      if (!response.ok) return
      const payload = await response.json()
      for (const pending of payload.actions ?? []) {
        const actionID = pending?.id ?? pending?.clientAction?.actionID
        if (!actionID || appliedWorkspaceActions.has(actionID)) continue
        appliedWorkspaceActions.add(actionID)
        void applyWorkspaceTabAction(pending)
      }
    } catch {
      // Polling is best-effort; manual tab controls remain authoritative.
    }
  }

  const workspaceActionPoller = setInterval(() => void pollWorkspaceTabActions(), 1000)
  const workspaceStateHeartbeat = setInterval(() => void postWorkspaceTabClientState(), 10000)
  onCleanup(() => {
    clearInterval(workspaceActionPoller)
    clearInterval(workspaceStateHeartbeat)
  })

  const launchOpenDesign = () => {
    openPanelTab(PANEL_OPEN_DESIGN_TAB)
  }

  createEffect(() => {
    const handleWorkspaceTabAction = (event: Event) => {
      const detail = (event as CustomEvent<any>).detail ?? {}
      const action = typeof detail.action === "string" ? detail.action : undefined
      const tab =
        typeof detail.tab === "string" ? detail.tab : typeof detail.target === "string" ? detail.target : undefined
      if (!tab) return

      if (action === "close") {
        tabs().close(tab)
      } else if (isPanelTab(tab)) {
        openPanelTab(tab)
        if (tab === PANEL_BROWSER_TAB && typeof detail.url === "string") {
          setBrowserLaunch({ url: detail.url, nonce: Date.now() })
        }
      }

      window.dispatchEvent(
        new CustomEvent("opencode:workspace-tab-action-applied", {
          detail: {
            ok: true,
            action,
            tab,
            activeTab: activeTab(),
          },
        }),
      )
    }

    window.addEventListener("opencode:workspace-tab-action", handleWorkspaceTabAction)
    onCleanup(() => window.removeEventListener("opencode:workspace-tab-action", handleWorkspaceTabAction))
  })

  const [store, setStore] = createStore({
    activeDraggable: undefined as string | undefined,
  })

  const handleDragStart = (event: unknown) => {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeDraggable", id)
  }

  const handleDragOver = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (!draggable || !droppable) return

    const currentTabs = tabs().all()
    const toIndex = getTabReorderIndex(currentTabs, draggable.id.toString(), droppable.id.toString())
    if (toIndex === undefined) return
    tabs().move(draggable.id.toString(), toIndex)
  }

  const handleDragEnd = () => {
    setStore("activeDraggable", undefined)
  }

  createEffect(() => {
    if (!file.ready()) return

    setSessionHandoff(sessionKey(), {
      files: tabs()
        .all()
        .reduce<Record<string, SelectedLineRange | null>>((acc, tab) => {
          const path = file.pathFromTab(tab)
          if (!path) return acc

          const selected = file.selectedLines(path)
          acc[path] =
            selected && typeof selected === "object" && "start" in selected && "end" in selected
              ? (selected as SelectedLineRange)
              : null

          return acc
        }, {}),
    })
  })

  return (
    <>
      <Show when={openDesignBridgeState()?.active ? openDesignBridgeState() : undefined}>
        {(bridge) => (
          <Portal>
            <div class="pointer-events-none fixed bottom-24 left-1/2 z-[900] max-w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 rounded-full border border-blue-400/35 bg-blue-500/12 px-3 py-1.5 text-12-medium text-blue-200 shadow-[0_0_24px_rgba(59,130,246,0.22)] backdrop-blur">
              <span class="text-blue-100">Design Mode</span>
              <span class="mx-2 text-blue-300/70">/</span>
              <span class="text-blue-200/90">{bridge().projectName ?? bridge().projectId ?? "OpenDesign"}</span>
              <Show when={bridge().chatName ?? bridge().chatId}>
                {(chat) => (
                  <>
                    <span class="mx-2 text-blue-300/70">/</span>
                    <span class="text-blue-200/75">{chat()}</span>
                  </>
                )}
              </Show>
            </div>
          </Portal>
        )}
      </Show>
      <Show when={(mobile() && !!params.id) || (isDesktop() && !(settings.general.newLayoutDesigns() && !params.id))}>
        <aside
          id="review-panel"
          aria-label={language.t("session.panel.reviewAndFiles")}
          aria-hidden={!open()}
          inert={!open()}
          class={`relative min-w-0 h-full flex shrink-0 overflow-hidden bg-background-base ${MOBILE_PANEL_SHELL_MIN_HEIGHT_CLASS}`}
          classList={{
            "pointer-events-none": !open(),
            "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
              !mobile() && !props.size.active() && !props.reviewSnap,
            "rounded-[10px] shadow-[var(--v2-elevation-raised)] overflow-hidden":
              !mobile() && settings.general.newLayoutDesigns(),
            "flex-1": reviewOpen() || mobile(),
          }}
          style={{ width: panelWidth() }}
        >
          <Show when={open()}>
            <div
              class="size-full flex"
              classList={{
                "border-l border-border-weaker-base": !settings.general.newLayoutDesigns(),
              }}
            >
              <div
                aria-hidden={!reviewOpen()}
                inert={!reviewOpen()}
                class="relative min-w-0 h-full flex-1 overflow-hidden bg-background-base"
                classList={{
                  "pointer-events-none": !reviewOpen(),
                }}
              >
                <div class={`size-full min-w-0 h-full bg-background-base ${MOBILE_PANEL_SHELL_MIN_HEIGHT_CLASS}`}>
                  <DragDropProvider
                    onDragStart={handleDragStart}
                    onDragEnd={handleDragEnd}
                    onDragOver={handleDragOver}
                    collisionDetector={closestCenter}
                  >
                    <DragDropSensors />
                    <ConstrainDragYAxis />
                    <Tabs
                      value={activeTab()}
                      onChange={changeActiveTab}
                      class={`flex h-full min-h-0 min-w-0 flex-col overflow-hidden ${MOBILE_PANEL_TABS_MIN_HEIGHT_CLASS}`}
                    >
                      <div class="sticky top-0 z-40 flex min-w-0 shrink-0 overflow-visible">
                        <Tabs.List
                          class="min-w-0 flex-1 overflow-x-auto overflow-y-visible pr-12 [scrollbar-width:none]"
                          ref={(el: HTMLDivElement) => {
                            if (mobile()) return
                            const stop = createFileTabListSync({ el, contextOpen })
                            onCleanup(stop)
                          }}
                        >
                          <Show when={reviewTab() && props.canReview()}>
                            <Tabs.Trigger value="review">
                              <div class="flex items-center gap-1.5">
                                <div>{language.t("session.tab.review")}</div>
                                <Show when={!mobile() && props.hasReview()}>
                                  <div>{props.reviewCount()}</div>
                                </Show>
                              </div>
                            </Tabs.Trigger>
                          </Show>
                          <Show when={contextOpen()}>
                            <Tabs.Trigger
                              value="context"
                              closeButton={
                                <TooltipKeybind
                                  title={language.t("common.closeTab")}
                                  keybind={command.keybind("tab.close")}
                                  placement="bottom"
                                  gutter={10}
                                >
                                  <IconButton
                                    icon="close-small"
                                    variant="ghost"
                                    class="h-5 w-5"
                                    onPointerDown={(event) => event.stopPropagation()}
                                    onClick={(event) => {
                                      event.stopPropagation()
                                      tabs().close("context")
                                    }}
                                    aria-label={language.t("common.closeTab")}
                                  />
                                </TooltipKeybind>
                              }
                              hideCloseButton
                              onMiddleClick={() => tabs().close("context")}
                            >
                              <div class="flex items-center gap-2">
                                <SessionContextUsage variant="indicator" />
                                <div>{language.t("session.tab.context")}</div>
                              </div>
                            </Tabs.Trigger>
                          </Show>
                          <For each={openedPanelTabs()}>
                            {(tab) => <PanelTab tab={tab} onClose={closePanelTab} onActivate={changeActiveTab} />}
                          </For>
                          <SortableProvider ids={openedFileTabs()}>
                            <For each={openedFileTabs()}>
                              {(tab) => <SortableTab tab={tab} onTabClose={tabs().close} />}
                            </For>
                          </SortableProvider>
                        </Tabs.List>
                        <MenuV2
                          gutter={4}
                          modal={false}
                          placement="bottom-end"
                          open={panelMenuOpen()}
                          onOpenChange={setPanelMenuOpen}
                        >
                          <MenuV2.Trigger
                            data-panel-menu-trigger
                            data-action="workspace-add-tab"
                            class="z-50 flex h-full shrink-0 items-center justify-center border-l border-border-weaker-base bg-background-stronger px-2 text-text-weak outline-none hover:bg-surface-base-hover hover:text-text-strong data-[expanded]:bg-surface-base-active data-[expanded]:text-text-strong max-sm:w-14 max-sm:px-0"
                            aria-label="Add workspace tab"
                            title="Add workspace tab"
                            onPointerDown={(event) => event.stopPropagation()}
                          >
                            <span class="flex size-8 items-center justify-center rounded-md max-sm:size-10">
                              <Icon name="plus-small" size="large" />
                            </span>
                          </MenuV2.Trigger>
                          <MenuV2.Portal>
                            <MenuV2.Content
                              data-panel-menu-root
                              class="max-h-[min(360px,calc(100vh-1rem))] w-52 overflow-auto"
                            >
                              <MenuV2.Group>
                                <MenuV2.GroupLabel>Open Workspace Tab</MenuV2.GroupLabel>
                                <MenuV2.Item onSelect={showFilePicker}>
                                  <span class="flex min-w-0 items-center gap-2">
                                    <span class="size-4 shrink-0" />
                                    <span class="truncate">Files</span>
                                  </span>
                                </MenuV2.Item>
                                <For each={WORKSPACE_PANEL_TABS.filter((tab) => !tab.hidden)}>
                                  {(tab) => (
                                    <MenuV2.Item
                                      data-panel-menu-item-id={tab.id}
                                      onSelect={() =>
                                        tab.id === PANEL_OPEN_DESIGN_TAB ? launchOpenDesign() : openPanelTab(tab.id)
                                      }
                                    >
                                      <span class="flex min-w-0 items-center gap-2">
                                        <PanelGlyph tab={tab.id} />
                                        <span class="truncate">{tab.label}</span>
                                      </span>
                                    </MenuV2.Item>
                                  )}
                                </For>
                              </MenuV2.Group>
                            </MenuV2.Content>
                          </MenuV2.Portal>
                        </MenuV2>
                      </div>

                      <Show when={reviewTab() && props.canReview()}>
                        <Tabs.Content value="review" class={WORKSPACE_PANEL_CONTENT_STRICT_CLASS}>
                          <Show when={reviewOpen() && activeTab() === "review"}>{props.reviewPanel()}</Show>
                        </Tabs.Content>
                      </Show>

                      <Tabs.Content value="empty" class={WORKSPACE_PANEL_CONTENT_STRICT_CLASS}>
                        <Show when={activeTab() === "empty"}>
                          <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                            <div class="h-full px-6 pb-42 -mt-4 flex flex-col items-center justify-center text-center gap-6">
                              <Mark class="w-14 opacity-10" />
                              <div class="text-14-regular text-text-weak max-w-56">
                                {language.t("session.files.selectToOpen")}
                              </div>
                            </div>
                          </div>
                        </Show>
                      </Tabs.Content>

                      <Show when={contextOpen()}>
                        <Tabs.Content value="context" class={WORKSPACE_PANEL_CONTENT_STRICT_CLASS}>
                          <Show when={activeTab() === "context"}>
                            <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                              <SessionContextTab />
                            </div>
                          </Show>
                        </Tabs.Content>
                      </Show>

                      <Tabs.Content
                        value={PANEL_TERMINAL_TAB}
                        class={WORKSPACE_PANEL_CONTENT_STRICT_CLASS}
                      >
                        <Show when={activePanelTab() === PANEL_TERMINAL_TAB}>
                          <SessionTerminalTab />
                        </Show>
                      </Tabs.Content>

                      <Tabs.Content
                        value={PANEL_BROWSER_TAB}
                        class={WORKSPACE_PANEL_CONTENT_LAYOUT_CLASS}
                      >
                        <Show when={activePanelTab() === PANEL_BROWSER_TAB}>
                          <BrowserTabContent sessionID={params.id} launch={browserLaunch()} />
                        </Show>
                      </Tabs.Content>

                      <Tabs.Content
                        value={PANEL_PREVIEW_TAB}
                        class={WORKSPACE_PANEL_CONTENT_LAYOUT_CLASS}
                      >
                        <Show when={activePanelTab() === PANEL_PREVIEW_TAB}>
                          <PreviewTabContent sessionID={params.id} />
                        </Show>
                      </Tabs.Content>

                      <Tabs.Content
                        value={PANEL_OPEN_DESIGN_TAB}
                        class={WORKSPACE_PANEL_CONTENT_LAYOUT_CLASS}
                      >
                        <Show when={activePanelTab() === PANEL_OPEN_DESIGN_TAB}>
                          <OpenDesignTabContent
                            bridgeState={openDesignBridgeState}
                            onBridgeState={setOpenDesignBridgeState}
                          />
                        </Show>
                      </Tabs.Content>

                      <Tabs.Content
                        value={PANEL_MAC_VIEW_TAB}
                        class={WORKSPACE_PANEL_CONTENT_LAYOUT_CLASS}
                      >
                        <Show when={activePanelTab() === PANEL_MAC_VIEW_TAB}>
                          <MacViewTabContent />
                        </Show>
                      </Tabs.Content>

                      <Tabs.Content
                        value={PANEL_ACCOUNTS_TAB}
                        class={WORKSPACE_PANEL_CONTENT_STRICT_CLASS}
                      >
                        <Show when={activePanelTab() === PANEL_ACCOUNTS_TAB}>
                          <AccountsTabContent />
                        </Show>
                      </Tabs.Content>

                      <Tabs.Content
                        value={PANEL_ROUTINES_TAB}
                        class={WORKSPACE_PANEL_CONTENT_STRICT_CLASS}
                      >
                        <Show when={activePanelTab() === PANEL_ROUTINES_TAB}>
                          <RoutinesTabContent />
                        </Show>
                      </Tabs.Content>

                      <Tabs.Content
                        value={PANEL_ENVIRONMENT_TAB}
                        class={WORKSPACE_PANEL_CONTENT_STRICT_CLASS}
                      >
                        <Show when={activePanelTab() === PANEL_ENVIRONMENT_TAB}>
                          <EnvironmentTabContent />
                        </Show>
                      </Tabs.Content>

                      <Tabs.Content
                        value={PANEL_RESOURCES_TAB}
                        class={WORKSPACE_PANEL_CONTENT_STRICT_CLASS}
                      >
                        <Show when={activePanelTab() === PANEL_RESOURCES_TAB}>
                          <ResourcesTabContent />
                        </Show>
                      </Tabs.Content>

                      <Tabs.Content
                        value={PANEL_ARTIFACTS_TAB}
                        class={WORKSPACE_PANEL_CONTENT_LAYOUT_CLASS}
                      >
                        <Show when={activePanelTab() === PANEL_ARTIFACTS_TAB}>
                          <ArtifactsTabContent sessionID={params.id} />
                        </Show>
                      </Tabs.Content>

                      <Tabs.Content
                        value={PANEL_FILE_BROWSER_TAB}
                        class={WORKSPACE_PANEL_CONTENT_STRICT_CLASS}
                      >
                        <Show when={activePanelTab() === PANEL_FILE_BROWSER_TAB}>
                          <FileBrowserTabContent />
                        </Show>
                      </Tabs.Content>

                      <Show when={activeArtifactTab()} keyed>
                        {(tab) => (
                          <Tabs.Content value={tab} class={WORKSPACE_PANEL_CONTENT_LAYOUT_CLASS}>
                            <ArtifactViewerTabContent tab={tab} />
                          </Tabs.Content>
                        )}
                      </Show>

                      <Show when={activeFileTab()} keyed>
                        {(tab) => <FileTabContent tab={tab} />}
                      </Show>
                    </Tabs>
                    <DragOverlay>
                      <Show when={store.activeDraggable} keyed>
                        {(tab) => {
                          const path = file.pathFromTab(tab)
                          return (
                            <div data-component="tabs-drag-preview">
                              <Show when={path}>{(p) => <FileVisual active path={p()} />}</Show>
                            </div>
                          )
                        }}
                      </Show>
                    </DragOverlay>
                  </DragDropProvider>
                </div>
              </div>

              <Show when={shown()}>
                <div
                  id="file-tree-panel"
                  aria-hidden={!fileOpen()}
                  inert={!fileOpen()}
                  class="relative min-w-0 h-full shrink-0 overflow-hidden"
                  classList={{
                    "pointer-events-none": !fileOpen(),
                    "transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
                      !props.size.active(),
                  }}
                  style={{ width: treeWidth() }}
                >
                  <div
                    class="h-full flex flex-col overflow-hidden group/filetree"
                    classList={{ "border-l border-border-weaker-base": reviewOpen() }}
                  >
                    <Tabs
                      variant="pill"
                      value={fileTreeTab()}
                      onChange={setFileTreeTabValue}
                      class="h-full"
                      data-scope="filetree"
                    >
                      <Tabs.List>
                        <Tabs.Trigger value="changes" class="flex-1" classes={{ button: "w-full" }}>
                          {props.reviewCount()}{" "}
                          {language.t(
                            props.reviewCount() === 1 ? "session.review.change.one" : "session.review.change.other",
                          )}
                        </Tabs.Trigger>
                        <Tabs.Trigger value="all" class="flex-1" classes={{ button: "w-full" }}>
                          {language.t("session.files.all")}
                        </Tabs.Trigger>
                      </Tabs.List>
                      <Tabs.Content value="changes" class="bg-background-stronger px-3 py-0">
                        <Switch>
                          <Match when={props.hasReview() || !props.diffsReady()}>
                            <Show
                              when={props.diffsReady()}
                              fallback={
                                <div class="px-2 py-2 text-12-regular text-text-weak">
                                  {language.t("common.loading")}
                                  {language.t("common.loading.ellipsis")}
                                </div>
                              }
                            >
                              <FileTree
                                path=""
                                class="pt-3"
                                allowed={diffFiles()}
                                kinds={kinds()}
                                draggable={false}
                                active={props.activeDiff}
                                onFileClick={(node) => props.focusReviewDiff(node.path)}
                              />
                            </Show>
                          </Match>
                        </Switch>
                      </Tabs.Content>
                      <Tabs.Content value="all" class="bg-background-stronger px-3 py-0">
                        <Switch>
                          <Match when={nofiles()}>{empty(language.t("session.files.empty"))}</Match>
                          <Match when={true}>
                            <FileTree
                              path=""
                              class="pt-3"
                              modified={diffFiles()}
                              kinds={kinds()}
                              onFileClick={(node) => openTab(file.tab(node.path))}
                            />
                          </Match>
                        </Switch>
                      </Tabs.Content>
                    </Tabs>
                  </div>
                  <Show when={fileOpen()}>
                    <div onPointerDown={() => props.size.start()}>
                      <ResizeHandle
                        direction="horizontal"
                        edge="start"
                        size={layout.fileTree.width()}
                        min={200}
                        max={480}
                        onResize={(width) => {
                          props.size.touch()
                          layout.fileTree.resize(width)
                        }}
                      />
                    </div>
                  </Show>
                </div>
              </Show>
            </div>
          </Show>
        </aside>
      </Show>
    </>
  )
}
