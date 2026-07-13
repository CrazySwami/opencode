/**
 * SteelClient — the headless/isolated automation lane. Wraps steel-browser's
 * session REST API so the agent can spin up disposable browsers that don't touch
 * the shared neko view.
 *
 * Steel is beta and its routes move — endpoints here (`/v1/sessions`, `/health`)
 * are the current shape; verify against the pinned steel-browser tag. Invariants:
 * never throws (→ {ok:false}); the API token is sent as a header only, never
 * returned to a caller; URL resolves per-directory.
 */
import type { BrowserResult, SteelHealth, SteelSession } from "./types"

const TIMEOUT_MS = 8000

function resolveSteelUrl(directory?: string): string | undefined {
  const raw = process.env["OPENCODE_STEEL_URL_MAP"]
  if (raw && directory) {
    try {
      const map = JSON.parse(raw) as Record<string, unknown>
      const perDir = map[directory]
      if (typeof perDir === "string" && perDir.trim()) return perDir.trim().replace(/\/+$/, "")
    } catch {
      // malformed map → fall through to the global
    }
  }
  return process.env["OPENCODE_STEEL_URL"]?.trim().replace(/\/+$/, "") || undefined
}

function resolveSteelViewerUrl(): string | undefined {
  return process.env["OPENCODE_STEEL_VIEWER_URL"]?.trim().replace(/\/+$/, "") || undefined
}

function resolveSteelToken(): string | undefined {
  return process.env["OPENCODE_STEEL_TOKEN"]?.trim() || undefined
}

export function steelConfigured(directory?: string): boolean {
  return resolveSteelUrl(directory) !== undefined
}

function str(v: unknown): string {
  if (typeof v !== "string") throw new Error("expected string")
  return v
}
function strOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null
}
function asObject(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("expected object")
  return v as Record<string, unknown>
}
function asArray(v: unknown): unknown[] {
  if (!Array.isArray(v)) throw new Error("expected array")
  return v
}

function parseSession(raw: unknown): SteelSession {
  const o = asObject(raw)
  return {
    id: str(o["id"]),
    status: strOrNull(o["status"]),
    websocketUrl: strOrNull(o["websocketUrl"] ?? o["connectUrl"] ?? o["cdpUrl"]),
    sessionViewerUrl: strOrNull(o["sessionViewerUrl"] ?? o["debugUrl"]),
  }
}

export class SteelClient {
  constructor(private readonly directory?: string) {}

  private async request(
    path: string,
    options: { method?: "GET" | "POST"; body?: Record<string, unknown> } = {},
  ): Promise<unknown> {
    const base = resolveSteelUrl(this.directory)
    if (!base) throw new Error("not configured")
    const token = resolveSteelToken()
    const headers: Record<string, string> = {}
    if (options.body) headers["content-type"] = "application/json"
    if (token) headers["steel-api-key"] = token // sent, never echoed back to a caller
    const res = await fetch(`${base}${path}`, {
      method: options.method ?? "GET",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    })
    if (res.status === 401 || res.status === 403) throw new Error("auth")
    if (!res.ok) throw new Error(`steel ${res.status}`)
    const text = await res.text()
    return text ? JSON.parse(text) : {}
  }

  async health(): Promise<BrowserResult<SteelHealth>> {
    const base = resolveSteelUrl(this.directory)
    if (!base) return { ok: false, error: "steel: OPENCODE_STEEL_URL not configured" }
    try {
      await this.request("/health")
      return { ok: true, data: { ok: true, apiUrl: base, viewerUrl: resolveSteelViewerUrl() ?? null } }
    } catch (e) {
      const msg = e instanceof Error && e.message === "auth" ? "steel: auth rejected" : "steel: offline"
      return { ok: false, error: msg }
    }
  }

  async listSessions(): Promise<BrowserResult<SteelSession[]>> {
    try {
      const json = await this.request("/v1/sessions")
      const arr = Array.isArray(json) ? json : asArray(asObject(json)["sessions"] ?? [])
      return { ok: true, data: arr.map(parseSession) }
    } catch {
      return { ok: false, error: "steel: offline or malformed session list" }
    }
  }

  async createSession(opts: { url?: string } = {}): Promise<BrowserResult<SteelSession>> {
    try {
      const json = await this.request("/v1/sessions", { method: "POST", body: { ...(opts.url ? { url: opts.url } : {}) } })
      return { ok: true, data: parseSession(json) }
    } catch {
      return { ok: false, error: "steel: failed to create session" }
    }
  }

  async getSession(id: string): Promise<BrowserResult<SteelSession>> {
    try {
      const json = await this.request(`/v1/sessions/${encodeURIComponent(id)}`)
      return { ok: true, data: parseSession(json) }
    } catch {
      return { ok: false, error: `steel: session unavailable: ${id}` }
    }
  }

  async releaseSession(id: string): Promise<BrowserResult<{ id: string }>> {
    try {
      await this.request(`/v1/sessions/${encodeURIComponent(id)}/release`, { method: "POST", body: {} })
      return { ok: true, data: { id } }
    } catch {
      return { ok: false, error: `steel: failed to release session: ${id}` }
    }
  }
}
