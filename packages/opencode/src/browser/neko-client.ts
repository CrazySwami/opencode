/**
 * NekoClient — drives the shared neko Chromium over the Chrome DevTools Protocol.
 *
 * Two real CDP-behind-a-proxy gotchas are handled here (see deploy/browser-stack):
 *  1. Chromium reports `ws://127.0.0.1:9222/...` in /json/list even when reached
 *     through the socat sidecar → we rewrite the host to the reachable CDP base.
 *  2. The DevTools HTTP endpoint rejects a non-localhost `Host` header (DNS-rebind
 *     protection) → we send `Host: localhost` on every CDP HTTP call.
 *
 * Invariants: never throws (→ {ok:false}); the neko member password is never sent
 * to the CDP endpoint nor returned to a caller; URL resolves per-directory.
 */
import type { BrowserResult, NekoHealth, NekoTarget } from "./types"

const HTTP_TIMEOUT_MS = 5000
const WS_TIMEOUT_MS = 8000

function resolveNekoCdpUrl(directory?: string): string | undefined {
  const raw = process.env["OPENCODE_NEKO_CDP_URL_MAP"]
  if (raw && directory) {
    try {
      const map = JSON.parse(raw) as Record<string, unknown>
      const perDir = map[directory]
      if (typeof perDir === "string" && perDir.trim()) return perDir.trim()
    } catch {
      // malformed map → fall through to the global
    }
  }
  return process.env["OPENCODE_NEKO_CDP_URL"]?.trim().replace(/\/+$/, "") || undefined
}

/** The WebRTC viewer URL for embedding; never carries the member password. */
export function resolveNekoViewerUrl(directory?: string): string | undefined {
  return process.env["OPENCODE_NEKO_URL"]?.trim().replace(/\/+$/, "") || undefined
}

export function nekoConfigured(directory?: string): boolean {
  return resolveNekoCdpUrl(directory) !== undefined
}

/**
 * Rewrite a devtools-reported URL's host to the reachable CDP base. Chromium
 * always reports 127.0.0.1:9222; through the proxy we must talk to the base host.
 * Exported for unit testing.
 */
export function rewriteCdpHost(reported: string, cdpBase: string): string {
  try {
    const base = new URL(cdpBase)
    const url = new URL(reported)
    url.host = base.host
    if (url.protocol === "ws:" || url.protocol === "wss:") {
      url.protocol = base.protocol === "https:" ? "wss:" : "ws:"
    } else {
      url.protocol = base.protocol
    }
    return url.toString()
  } catch {
    return reported
  }
}

function str(v: unknown): string {
  if (typeof v !== "string") throw new Error("expected string")
  return v
}
function strOrNull(v: unknown): string | null {
  return v == null ? null : str(v)
}
function asObject(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("expected object")
  return v as Record<string, unknown>
}
function asArray(v: unknown): unknown[] {
  if (!Array.isArray(v)) throw new Error("expected array")
  return v
}

function parseTarget(raw: unknown, cdpBase: string): NekoTarget {
  const o = asObject(raw)
  const ws = o["webSocketDebuggerUrl"]
  return {
    id: str(o["id"]),
    type: typeof o["type"] === "string" ? (o["type"] as string) : "other",
    title: typeof o["title"] === "string" ? (o["title"] as string) : "",
    url: typeof o["url"] === "string" ? (o["url"] as string) : "",
    webSocketDebuggerUrl: typeof ws === "string" ? rewriteCdpHost(ws, cdpBase) : null,
  }
}

/** Single-shot CDP command over a devtools websocket. Never leaks; times out. */
async function cdpCommand(
  wsUrl: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    let settled = false
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        ws.close()
      } catch {}
      reject(new Error("cdp timeout"))
    }, WS_TIMEOUT_MS)
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch {}
      fn()
    }
    ws.addEventListener("open", () => ws.send(JSON.stringify({ id: 1, method, params })))
    ws.addEventListener("message", (ev: MessageEvent) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(String(ev.data)) as Record<string, unknown>
      } catch {
        return
      }
      if (msg["id"] !== 1) return
      const error = msg["error"] as { message?: string } | undefined
      if (error) finish(() => reject(new Error(error.message ?? "cdp error")))
      else finish(() => resolve((msg["result"] as Record<string, unknown>) ?? {}))
    })
    ws.addEventListener("error", () => finish(() => reject(new Error("cdp ws error"))))
  })
}

export class NekoClient {
  constructor(private readonly directory?: string) {}

  private async cdpHttp(path: string): Promise<unknown> {
    const base = resolveNekoCdpUrl(this.directory)
    if (!base) throw new Error("not configured")
    const res = await fetch(`${base}${path}`, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      headers: { Host: "localhost" }, // DevTools rejects non-localhost Host
    })
    if (!res.ok) throw new Error(`cdp ${res.status}`)
    return res.json()
  }

  async health(): Promise<BrowserResult<NekoHealth>> {
    const base = resolveNekoCdpUrl(this.directory)
    if (!base) return { ok: false, error: "neko: OPENCODE_NEKO_CDP_URL not configured" }
    try {
      const v = asObject(await this.cdpHttp("/json/version"))
      return {
        ok: true,
        data: {
          browser: typeof v["Browser"] === "string" ? (v["Browser"] as string) : "unknown",
          protocolVersion: strOrNull(v["Protocol-Version"]),
          viewerConfigured: Boolean(resolveNekoViewerUrl(this.directory)),
          cdpUrl: base,
        },
      }
    } catch {
      return { ok: false, error: "neko: CDP offline" }
    }
  }

  async listTargets(): Promise<BrowserResult<NekoTarget[]>> {
    const base = resolveNekoCdpUrl(this.directory)
    if (!base) return { ok: false, error: "neko: not configured" }
    try {
      const arr = asArray(await this.cdpHttp("/json/list"))
      return { ok: true, data: arr.map((t) => parseTarget(t, base)) }
    } catch {
      return { ok: false, error: "neko: CDP offline or malformed target list" }
    }
  }

  private async firstPageWs(): Promise<BrowserResult<string>> {
    const targets = await this.listTargets()
    if (!targets.ok) return targets
    const page = targets.data.find((t) => t.type === "page" && t.webSocketDebuggerUrl)
    if (!page?.webSocketDebuggerUrl) return { ok: false, error: "neko: no page target available" }
    return { ok: true, data: page.webSocketDebuggerUrl }
  }

  /** Navigate the shared browser's active page. */
  async navigate(url: string): Promise<BrowserResult<{ url: string }>> {
    const ws = await this.firstPageWs()
    if (!ws.ok) return ws
    try {
      await cdpCommand(ws.data, "Page.navigate", { url })
      return { ok: true, data: { url } }
    } catch {
      return { ok: false, error: "neko: navigate failed" }
    }
  }

  /** Capture a PNG of the shared browser (base64, no data: prefix). */
  async screenshot(): Promise<BrowserResult<{ base64: string }>> {
    const ws = await this.firstPageWs()
    if (!ws.ok) return ws
    try {
      const result = await cdpCommand(ws.data, "Page.captureScreenshot", { format: "png" })
      const data = result["data"]
      if (typeof data !== "string") return { ok: false, error: "neko: screenshot returned no image" }
      return { ok: true, data: { base64: data } }
    } catch {
      return { ok: false, error: "neko: screenshot failed" }
    }
  }

  /** Evaluate an expression in the active page; returns the by-value result. */
  async evaluate(expression: string): Promise<BrowserResult<{ value: unknown }>> {
    const ws = await this.firstPageWs()
    if (!ws.ok) return ws
    try {
      const result = asObject(await cdpCommand(ws.data, "Runtime.evaluate", { expression, returnByValue: true }))
      const inner = result["result"] as { value?: unknown } | undefined
      return { ok: true, data: { value: inner?.value } }
    } catch {
      return { ok: false, error: "neko: evaluate failed" }
    }
  }
}
