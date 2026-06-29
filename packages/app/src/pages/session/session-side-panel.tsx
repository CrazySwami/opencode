import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { createMediaQuery } from "@solid-primitives/media"
import { Tabs } from "@opencode-ai/ui/tabs"
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
import { SessionContextTab, SortableTab, FileVisual } from "@/components/session"
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
  getTabReorderIndex,
  shouldShowFileTree,
  type Sizing,
} from "@/pages/session/helpers"
import { setSessionHandoff } from "@/pages/session/handoff"
import { useSessionLayout } from "@/pages/session/session-layout"

type RenderDiff = (SnapshotFileDiff & { file: string }) | VcsFileDiff
const PANEL_TERMINAL_TAB = "panel://terminal"
const PANEL_BROWSER_TAB = "panel://browser"
const PANEL_OPEN_DESIGN_TAB = "panel://open-design"
const PANEL_MAC_VIEW_TAB = "panel://mac-view"
const PANEL_ACCOUNTS_TAB = "panel://accounts"
const PANEL_RESOURCES_TAB = "panel://resources"
const PANEL_ARTIFACTS_TAB = "panel://artifacts"
const PANEL_FILE_BROWSER_TAB = "panel://file-browser"
const PANEL_QUEUE_TAB = "panel://queue"
const PANEL_TABS = new Set([
  PANEL_TERMINAL_TAB,
  PANEL_BROWSER_TAB,
  PANEL_OPEN_DESIGN_TAB,
  PANEL_MAC_VIEW_TAB,
  PANEL_ACCOUNTS_TAB,
  PANEL_RESOURCES_TAB,
  PANEL_ARTIFACTS_TAB,
  PANEL_FILE_BROWSER_TAB,
  PANEL_QUEUE_TAB,
])

function renderDiff(value: SnapshotFileDiff | VcsFileDiff): value is RenderDiff {
  return typeof value.file === "string"
}

function isPanelTab(tab: string) {
  return PANEL_TABS.has(tab)
}

function panelTabLabel(tab: string) {
  if (tab === PANEL_TERMINAL_TAB) return "Terminal"
  if (tab === PANEL_BROWSER_TAB) return "Browser"
  if (tab === PANEL_OPEN_DESIGN_TAB) return "Open Design"
  if (tab === PANEL_MAC_VIEW_TAB) return "Mac View"
  if (tab === PANEL_ACCOUNTS_TAB) return "Accounts"
  if (tab === PANEL_RESOURCES_TAB) return "Resources"
  if (tab === PANEL_ARTIFACTS_TAB) return "Artifacts"
  if (tab === PANEL_FILE_BROWSER_TAB) return "File Browser"
  if (tab === PANEL_QUEUE_TAB) return "Queue"
  return tab
}

function panelTabIcon(tab: string) {
  if (tab === PANEL_TERMINAL_TAB) return <Icon name="terminal" size="small" />
  if (tab === PANEL_BROWSER_TAB) return <Icon name="window-cursor" size="small" />
  if (tab === PANEL_OPEN_DESIGN_TAB) return <span class="text-[10px] leading-none font-semibold tracking-[0]">OD</span>
  if (tab === PANEL_MAC_VIEW_TAB) return <Icon name="eye" size="small" />
  if (tab === PANEL_ACCOUNTS_TAB) return <Icon name="providers" size="small" />
  if (tab === PANEL_RESOURCES_TAB) return <span class="text-[9px] leading-none font-semibold tracking-[0]">CPU</span>
  if (tab === PANEL_ARTIFACTS_TAB) return <Icon name="photo" size="small" />
  if (tab === PANEL_FILE_BROWSER_TAB) return <Icon name="folder" size="small" />
  if (tab === PANEL_QUEUE_TAB) return <Icon name="checklist" size="small" />
}

function PanelGlyph(props: { tab: string }) {
  return (
    <span class="size-4 shrink-0 inline-flex items-center justify-center text-[#f97316]">{panelTabIcon(props.tab)}</span>
  )
}

function PanelTab(props: { tab: string; onClose: (tab: string) => void }) {
  const command = useCommand()
  const language = useLanguage()
  return (
    <Tabs.Trigger
      value={props.tab}
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
      onMiddleClick={() => props.onClose(props.tab)}
    >
      <div class="flex items-center gap-2">
        <PanelGlyph tab={props.tab} />
        <span>{panelTabLabel(props.tab)}</span>
      </div>
    </Tabs.Trigger>
  )
}

function PanelMenuButton(props: { tab: string; onSelect: () => void }) {
  return (
    <button
      type="button"
      class="flex h-8 w-full items-center gap-2 rounded-md px-3 text-left text-13-regular text-text-base hover:bg-surface-base-hover"
      onClick={props.onSelect}
    >
      <PanelGlyph tab={props.tab} />
      <span>{panelTabLabel(props.tab)}</span>
    </button>
  )
}

function SessionTerminalTab() {
  const terminal = useTerminal()
  const language = useLanguage()
  const { view } = useSessionLayout()

  createEffect(() => {
    if (view().terminal.opened()) view().terminal.close()
  })

  createEffect(() => {
    if (!terminal.ready()) return
    if (terminal.all().length > 0) return
    terminal.new()
  })

  return (
    <div class="h-full min-h-0 flex flex-col bg-background-stronger">
      <Show
        when={terminal.ready()}
        fallback={
          <div class="flex-1 flex items-center justify-center text-12-regular text-text-weak">Loading terminal...</div>
        }
      >
        <Tabs variant="alt" value={terminal.active()} onChange={(id) => terminal.open(id)} class="!h-auto !flex-none">
          <Tabs.List class="h-10 border-b border-border-weaker-base">
            <For each={terminal.all()}>
              {(pty) => (
                <Tabs.Trigger
                  value={pty.id}
                  closeButton={
                    <IconButton
                      icon="close-small"
                      variant="ghost"
                      class="h-5 w-5"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation()
                        void terminal.close(pty.id)
                      }}
                      aria-label={language.t("terminal.close")}
                    />
                  }
                  hideCloseButton
                  onMiddleClick={() => void terminal.close(pty.id)}
                >
                  {terminalTabLabel({
                    title: pty.title,
                    titleNumber: pty.titleNumber,
                    t: language.t as (key: string, vars?: Record<string, string | number | boolean>) => string,
                  })}
                </Tabs.Trigger>
              )}
            </For>
            <div class="h-full flex items-center justify-center">
              <IconButton
                icon="plus-small"
                variant="ghost"
                iconSize="large"
                onClick={terminal.new}
                aria-label={language.t("command.terminal.new")}
              />
            </div>
          </Tabs.List>
        </Tabs>
        <div class="flex-1 min-h-0 relative">
          <Show when={terminal.active()} keyed>
            {(id) => {
              const ops = terminal.bind()
              return (
                <Show when={terminal.all().find((pty) => pty.id === id)}>
                  {(pty) => (
                    <div class="absolute inset-0">
                      <Terminal
                        pty={pty()}
                        autoFocus
                        onConnect={() => terminal.trim(id)}
                        onCleanup={ops.update}
                        onConnectError={() => undefined}
                      />
                    </div>
                  )}
                </Show>
              )
            }}
          </Show>
        </div>
      </Show>
    </div>
  )
}

type BrowserLaunchRequest = { url: string; nonce: number }

type LiveBrowserStatus = {
  ok?: boolean
  currentURL?: string
  title?: string
  mode?: string
  display?: string
  error?: string
  streamURL?: string
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

function BrowserTabContent(props: { sessionID?: string; launch?: BrowserLaunchRequest }) {
  const [streamKey, setStreamKey] = createSignal(Date.now())
  const [status, setStatus] = createSignal<LiveBrowserStatus>({})
  const [browserUrl, setBrowserUrl] = createSignal("")
  const [browserText, setBrowserText] = createSignal("")
  const [selector, setSelector] = createSignal("")
  const [note, setNote] = createSignal("")
  const [browserBusy, setBrowserBusy] = createSignal(false)
  const [browserError, setBrowserError] = createSignal<string | undefined>()
  const [previewReady, setPreviewReady] = createSignal(false)
  const [annotating, setAnnotating] = createSignal(false)
  const [drawing, setDrawing] = createSignal(false)
  const [lastArtifact, setLastArtifact] = createSignal<{ url: string; name: string } | undefined>()
  let consumedLaunch = 0
  let imageRef: HTMLImageElement | undefined
  let canvasRef: HTMLCanvasElement | undefined

  const streamSrc = createMemo(() => `${status().streamURL ?? "/experimental/browser/live/stream"}?t=${streamKey()}`)
  const displayUrl = createMemo(() => status().currentURL || browserUrl() || "about:blank")

  const refreshStatus = async () => {
    try {
      const response = await fetch("/experimental/browser/live/status", { cache: "no-store" })
      const body = await response.json().catch(() => ({}))
      setStatus(body)
      if (typeof body.currentURL === "string" && !browserUrl()) setBrowserUrl(body.currentURL)
      setBrowserError(body.error)
    } catch (error) {
      setBrowserError(error instanceof Error ? error.message : String(error))
    }
  }

  const runLiveInput = async (body: Record<string, unknown>) => {
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
      ArrowLeft: "Left",
      ArrowRight: "Right",
      ArrowUp: "Up",
      ArrowDown: "Down",
      Backspace: "BackSpace",
      Delete: "Delete",
      Enter: "Return",
      Escape: "Escape",
      Tab: "Tab",
    }
    return aliases[key] ?? key
  }

  const pointForEvent = (event: MouseEvent) => {
    const image = imageRef
    if (!image) return
    const rect = image.getBoundingClientRect()
    const x = Math.round(((event.clientX - rect.left) / rect.width) * 1440)
    const y = Math.round(((event.clientY - rect.top) / rect.height) * 1000)
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

    const allowed = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Backspace", "Delete", "Enter", "Escape", "Tab"])
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
        const dataUrl = annotationDataURL || await captureAnnotatedDataURL()
        if (dataUrl) {
          window.dispatchEvent(new CustomEvent("opencode:add-image-attachment", {
            detail: {
              dataUrl,
              filename: body.name || "browser-screenshot.png",
              mime: "image/png",
              sourcePath: body.path,
            },
          }))
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
    <div class="h-full min-h-0 flex flex-col bg-background-base">
      <div class="h-12 shrink-0 border-b border-border-weaker-base bg-background-stronger px-2 py-1.5">
        <div class="flex h-full min-w-0 items-center gap-1 rounded-md border border-border-weaker-base bg-background-base px-1.5">
          <IconButton icon="arrow-left" variant="ghost" class="h-7 w-7 shrink-0" disabled={browserBusy()} onClick={() => void runLiveInput({ action: "back" })} aria-label="Back" />
          <IconButton icon="arrow-right" variant="ghost" class="h-7 w-7 shrink-0" disabled={browserBusy()} onClick={() => void runLiveInput({ action: "forward" })} aria-label="Forward" />
          <IconButton icon="reset" variant="ghost" class="h-7 w-7 shrink-0" disabled={browserBusy()} onClick={() => void runLiveInput({ action: "reload" })} aria-label="Reload page" />
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
            <IconButton icon="enter" variant="ghost" class="h-7 w-7 shrink-0" disabled={browserBusy()} onClick={submitBrowserUrl} aria-label="Open URL" />
          </form>
          <div class="hidden min-w-0 items-center gap-1 md:flex">
            <span class="max-w-40 truncate px-1 text-11-regular text-text-weak">{browserBusy() ? "working" : previewReady() ? "live" : "connecting"}</span>
            <span
              class="h-2 w-2 shrink-0 rounded-full"
              classList={{
                "bg-[#f97316]": !!status().browserUse?.ok,
                "bg-text-disabled": !status().browserUse?.ok,
              }}
              title={status().browserUse?.ok ? "Browser Use ready" : "Browser Use unavailable"}
            />
          </div>
          <IconButton icon="photo" variant="ghost" class="h-7 w-7 shrink-0" disabled={browserBusy()} onClick={() => void saveScreenshot(false)} aria-label="Save screenshot" />
          <IconButton icon="pencil-line" variant="ghost" class="h-7 w-7 shrink-0" disabled={browserBusy()} onClick={() => setAnnotating(!annotating())} aria-label={annotating() ? "Stop annotating" : "Annotate screenshot"} />
          <IconButton icon="share" variant="ghost" class="h-7 w-7 shrink-0" disabled={browserBusy()} onClick={() => void saveScreenshot(true)} aria-label="Send screenshot to chat" />
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
                <IconButton icon="enter" variant="ghost" class="h-8 w-8" disabled={browserBusy() || !browserText()} onClick={sendBrowserText} aria-label="Type into page" />
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
                <IconButton icon="enter" variant="ghost" class="h-8 w-8" disabled={browserBusy() || !selector()} onClick={highlightSelector} aria-label="Highlight selector" />
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
                <Show when={status().browserUse?.health?.browserUseVersion}>{(version) => <span>v{version()}</span>}</Show>
                <Show when={status().browserUse?.health?.model}>{(model) => <span>{model()}</span>}</Show>
                <Show when={status().browserUse?.activeSessions !== undefined}><span>{status().browserUse?.activeSessions} sessions</span></Show>
                <Show when={status().browserUse?.liveURL}>{(url) => <button class="ml-auto rounded px-2 py-0.5 text-text-strong hover:bg-surface-raised-base-hover" type="button" onClick={() => window.open(url(), "_blank", "noopener,noreferrer")}>Open noVNC</button>}</Show>
              </div>
              <Show when={browserError()}>{(error) => <div class="text-12-regular text-text-weak break-all">{error()}</div>}</Show>
              <Show when={lastArtifact()}>{(artifact) => <div class="text-12-regular text-text-weak">Saved <a class="text-text-strong underline" href={artifact().url} target="_blank" rel="noreferrer">{artifact().name}</a></div>}</Show>
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
      </div>
      <div
        class="relative min-h-0 flex-1 overflow-auto bg-background-base outline-none"
        tabIndex={0}
        onClick={handleViewportClick}
        onWheel={handleViewportWheel}
        onKeyDown={handleViewportKeyDown}
      >
        <Show when={!previewReady()}>
          <div class="absolute inset-0 flex items-center justify-center text-center text-12-regular text-text-weak">
            Starting live Chromium...
          </div>
        </Show>
        <img
          ref={(el) => (imageRef = el)}
          src={streamSrc()}
          alt="Live Chromium browser"
          class="block w-full h-auto select-none"
          classList={{ invisible: !previewReady() }}
          onLoad={() => {
            setPreviewReady(true)
            if (annotating()) resizeCanvas()
          }}
          onError={() => setPreviewReady(false)}
        />
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
      </div>
    </div>
  )
}

function createPolledJson<T>(url: () => string | undefined, intervalMs = 10000) {
  const [data, setData] = createSignal<T | undefined>()
  const [error, setError] = createSignal<string | undefined>()
  const refresh = async () => {
    const current = url()
    if (!current) return
    try {
      const response = await fetch(current, { cache: "no-store" })
      const body = await response.json()
      if (!response.ok) throw new Error(JSON.stringify(body))
      setData(() => body as T)
      setError(undefined)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  createEffect(() => {
    if (!url()) return
    void refresh()
    const timer = window.setInterval(() => void refresh(), intervalMs)
    onCleanup(() => window.clearInterval(timer))
  })
  return { data, error, refresh }
}

function StatusRow(props: { label: string; value?: string | number | boolean | null }) {
  return (
    <div class="rounded-md border border-border-weaker-base bg-background-stronger p-3">
      <div class="text-12-regular text-text-weak">{props.label}</div>
      <div class="text-14-regular text-text-strong break-all">{String(props.value ?? "Not available")}</div>
    </div>
  )
}

function TabChrome(props: { title: string; iconTab: string; onRefresh?: () => void; children: JSX.Element }) {
  return (
    <div class="h-full min-h-0 flex flex-col bg-background-base">
      <div class="h-10 shrink-0 flex items-center justify-between gap-3 px-3 border-b border-border-weaker-base">
        <div class="flex items-center gap-2 text-14-medium text-text-strong">
          <PanelGlyph tab={props.iconTab} />
          <span>{props.title}</span>
        </div>
        <Show when={!!props.onRefresh}>
          <IconButton icon="reset" variant="ghost" class="h-7 w-7" onClick={() => props.onRefresh?.()} aria-label="Refresh" />
        </Show>
      </div>
      <div class="flex-1 min-h-0 overflow-auto p-3">{props.children}</div>
    </div>
  )
}

function OpenDesignTabContent() {
  const status = createPolledJson<any>(() => "/experimental/open-design/status")
  const launchUrl = createMemo(() =>
    status.data()?.proxyReady
      ? (status.data()?.proxyURL ?? "/experimental/open-design/proxy/")
      : (status.data()?.publicURL ?? "https://design.hustletogether.com"),
  )

  const openExternal = () => window.open(launchUrl(), "_blank", "noopener,noreferrer")

  return (
    <TabChrome title="Open Design" iconTab={PANEL_OPEN_DESIGN_TAB} onRefresh={status.refresh}>
      <div class="flex flex-col gap-3">
        <Show when={status.error()}>
          {(error) => <div class="rounded-md border border-border-weaker-base bg-background-stronger p-3 text-12-regular text-text-weak">{error()}</div>}
        </Show>
        <StatusRow label="Launch URL" value={launchUrl()} />
        <StatusRow label="Daemon" value={status.data()?.daemonURL} />
        <StatusRow label="Proxy" value={status.data()?.proxyReady ? "enabled" : "disabled"} />
        <StatusRow label="Health" value={status.data()?.health?.ok ? "healthy" : "not ready"} />
        <StatusRow label="Projects" value={status.data()?.projects?.count} />
        <div class="flex gap-2">
          <button
            class="h-8 px-3 rounded-md border border-border-weaker-base bg-background-stronger text-13-regular text-text-strong"
            onClick={openExternal}
          >
            Open in external browser
          </button>
        </div>
        <div class="rounded-md border border-border-weaker-base bg-background-stronger p-3">
          <div class="text-12-regular text-text-weak mb-2">Projects</div>
          <div class="flex flex-col gap-2">
            <For each={status.data()?.projects?.projects ?? []}>
              {(project: any) => (
                <div class="flex items-center justify-between gap-3 text-13-regular">
                  <span class="text-text-strong truncate">{project.name}</span>
                  <span class="text-text-weak shrink-0">{project.status ?? "ready"}</span>
                </div>
              )}
            </For>
            <Show when={(status.data()?.projects?.projects ?? []).length === 0}>
              <div class="text-13-regular text-text-weak">No projects reported by the daemon.</div>
            </Show>
          </div>
        </div>
        <div class="rounded-md border border-border-weaker-base bg-background-stronger p-3 text-12-regular text-text-weak">
          The model can use the native <span class="text-text-strong">@open_design</span> tool. The hosted UI remains on
          safe 404 until Cloudflare Access is approved.
        </div>
      </div>
    </TabChrome>
  )
}

function MacViewTabContent() {
  const status = createPolledJson<any>(() => "/experimental/mac-view/status")
  const [streamKey, setStreamKey] = createSignal(Date.now())

  return (
    <div class="h-full min-h-0 flex flex-col bg-background-base">
      <div class="h-10 shrink-0 flex items-center justify-between gap-3 px-3 border-b border-border-weaker-base bg-background-stronger">
        <div class="flex min-w-0 items-center gap-2 text-14-medium text-text-strong">
          <PanelGlyph tab={PANEL_MAC_VIEW_TAB} />
          <span>Mac View</span>
          <span class="truncate text-12-regular text-text-weak">{status.data()?.health?.ok ? "live" : (status.data()?.note ?? "checking")}</span>
        </div>
        <div class="flex items-center gap-1">
          <IconButton icon="reset" variant="ghost" class="h-7 w-7" onClick={() => { void status.refresh(); setStreamKey(Date.now()) }} aria-label="Refresh Mac View" />
          <Show when={status.data()?.feedURL}>{(feedURL) => <IconButton icon="square-arrow-top-right" variant="ghost" class="h-7 w-7" onClick={() => window.open(feedURL(), "_blank", "noopener,noreferrer")} aria-label="Open feed externally" />}</Show>
        </div>
      </div>
      <Show
        when={status.data()?.configured}
        fallback={
          <div class="flex flex-1 items-center justify-center p-6 text-center text-13-regular text-text-weak">
            Mac View needs OPENCODE_MAC_VIEW_URL pointed at the ScreenCaptureKit helper.
          </div>
        }
      >
        <div class="min-h-0 flex-1 overflow-auto bg-background-base">
          <img
            src={`/experimental/mac-view/stream?t=${streamKey()}`}
            alt="Live Mac screen"
            class="block h-auto w-full select-none"
            onError={() => void status.refresh()}
          />
        </div>
      </Show>
    </div>
  )
}

function AccountsTabContent() {
  const status = createPolledJson<any>(() => "/experimental/workspace-suite/status")
  const workspace = createPolledJson<any>(() => "/__workspace-index", 15000)

  return (
    <TabChrome
      title="Accounts"
      iconTab={PANEL_ACCOUNTS_TAB}
      onRefresh={() => {
        void status.refresh()
        void workspace.refresh()
      }}
    >
      <div class="flex flex-col gap-3">
        <StatusRow label="Hostname" value={status.data()?.hostname} />
        <StatusRow label="Open Design token" value={status.data()?.openDesign?.configured ? "configured" : "not configured"} />
        <StatusRow label="Mac View" value={status.data()?.macView?.configured ? "configured" : "not configured"} />
        <StatusRow label="Workspace projects" value={workspace.data()?.projects?.length} />
        <StatusRow label="Recent sessions" value={workspace.data()?.sessions?.length} />
        <div class="rounded-md border border-border-weaker-base bg-background-stronger p-3">
          <div class="text-12-regular text-text-weak mb-2">Native tools</div>
          <div class="flex flex-wrap gap-2">
            <For each={status.data()?.tools ?? []}>
              {(tool: string) => <span class="rounded bg-background-base px-2 py-1 text-12-regular text-text-strong">@{tool}</span>}
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
          {status()?.online ? "online" : "offline"}
        </span>
      </div>
      <div class="flex flex-col gap-2">
        <StatusRow label="Hostname" value={status()?.hostname ?? status()?.error ?? "unavailable"} />
        <StatusRow label="Uptime" value={formatDuration(status()?.uptimeSeconds)} />
        <StatusRow label="CPU" value={formatCpu(status()?.cpu)} />
        <ResourceMeter label="RAM" used={status()?.memory?.usedBytes} total={status()?.memory?.totalBytes} />
        <For each={status()?.storage ?? []}>
          {(disk: any) => <ResourceMeter label={`Storage ${disk.path}`} used={disk.usedBytes} total={disk.totalBytes} />}
        </For>
      </div>
    </div>
  )
}

function ResourceMeter(props: { label: string; used?: number; total?: number }) {
  const pct = createMemo(() => {
    if (!props.total) return 0
    return Math.min(100, Math.max(0, Math.round((props.used ?? 0) / props.total * 100)))
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

function formatCpu(cpu?: { cores?: number; load1?: number; load5?: number; load15?: number }) {
  if (!cpu) return "n/a"
  return `${cpu.cores ?? 0} cores, load ${formatLoad(cpu.load1)} / ${formatLoad(cpu.load5)} / ${formatLoad(cpu.load15)}`
}

function formatLoad(value?: number) {
  return Number.isFinite(value) ? (value ?? 0).toFixed(2) : "0.00"
}

function ArtifactsTabContent(props: { sessionID?: string }) {
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
                  onClick={() => setSelected(file)}
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
  const [currentPath, setCurrentPath] = createSignal<string | undefined>()
  const [mode, setMode] = createSignal<"list" | "icons">("list")
  const [selected, setSelected] = createSignal<any>()
  const browser = createPolledJson<any>(
    () =>
      `/experimental/files/browse${currentPath() ? `?path=${encodeURIComponent(currentPath()!)}` : ""}`,
    12000,
  )

  const opensInViewer = (entry: any) => ["image", "video", "audio", "pdf"].includes(entry.kind)
  const openCodeFile = (entry: any) => {
    const tab = fileContext.tab(entry.path)
    tabs().open(tab)
    tabs().setActive(tab)
    void fileContext.load(entry.path)
  }

  const openEntry = (entry: any) => {
    if (entry.kind === "directory") {
      setSelected(undefined)
      setCurrentPath(entry.path)
      return
    }
    if (!opensInViewer(entry)) {
      openCodeFile(entry)
      return
    }
    setSelected(entry)
  }

  const preview = createMemo(() => selected())

  return (
    <TabChrome title="File Browser" iconTab={PANEL_FILE_BROWSER_TAB} onRefresh={browser.refresh}>
      <div class="flex h-full min-h-0 flex-col gap-3">
        <div class="flex items-center gap-2 rounded-md border border-border-weaker-base bg-background-stronger p-2">
          <IconButton
            icon="arrow-left"
            variant="ghost"
            class="h-7 w-7"
            disabled={!browser.data()?.parent}
            onClick={() => {
              setSelected(undefined)
              setCurrentPath(browser.data()?.parent)
            }}
            aria-label="Parent folder"
          />
          <div class="min-w-0 flex-1 truncate text-13-regular text-text-strong">{browser.data()?.path ?? "Loading..."}</div>
          <IconButton
            icon={mode() === "list" ? "dot-grid" : "bullet-list"}
            variant="ghost"
            class="h-7 w-7"
            onClick={() => setMode(mode() === "list" ? "icons" : "list")}
            aria-label="Toggle view"
          />
        </div>
        <Show when={browser.error()}>
          {(error) => <div class="rounded-md border border-border-weaker-base bg-background-stronger p-3 text-12-regular text-text-weak">{error()}</div>}
        </Show>
        <div class="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(280px,40%)]">
          <div class="min-h-0 overflow-auto rounded-md border border-border-weaker-base bg-background-stronger">
            <Switch>
              <Match when={mode() === "icons"}>
                <div class="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-2 p-2">
                  <For each={browser.data()?.entries ?? []}>
                    {(entry: any) => (
                      <button
                        class="min-h-24 rounded-md bg-background-base p-2 text-left hover:bg-surface-raised-base-hover"
                        onClick={() => openEntry(entry)}
                      >
                        <div class="mb-2 flex justify-center text-[#f97316]">
                          <Icon name={entry.kind === "directory" ? "folder" : entry.kind === "image" ? "photo" : "code"} size="large" />
                        </div>
                        <div class="break-words text-center text-12-regular text-text-strong">{entry.name}</div>
                      </button>
                    )}
                  </For>
                </div>
              </Match>
              <Match when={true}>
                <div class="flex flex-col">
                  <For each={browser.data()?.entries ?? []}>
                    {(entry: any) => (
                      <button
                        class="flex items-center gap-3 border-b border-border-weaker-base px-3 py-2 text-left last:border-b-0 hover:bg-surface-raised-base-hover"
                        onClick={() => openEntry(entry)}
                      >
                        <span class="text-[#f97316]">
                          <Icon name={entry.kind === "directory" ? "folder" : entry.kind === "image" ? "photo" : "code"} size="small" />
                        </span>
                        <span class="min-w-0 flex-1 truncate text-13-regular text-text-strong">{entry.name}</span>
                        <span class="shrink-0 text-12-regular text-text-weak">
                          {entry.kind === "directory" ? "folder" : `${entry.size ?? 0} bytes`}
                        </span>
                      </button>
                    )}
                  </For>
                </div>
              </Match>
            </Switch>
          </div>
          <div class="min-h-0 overflow-hidden rounded-md border border-border-weaker-base bg-background-stronger">
            <Show
              when={preview()}
              fallback={
                <div class="flex h-full min-h-56 items-center justify-center p-6 text-center text-12-regular text-text-weak">
                  Select a file to preview it here.
                </div>
              }
            >
              {(file) => (
                <FilePreview file={file()} />
              )}
            </Show>
          </div>
        </div>
      </div>
    </TabChrome>
  )
}

function FilePreview(props: { file: any }) {
  const file = () => props.file
  const url = () => file().url
  return (
    <div class="flex h-full min-h-0 flex-col">
      <div class="flex shrink-0 items-center justify-between gap-3 border-b border-border-weaker-base px-3 py-2">
        <div class="min-w-0 truncate text-13-regular text-text-strong">{file().name}</div>
        <a class="shrink-0 text-12-regular text-text-weak hover:text-text-strong" href={url()} target="_blank" rel="noreferrer">
          Open
        </a>
      </div>
      <div class="min-h-0 flex-1 overflow-auto">
        <Switch>
          <Match when={file().kind === "image"}>
            <img src={url()} alt={file().name} class="block h-auto w-full" />
          </Match>
          <Match when={file().kind === "video"}>
            <video src={url()} controls class="block h-auto w-full" />
          </Match>
          <Match when={file().kind === "audio"}>
            <div class="p-3">
              <audio src={url()} controls class="w-full" />
            </div>
          </Match>
          <Match when={file().kind === "pdf"}>
            <iframe src={url()} title={file().name} class="h-full min-h-96 w-full border-0" />
          </Match>
          <Match when={true}>
            <div class="flex h-full min-h-56 items-center justify-center p-6 text-center text-12-regular text-text-weak">
              Code and text files open in normal editor tabs.
            </div>
          </Match>
        </Switch>
      </div>
    </div>
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
                <IconButton icon="arrow-up" variant="ghost" class="h-6 w-6" onClick={() => move(item.id, -1)} aria-label="Move up" />
                <IconButton icon="arrow-down-to-line" variant="ghost" class="h-6 w-6" onClick={() => move(item.id, 1)} aria-label="Move down" />
                <IconButton icon="copy" variant="ghost" class="h-6 w-6" onClick={() => copy(item.text)} aria-label="Copy" />
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
          MVP: queue and reorder steering messages per session. Direct injection into the composer/run loop is the next wiring step.
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
  const openedPanelTabs = createMemo(() => openedTabs().filter(isPanelTab))
  const openedFileTabs = createMemo(() => openedTabs().filter((tab) => !isPanelTab(tab)))
  const activePanelTab = createMemo(() => {
    const active = activeTab()
    if (!active) return
    return isPanelTab(active) ? active : undefined
  })
  const activeFileTab = createMemo(() => {
    const active = activeTab()
    if (!active) return
    if (!openedFileTabs().includes(active)) return
    return active
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
    setPanelMenuOpen(false)
    openReviewPanel()
    if (tab === PANEL_TERMINAL_TAB && view().terminal.opened()) view().terminal.close()
    tabs().open(tab)
    tabs().setActive(tab)
  }

  const changeActiveTab = (tab: string) => {
    setPanelMenuOpen(false)
    if (isPanelTab(tab) || tab === "review" || tab === "context" || tab === "empty") {
      if (isPanelTab(tab)) tabs().open(tab)
      tabs().setActive(tab)
      if (tab === PANEL_TERMINAL_TAB && view().terminal.opened()) view().terminal.close()
      return
    }
    openTab(tab)
  }

  const [browserLaunch, setBrowserLaunch] = createSignal<BrowserLaunchRequest | undefined>()
  const [panelMenuOpen, setPanelMenuOpen] = createSignal(false)

  const launchOpenDesign = () => {
    openPanelTab(PANEL_BROWSER_TAB)
    void fetch("/experimental/open-design/status", { cache: "no-store" })
      .then((response) => response.json())
      .then((status) => {
        const url =
          status?.proxyReady && status?.proxyURL
            ? status.proxyURL
            : status?.publicURL || "https://design.hustletogether.com"
        setBrowserLaunch({ url, nonce: Date.now() })
      })
      .catch(() => setBrowserLaunch({ url: "https://design.hustletogether.com", nonce: Date.now() }))
  }

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
    <Show when={(mobile() && !!params.id) || (isDesktop() && !(settings.general.newLayoutDesigns() && !params.id))}>
      <aside
        id="review-panel"
        aria-label={language.t("session.panel.reviewAndFiles")}
        aria-hidden={!open()}
        inert={!open()}
        class="relative min-w-0 h-full flex shrink-0 overflow-hidden bg-background-base"
        classList={{
          "pointer-events-none": !open(),
          "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
            !mobile() && !props.size.active() && !props.reviewSnap,
          "rounded-[10px] shadow-[var(--v2-elevation-raised)] overflow-hidden": !mobile() && settings.general.newLayoutDesigns(),
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
              <div class="size-full min-w-0 h-full bg-background-base">
                <DragDropProvider
                  onDragStart={handleDragStart}
                  onDragEnd={handleDragEnd}
                  onDragOver={handleDragOver}
                  collisionDetector={closestCenter}
                >
                  <DragDropSensors />
                  <ConstrainDragYAxis />
                  <Tabs value={activeTab()} onChange={changeActiveTab}>
                    <div class="sticky top-0 shrink-0 flex min-w-0 overflow-hidden">
                      <Tabs.List
                        class="min-w-0"
                        ref={(el: HTMLDivElement) => {
                          const stop = createFileTabListSync({ el, contextOpen })
                          onCleanup(stop)
                        }}
                      >
                        <Show when={reviewTab() && props.canReview()}>
                          <Tabs.Trigger value="review">
                            <div class="flex items-center gap-1.5">
                              <div>{language.t("session.tab.review")}</div>
                              <Show when={props.hasReview()}>
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
                        <For each={openedPanelTabs()}>{(tab) => <PanelTab tab={tab} onClose={tabs().close} />}</For>
                        <SortableProvider ids={openedFileTabs()}>
                          <For each={openedFileTabs()}>
                            {(tab) => <SortableTab tab={tab} onTabClose={tabs().close} />}
                          </For>
                        </SortableProvider>
                        <div class="bg-background-stronger h-full shrink-0 sticky right-0 z-50 flex items-center justify-center pr-3 relative">
                          <IconButton
                            icon="plus-small"
                            variant="ghost"
                            iconSize="large"
                            class="!rounded-md"
                            aria-label="Add tab"
                            aria-expanded={panelMenuOpen()}
                            onClick={(event) => {
                              event.stopPropagation()
                              setPanelMenuOpen((open) => !open)
                            }}
                          />
                          <Show when={panelMenuOpen()}>
                            <div
                              class="absolute left-0 top-9 z-[100] w-48 rounded-lg border border-border-base bg-background-stronger p-1 shadow-lg"
                              onClick={(event) => event.stopPropagation()}
                            >
                              <button
                                type="button"
                                class="flex h-8 w-full items-center rounded-md px-3 text-left text-13-regular text-text-base hover:bg-surface-base-hover"
                                onClick={showFilePicker}
                              >
                                Files
                              </button>
                              <PanelMenuButton tab={PANEL_TERMINAL_TAB} onSelect={() => openPanelTab(PANEL_TERMINAL_TAB)} />
                              <PanelMenuButton tab={PANEL_BROWSER_TAB} onSelect={() => openPanelTab(PANEL_BROWSER_TAB)} />
                              <PanelMenuButton tab={PANEL_OPEN_DESIGN_TAB} onSelect={launchOpenDesign} />
                              <PanelMenuButton tab={PANEL_MAC_VIEW_TAB} onSelect={() => openPanelTab(PANEL_MAC_VIEW_TAB)} />
                              <PanelMenuButton tab={PANEL_ACCOUNTS_TAB} onSelect={() => openPanelTab(PANEL_ACCOUNTS_TAB)} />
                              <PanelMenuButton tab={PANEL_RESOURCES_TAB} onSelect={() => openPanelTab(PANEL_RESOURCES_TAB)} />
                              <PanelMenuButton tab={PANEL_ARTIFACTS_TAB} onSelect={() => openPanelTab(PANEL_ARTIFACTS_TAB)} />
                              <PanelMenuButton tab={PANEL_FILE_BROWSER_TAB} onSelect={() => openPanelTab(PANEL_FILE_BROWSER_TAB)} />
                            </div>
                          </Show>
                        </div>
                      </Tabs.List>
                    </div>

                    <Show when={reviewTab() && props.canReview()}>
                      <Tabs.Content value="review" class="flex flex-col h-full overflow-hidden contain-strict">
                        <Show when={reviewOpen() && activeTab() === "review"}>{props.reviewPanel()}</Show>
                      </Tabs.Content>
                    </Show>

                    <Tabs.Content value="empty" class="flex flex-col h-full overflow-hidden contain-strict">
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
                      <Tabs.Content value="context" class="flex flex-col h-full overflow-hidden contain-strict">
                        <Show when={activeTab() === "context"}>
                          <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                            <SessionContextTab />
                          </div>
                        </Show>
                      </Tabs.Content>
                    </Show>

                    <Tabs.Content
                      value={PANEL_TERMINAL_TAB}
                      class="flex flex-col h-full overflow-hidden contain-strict"
                    >
                      <Show when={activePanelTab() === PANEL_TERMINAL_TAB}>
                        <SessionTerminalTab />
                      </Show>
                    </Tabs.Content>

                    <Tabs.Content value={PANEL_BROWSER_TAB} class="flex flex-col h-full overflow-hidden contain-strict">
                      <Show when={activePanelTab() === PANEL_BROWSER_TAB}>
                        <BrowserTabContent sessionID={params.id} launch={browserLaunch()} />
                      </Show>
                    </Tabs.Content>

                    <Tabs.Content
                      value={PANEL_OPEN_DESIGN_TAB}
                      class="flex flex-col h-full overflow-hidden contain-strict"
                    >
                      <Show when={activePanelTab() === PANEL_OPEN_DESIGN_TAB}>
                        <OpenDesignTabContent />
                      </Show>
                    </Tabs.Content>

                    <Tabs.Content value={PANEL_MAC_VIEW_TAB} class="flex flex-col h-full overflow-hidden contain-strict">
                      <Show when={activePanelTab() === PANEL_MAC_VIEW_TAB}>
                        <MacViewTabContent />
                      </Show>
                    </Tabs.Content>

                    <Tabs.Content value={PANEL_ACCOUNTS_TAB} class="flex flex-col h-full overflow-hidden contain-strict">
                      <Show when={activePanelTab() === PANEL_ACCOUNTS_TAB}>
                        <AccountsTabContent />
                      </Show>
                    </Tabs.Content>

                    <Tabs.Content value={PANEL_RESOURCES_TAB} class="flex flex-col h-full overflow-hidden contain-strict">
                      <Show when={activePanelTab() === PANEL_RESOURCES_TAB}>
                        <ResourcesTabContent />
                      </Show>
                    </Tabs.Content>

                    <Tabs.Content value={PANEL_ARTIFACTS_TAB} class="flex flex-col h-full overflow-hidden contain-strict">
                      <Show when={activePanelTab() === PANEL_ARTIFACTS_TAB}>
                        <ArtifactsTabContent sessionID={params.id} />
                      </Show>
                    </Tabs.Content>

                    <Tabs.Content
                      value={PANEL_FILE_BROWSER_TAB}
                      class="flex flex-col h-full overflow-hidden contain-strict"
                    >
                      <Show when={activePanelTab() === PANEL_FILE_BROWSER_TAB}>
                        <FileBrowserTabContent />
                      </Show>
                    </Tabs.Content>

                    <Tabs.Content value={PANEL_QUEUE_TAB} class="flex flex-col h-full overflow-hidden contain-strict">
                      <Show when={activePanelTab() === PANEL_QUEUE_TAB}>
                        <QueueTabContent sessionID={params.id} />
                      </Show>
                    </Tabs.Content>

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
  )
}
