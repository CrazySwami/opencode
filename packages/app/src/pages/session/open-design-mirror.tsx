import { createSignal, createMemo, createEffect, onCleanup, onMount, Show, For, Switch, Match } from "solid-js"
import { Portal } from "solid-js/web"

// Phase 1 of the OpenDesign chat MIRROR. When the composer is bridged to an
// Open Design project, this overlays the left message region and renders OD's
// live conversation (read-only) — text, thinking, and status events — so the
// user sees Open Design's side (responses, questions-as-text, progress) inside
// their OpenCode session. Interactive tool_use/tool_result cards are Phase 2.

const OPEN_DESIGN_BRIDGE_EVENT = "opencode:open-design-bridge-state"

type BridgeState = {
  active?: boolean
  acceptsPrompts?: boolean
  projectId?: string
  projectName?: string
  activeConversationId?: string | null
  conversations?: { id: string; title?: string | null }[]
  chatId?: string | null
  chatName?: string | null
} | undefined

// Subset of OD's PersistedAgentEvent (packages/contracts/src/api/chat.ts).
type ODEvent =
  | { kind: "status"; label: string; detail?: string }
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; id: string; name: string; input?: unknown }
  | { kind: "tool_result"; toolUseId: string; content: string; isError?: boolean }
  | { kind: "usage"; inputTokens?: number; outputTokens?: number; costUsd?: number; durationMs?: number }
  | { kind: "image" | "file" | "live_artifact" | "live_artifact_refresh" | "raw"; [k: string]: unknown }

type ODMessage = {
  id: string
  role: "user" | "assistant"
  content: string
  agentName?: string
  events?: ODEvent[]
  runStatus?: "queued" | "running" | "succeeded" | "failed" | "canceled"
  createdAt?: number
}

type LoadState = "idle" | "loading" | "ready" | "error"

const OD_ACCENT = "#f97316"

// Find the left message-timeline scroll region to anchor the overlay over. The
// composer is a reliable left-column marker; the timeline is the [data-scrollable]
// whose horizontal span matches the composer and sits above it.
function findLeftTimelineRect(): DOMRect | null {
  if (typeof document === "undefined") return null
  const composer = document.querySelector(
    '[data-component="session-composer"], [data-component="session-new-composer"]',
  ) as HTMLElement | null
  if (!composer) return null
  const c = composer.getBoundingClientRect()
  if (c.width === 0) return null
  const scrollables = Array.from(document.querySelectorAll(".scroll-view__viewport")) as HTMLElement[]
  let best: DOMRect | null = null
  for (const el of scrollables) {
    // Never anchor to the mirror's own scroll body.
    if (el.closest('[data-component="open-design-mirror"]')) continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    const centerX = r.left + r.width / 2
    const withinColumn = centerX >= c.left - 8 && centerX <= c.right + 8
    const aboveComposer = r.top < c.top + 4
    if (withinColumn && aboveComposer) {
      if (!best || r.height > best.height) best = r
    }
  }
  if (best) return best
  // Fallback: cover the column from its top down to the composer.
  const column = composer.offsetParent as HTMLElement | null
  const top = column ? column.getBoundingClientRect().top : 0
  return new DOMRect(c.left, top, c.width, Math.max(0, c.top - top))
}

export function OpenDesignMirror() {
  const [bridge, setBridge] = createSignal<BridgeState>(undefined)
  const [messages, setMessages] = createSignal<ODMessage[]>([])
  const [loadState, setLoadState] = createSignal<LoadState>("idle")
  const [errorNote, setErrorNote] = createSignal<string | undefined>(undefined)
  const [rect, setRect] = createSignal<DOMRect | null>(null)
  const [collapsed, setCollapsed] = createSignal(false)

  onMount(() => {
    const onBridge = (event: Event) => {
      const detail = event instanceof CustomEvent ? (event.detail as BridgeState) : undefined
      setBridge(detail && typeof detail === "object" && detail.active ? detail : undefined)
    }
    window.addEventListener(OPEN_DESIGN_BRIDGE_EVENT, onBridge as EventListener)
    onCleanup(() => window.removeEventListener(OPEN_DESIGN_BRIDGE_EVENT, onBridge as EventListener))
  })

  const projectId = createMemo(() => bridge()?.projectId)
  const conversationId = createMemo(() => bridge()?.activeConversationId ?? bridge()?.chatId ?? bridge()?.conversations?.[0]?.id ?? undefined)
  const projectName = createMemo(() => bridge()?.projectName ?? "Open Design")
  const chatName = createMemo(() => bridge()?.chatName ?? undefined)
  const shouldShow = createMemo(() => !!bridge()?.active && !!projectId())
  // Resolve the conversation to mirror: prefer the bridge's, else fetch the
  // project's most-recent conversation via the proxy (fresh projects have no
  // conversation in the bridge for a moment).
  const [resolvedCid, setResolvedCid] = createSignal<string | undefined>(undefined)
  createEffect(() => {
    const pid = projectId()
    const known = conversationId()
    if (!shouldShow() || !pid) {
      setResolvedCid(undefined)
      return
    }
    if (known) {
      setResolvedCid(known)
      return
    }
    let stop = false
    ;(async () => {
      try {
        const res = await fetch(`/experimental/open-design/proxy/api/projects/${encodeURIComponent(pid)}/conversations`)
        if (!res.ok) return
        const json = (await res.json()) as { conversations?: { id: string; updatedAt?: number }[] }
        const list = Array.isArray(json?.conversations) ? json.conversations : []
        if (stop || list.length === 0) return
        const latest = [...list].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]
        setResolvedCid(latest?.id)
      } catch {
        /* transient; the poll effect stays idle until resolved */
      }
    })()
    onCleanup(() => {
      stop = true
    })
  })

  // Keep the overlay aligned to the left message region while shown.
  createEffect(() => {
    if (!shouldShow() || collapsed()) {
      setRect(null)
      return
    }
    let raf = 0
    let stop = false
    const tick = () => {
      if (stop) return
      const next = findLeftTimelineRect()
      const prev = rect()
      if (
        next &&
        (!prev ||
          Math.abs(next.left - prev.left) > 0.5 ||
          Math.abs(next.top - prev.top) > 0.5 ||
          Math.abs(next.width - prev.width) > 0.5 ||
          Math.abs(next.height - prev.height) > 0.5)
      ) {
        setRect(next)
      }
      raf = window.setTimeout(tick, 250) as unknown as number
    }
    tick()
    const onResize = () => tick()
    window.addEventListener("resize", onResize)
    onCleanup(() => {
      stop = true
      window.clearTimeout(raf)
      window.removeEventListener("resize", onResize)
    })
  })

  // Poll OD's persisted conversation (read-only) through the CT100 proxy.
  createEffect(() => {
    const pid = projectId()
    const cid = resolvedCid()
    if (!shouldShow() || !pid || !cid) {
      setMessages([])
      setLoadState("idle")
      return
    }
    let stop = false
    let timer = 0
    const url = `/experimental/open-design/proxy/api/projects/${encodeURIComponent(pid)}/conversations/${encodeURIComponent(cid)}/messages`
    const poll = async () => {
      if (stop) return
      if (loadState() === "idle") setLoadState("loading")
      try {
        const controller = new AbortController()
        const to = window.setTimeout(() => controller.abort(), 6000)
        const res = await fetch(url, { signal: controller.signal })
        window.clearTimeout(to)
        if (!res.ok) throw new Error(`daemon ${res.status}`)
        const json = (await res.json()) as { messages?: ODMessage[] }
        if (!stop) {
          setMessages(Array.isArray(json.messages) ? json.messages : [])
          setLoadState("ready")
          setErrorNote(undefined)
        }
      } catch (err) {
        if (!stop) {
          setErrorNote(err instanceof Error ? err.message : "unreachable")
          // Keep the last good transcript; only flip to error if we have nothing.
          if (messages().length === 0) setLoadState("error")
        }
      }
      if (!stop) timer = window.setTimeout(poll, 1500) as unknown as number
    }
    poll()
    onCleanup(() => {
      stop = true
      window.clearTimeout(timer)
    })
  })

  const eventsFor = (m: ODMessage): ODEvent[] => {
    const evts = Array.isArray(m.events) ? m.events : []
    // Phase 1 renders text / thinking / status. Fall back to content when the
    // message has no text event (older/user messages).
    const hasText = evts.some((e) => e.kind === "text")
    if (!hasText && m.content) return [...evts, { kind: "text", text: m.content }]
    return evts
  }

  const running = createMemo(() => messages().some((m) => m.runStatus === "running" || m.runStatus === "queued"))

  return (
    <Show when={shouldShow()}>
      <Show
        when={!collapsed()}
        fallback={
          <Portal>
            <button
              type="button"
              data-component="open-design-mirror-reopen"
              class="fixed bottom-28 left-4 z-[60] flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] shadow-lg backdrop-blur"
              style={{
                "border-color": `${OD_ACCENT}55`,
                background: `${OD_ACCENT}1a`,
                color: OD_ACCENT,
              }}
              onClick={() => setCollapsed(false)}
              title="Show the Open Design conversation"
            >
              <span class="inline-flex size-[15px] items-center justify-center rounded bg-[#f97316]/20 text-[7px] font-semibold">
                OD
              </span>
              Show OD chat
            </button>
          </Portal>
        }
      >
        <Show when={rect()}>
          {(r) => (
            <Portal>
              <div
                data-component="open-design-mirror"
                class="fixed z-[55] flex flex-col overflow-hidden rounded-[10px] border bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]"
                style={{
                  left: `${r().left}px`,
                  top: `${r().top}px`,
                  width: `${r().width}px`,
                  height: `${r().height}px`,
                  "border-color": `${OD_ACCENT}40`,
                  "box-shadow": `0 0 0 1px ${OD_ACCENT}22, var(--v2-elevation-raised)`,
                }}
              >
                {/* header */}
                <div
                  class="flex shrink-0 items-center gap-2 border-b px-3 py-2 text-[12px]"
                  style={{ "border-color": `${OD_ACCENT}22` }}
                >
                  <span class="inline-flex size-[16px] items-center justify-center rounded bg-[#f97316]/15 text-[7px] font-semibold text-[#f97316]">
                    OD
                  </span>
                  <span class="font-[560] text-v2-text-text-base">Open Design</span>
                  <span class="text-v2-text-text-faint">/</span>
                  <span class="min-w-0 truncate text-v2-text-text-muted">{chatName() ?? projectName()}</span>
                  <Show when={running()}>
                    <span class="ml-1 inline-flex items-center gap-1 rounded-full bg-[#f97316]/10 px-1.5 py-0.5 text-[10px] text-[#f97316]">
                      <span class="size-1.5 animate-pulse rounded-full bg-[#f97316]" />
                      live
                    </span>
                  </Show>
                  <div class="ml-auto flex items-center gap-1">
                    <Show when={errorNote() && loadState() !== "error"}>
                      <span class="text-[10px] text-v2-text-text-faint" title={`Reconnecting — ${errorNote()}`}>
                        reconnecting…
                      </span>
                    </Show>
                    <button
                      type="button"
                      data-component="open-design-mirror-hide"
                      class="rounded px-1.5 py-0.5 text-[11px] text-v2-text-text-muted transition-colors hover:bg-v2-background-bg-layer-02 hover:text-v2-text-text-base"
                      onClick={() => setCollapsed(true)}
                      title="Hide the Open Design conversation"
                    >
                      Hide
                    </button>
                  </div>
                </div>

                {/* body */}
                <div class="min-h-0 flex-1 overflow-y-auto px-3 py-3">
                  <Switch>
                    <Match when={loadState() === "loading" && messages().length === 0}>
                      <div class="flex h-full items-center justify-center text-[12px] text-v2-text-text-faint">
                        Loading the Open Design conversation…
                      </div>
                    </Match>
                    <Match when={loadState() === "error" && messages().length === 0}>
                      <div class="flex h-full flex-col items-center justify-center gap-1 text-center text-[12px] text-v2-text-text-faint">
                        <span>Couldn’t reach Open Design ({errorNote()}).</span>
                        <span class="text-[11px]">Retrying automatically…</span>
                      </div>
                    </Match>
                    <Match when={messages().length === 0}>
                      <div class="flex h-full items-center justify-center text-[12px] text-v2-text-text-faint">
                        No messages yet — send a prompt to start the Open Design chat.
                      </div>
                    </Match>
                    <Match when={messages().length > 0}>
                      <div class="flex flex-col gap-4">
                        <For each={messages()}>
                          {(m) => (
                            <Switch>
                              <Match when={m.role === "user"}>
                                <div class="flex justify-end">
                                  <div class="max-w-[85%] whitespace-pre-wrap break-words rounded-lg bg-v2-background-bg-layer-02 px-3 py-2 text-[13px] leading-5 text-v2-text-text-base">
                                    {m.content}
                                  </div>
                                </div>
                              </Match>
                              <Match when={m.role === "assistant"}>
                                <div class="flex flex-col gap-1.5">
                                  <div class="flex items-center gap-1.5 text-[11px] text-v2-text-text-faint">
                                    <span class="inline-flex size-[13px] items-center justify-center rounded bg-[#f97316]/15 text-[6px] font-semibold text-[#f97316]">
                                      OD
                                    </span>
                                    <span>{m.agentName ?? "Open Design"}</span>
                                    <Show when={m.runStatus === "running" || m.runStatus === "queued"}>
                                      <span class="size-1.5 animate-pulse rounded-full bg-[#f97316]" />
                                    </Show>
                                    <Show when={m.runStatus === "failed"}>
                                      <span class="text-red-400">failed</span>
                                    </Show>
                                  </div>
                                  <div class="flex flex-col gap-1.5">
                                    <For each={eventsFor(m)}>
                                      {(ev) => (
                                        <Switch>
                                          <Match when={ev.kind === "text"}>
                                            <div class="whitespace-pre-wrap break-words text-[13px] leading-5 text-v2-text-text-base">
                                              {(ev as { text: string }).text}
                                            </div>
                                          </Match>
                                          <Match when={ev.kind === "thinking"}>
                                            <details class="rounded-md bg-v2-background-bg-layer-02/60 px-2 py-1">
                                              <summary class="cursor-pointer list-none text-[11px] text-v2-text-text-faint [&::-webkit-details-marker]:hidden">
                                                💭 Thinking
                                              </summary>
                                              <div class="mt-1 whitespace-pre-wrap break-words text-[12px] leading-5 text-v2-text-text-muted">
                                                {(ev as { text: string }).text}
                                              </div>
                                            </details>
                                          </Match>
                                          <Match when={ev.kind === "status"}>
                                            <div class="flex items-center gap-1.5 text-[11px] text-v2-text-text-faint">
                                              <span class="rounded bg-v2-background-bg-layer-02 px-1.5 py-0.5">
                                                {(ev as { label: string }).label}
                                              </span>
                                              <Show when={(ev as { detail?: string }).detail}>
                                                <span class="truncate">{(ev as { detail?: string }).detail}</span>
                                              </Show>
                                            </div>
                                          </Match>
                                          {/* Phase 2 renders tool_use / tool_result / image / live_artifact. */}
                                          <Match when={ev.kind === "tool_use" || ev.kind === "tool_result"}>
                                            <div class="rounded-md border border-dashed border-v2-border-border-base px-2 py-1 text-[11px] text-v2-text-text-faint">
                                              {ev.kind === "tool_use"
                                                ? `▸ ${(ev as { name?: string }).name ?? "tool"}`
                                                : "▸ result"}
                                            </div>
                                          </Match>
                                        </Switch>
                                      )}
                                    </For>
                                  </div>
                                </div>
                              </Match>
                            </Switch>
                          )}
                        </For>
                      </div>
                    </Match>
                  </Switch>
                </div>
              </div>
            </Portal>
          )}
        </Show>
      </Show>
    </Show>
  )
}
