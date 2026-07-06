// Live streaming for the OpenDesign chat mirror. Loads persisted history through
// the CT100 proxy, then attaches to the active run's SSE for token-level text
// deltas, falling back to 1.5s polling when there is no active run or the stream
// fails (so it degrades to the mirror's original behaviour rather than breaking).
//
// OD wire format (open-design/apps/web/src/providers/daemon.ts):
//   GET {proxy}/projects/:pid/conversations/:cid/messages -> { messages: ODMessage[] }
//   GET {proxy}/runs/:runId/events?after=:lastEventId       -> \n\n-framed SSE
//     frame fields: `id:` `event:` `data:` (data is JSON)
//     event types: stdout {chunk} | agent {..} | start | error | end {status}
// Read-only: never POST/mutate OD here.
import { createSignal, createEffect, on, onCleanup, type Accessor } from "solid-js"
import { OD_PROXY_BASE, type ODEvent, type ODMessage } from "./open-design-mirror-types"

export type ODStreamStatus = "idle" | "loading" | "live" | "error"

export type ODStreamHandle = {
  messages: Accessor<ODMessage[]>
  status: Accessor<ODStreamStatus>
  error: Accessor<string | undefined>
}

type SseFrame = { id?: string; event?: string; data?: Record<string, unknown> }

function parseSseFrame(frame: string): SseFrame | null {
  let id: string | undefined
  let event: string | undefined
  const dataLines: string[] = []
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue // heartbeat/comment
    if (line.startsWith("id:")) id = line.slice(3).trim()
    else if (line.startsWith("event:")) event = line.slice(6).trim()
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""))
  }
  if (!event && dataLines.length === 0 && !id) return null
  let data: Record<string, unknown> | undefined
  if (dataLines.length) {
    try {
      const parsed = JSON.parse(dataLines.join("\n"))
      if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>
    } catch {
      /* keep undefined — a partial/non-JSON frame is skipped */
    }
  }
  return { id, event, data }
}

// Best-effort map of an OD `event: agent` payload onto an ODEvent for live
// display. The 1.5s reconciling poll is the source of truth for final events, so
// an unrecognised payload is simply dropped from the live view.
function mapAgentEvent(data: Record<string, unknown> | undefined): ODEvent | null {
  if (!data || typeof data !== "object") return null
  const kind = typeof data.kind === "string" ? data.kind : undefined
  if (!kind) return null
  switch (kind) {
    case "text":
      return { kind: "text", text: String(data.text ?? "") }
    case "thinking":
      return { kind: "thinking", text: String(data.text ?? "") }
    case "status":
      return { kind: "status", label: String(data.label ?? ""), detail: data.detail ? String(data.detail) : undefined }
    case "tool_use":
      return { kind: "tool_use", id: String(data.id ?? ""), name: String(data.name ?? ""), input: data.input }
    case "tool_result":
      return {
        kind: "tool_result",
        toolUseId: String(data.toolUseId ?? ""),
        content: String(data.content ?? ""),
        isError: data.isError === true,
      }
    case "image":
    case "file":
    case "live_artifact":
    case "live_artifact_refresh":
    case "raw":
      return { ...(data as Record<string, unknown>), kind } as ODEvent
    default:
      return null
  }
}

const ACTIVE = new Set(["queued", "running"])

function activeRun(list: ODMessage[]): ODMessage | undefined {
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (m.role === "assistant" && m.runId && m.runStatus && ACTIVE.has(m.runStatus)) return m
  }
  return undefined
}

export function createOpenDesignStream(opts: {
  projectId: Accessor<string | undefined>
  conversationId: Accessor<string | undefined>
  enabled: Accessor<boolean>
}): ODStreamHandle {
  const [messages, setMessages] = createSignal<ODMessage[]>([])
  const [status, setStatus] = createSignal<ODStreamStatus>("idle")
  const [error, setError] = createSignal<string | undefined>(undefined)

  createEffect(
    on([opts.enabled, opts.projectId, opts.conversationId], ([enabled, pid, cid]) => {
      if (!enabled || !pid || !cid) {
        setMessages([])
        setStatus("idle")
        setError(undefined)
        return
      }

      let disposed = false
      let pollTimer = 0
      const controllers = new Set<AbortController>()
      const base = `${OD_PROXY_BASE}/projects/${encodeURIComponent(pid)}/conversations/${encodeURIComponent(cid)}/messages`

      const cleanup = () => {
        disposed = true
        window.clearTimeout(pollTimer)
        for (const c of controllers) c.abort()
        controllers.clear()
      }

      const fetchMessages = async (): Promise<ODMessage[] | null> => {
        const ctrl = new AbortController()
        controllers.add(ctrl)
        const to = window.setTimeout(() => ctrl.abort(), 6000)
        try {
          const res = await fetch(base, { signal: ctrl.signal })
          if (!res.ok) return null
          const json = (await res.json()) as { messages?: ODMessage[] }
          return Array.isArray(json.messages) ? json.messages : []
        } catch {
          return null
        } finally {
          window.clearTimeout(to)
          controllers.delete(ctrl)
        }
      }

      // Mutate the active assistant message (matched by runId) in place.
      const patchRun = (runId: string, fn: (m: ODMessage) => ODMessage) => {
        setMessages((prev) => prev.map((m) => (m.runId === runId ? fn(m) : m)))
      }
      const appendText = (runId: string, chunk: string) => {
        if (!chunk) return
        patchRun(runId, (m) => ({ ...m, content: (m.content ?? "") + chunk }))
      }
      const addEvent = (runId: string, ev: ODEvent) => {
        patchRun(runId, (m) => ({ ...m, events: [...(m.events ?? []), ev] }))
      }
      const setRunStatus = (runId: string, s: unknown) => {
        const next = typeof s === "string" ? s : "succeeded"
        patchRun(runId, (m) => ({ ...m, runStatus: next as ODMessage["runStatus"] }))
      }

      // Stream one run to completion (or stream close). Resolves when the run
      // ends or the SSE cannot continue; the caller then re-polls.
      const streamRun = async (msg: ODMessage): Promise<void> => {
        const runId = msg.runId as string
        let lastId = msg.lastRunEventId ?? null
        for (let reconnects = 0; reconnects < 5 && !disposed; reconnects++) {
          const ctrl = new AbortController()
          controllers.add(ctrl)
          let ended = false
          try {
            const qs = lastId ? `?after=${encodeURIComponent(lastId)}` : ""
            const res = await fetch(`${OD_PROXY_BASE}/runs/${encodeURIComponent(runId)}/events${qs}`, {
              signal: ctrl.signal,
            })
            if (!res.ok || !res.body) return // fall back to poll
            const reader = res.body.getReader()
            const decoder = new TextDecoder()
            let buf = ""
            while (!disposed) {
              const { value, done } = await reader.read()
              if (done) break
              buf += decoder.decode(value, { stream: true })
              let idx: number
              while ((idx = buf.indexOf("\n\n")) !== -1) {
                const frame = buf.slice(0, idx)
                buf = buf.slice(idx + 2)
                const parsed = parseSseFrame(frame)
                if (!parsed) continue
                if (parsed.id) lastId = parsed.id
                switch (parsed.event) {
                  case "stdout":
                    appendText(runId, String(parsed.data?.chunk ?? ""))
                    break
                  case "agent": {
                    const ev = mapAgentEvent(parsed.data)
                    if (ev) addEvent(runId, ev)
                    break
                  }
                  case "start":
                    setRunStatus(runId, "running")
                    break
                  case "error":
                    addEvent(runId, {
                      kind: "status",
                      label: "error",
                      detail: parsed.data?.message ? String(parsed.data.message) : undefined,
                    })
                    break
                  case "end":
                    setRunStatus(runId, parsed.data?.status)
                    ended = true
                    break
                  default:
                    break
                }
              }
              if (ended) break
            }
          } catch (err) {
            if ((err as Error)?.name === "AbortError") return
            // network hiccup — reconnect with ?after=lastId
          } finally {
            controllers.delete(ctrl)
          }
          if (ended || disposed) return
        }
      }

      const loop = async () => {
        if (disposed) return
        const list = await fetchMessages()
        if (disposed) return
        if (list === null) {
          setError("Open Design daemon unreachable")
          if (messages().length === 0) setStatus("error")
          pollTimer = window.setTimeout(loop, 1500)
          return
        }
        setMessages(list)
        setError(undefined)
        setStatus("live")
        const run = activeRun(list)
        if (run) {
          await streamRun(run)
          if (!disposed) pollTimer = window.setTimeout(loop, 300)
        } else if (!disposed) {
          pollTimer = window.setTimeout(loop, 1500)
        }
      }

      setStatus("loading")
      void loop()
      onCleanup(cleanup)
    }),
  )

  return { messages, status, error }
}
