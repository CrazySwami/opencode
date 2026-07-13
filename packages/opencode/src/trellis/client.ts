/**
 * TrellisRemoteClient — the read-only bridge to Mirror Factory's Trellis runtime.
 *
 * Design invariants (M0–M2):
 *  - READ-ONLY: only GETs; no method mutates anything.
 *  - FIXTURES-FIRST: when no Trellis URL is configured for the directory, every
 *    method returns deterministic fixture data marked `source: "fixture"`.
 *  - NEVER THROWS / CAN'T CORRUPT STATE: any network/timeout/HTTP-error/malformed
 *    response resolves to `{ ok: false, ... }`; malformed live JSON is validated
 *    and rejected (never partially applied).
 *  - ISOLATION: the base URL + token are resolved PER-DIRECTORY (Personal vs
 *    Mirror Factory never share a Trellis endpoint or credential), and the token
 *    is only ever used as an outgoing header — never returned to a caller.
 */
import type {
  TrellisAgent,
  TrellisHealth,
  TrellisReport,
  TrellisResult,
  TrellisRun,
  TrellisRunDetail,
} from "./types"
import { FIXTURE_AGENTS, FIXTURE_HEALTH, FIXTURE_REPORT, FIXTURE_RUNS, FIXTURE_RUN_DETAIL } from "./fixtures"

const TIMEOUT_MS = 3000

/** Resolve the Trellis base URL for a directory, or undefined → fixtures. */
function resolveTrellisUrl(directory?: string): string | undefined {
  const raw = process.env["OPENCODE_TRELLIS_URL_MAP"]
  if (raw && directory) {
    try {
      const map = JSON.parse(raw) as Record<string, unknown>
      const perDir = map[directory]
      if (typeof perDir === "string" && perDir.trim()) return perDir.trim()
    } catch {
      // malformed map → fall through to the global
    }
  }
  const global = process.env["OPENCODE_TRELLIS_URL"]?.trim()
  return global || undefined
}

function resolveTrellisToken(): string | undefined {
  return process.env["OPENCODE_TRELLIS_TOKEN"]?.trim() || undefined
}

/** True when a live Trellis endpoint is configured for this directory. */
export function trellisConfigured(directory?: string): boolean {
  return resolveTrellisUrl(directory) !== undefined
}

// --- minimal validators: return the typed value or throw (→ ok:false) ---------
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
function parseHealth(raw: unknown): TrellisHealth {
  const o = asObject(raw)
  return {
    status: str(o["status"]),
    version: strOrNull(o["version"]),
    runtime: strOrNull(o["runtime"]),
    checkedAt: typeof o["checkedAt"] === "string" ? (o["checkedAt"] as string) : new Date().toISOString(),
  }
}
function parseAgent(raw: unknown): TrellisAgent {
  const o = asObject(raw)
  return { id: str(o["id"]), name: str(o["name"]), role: strOrNull(o["role"]), status: strOrNull(o["status"]) }
}
function parseRun(raw: unknown): TrellisRun {
  const o = asObject(raw)
  return {
    id: str(o["id"]),
    agentId: str(o["agentId"]),
    title: str(o["title"]),
    status: str(o["status"]),
    startedAt: strOrNull(o["startedAt"]),
    finishedAt: strOrNull(o["finishedAt"]),
    linear: strOrNull(o["linear"]),
  }
}
function parseRunDetail(raw: unknown): TrellisRunDetail {
  const base = parseRun(raw)
  const o = asObject(raw)
  const steps = asArray(o["steps"] ?? []).map((s) => {
    const so = asObject(s)
    return { at: str(so["at"]), kind: str(so["kind"]), summary: str(so["summary"]) }
  })
  return { ...base, steps }
}
function parseReport(raw: unknown): TrellisReport {
  const o = asObject(raw)
  return {
    runId: str(o["runId"]),
    format: str(o["format"]),
    title: str(o["title"]),
    body: str(o["body"]),
    generatedAt: typeof o["generatedAt"] === "string" ? (o["generatedAt"] as string) : new Date().toISOString(),
  }
}

type Fetched =
  | { mode: "fixture" }
  | { mode: "live"; json: unknown }
  | { mode: "error"; error: string }

export class TrellisRemoteClient {
  constructor(private readonly directory?: string) {}

  private async fetchJson(path: string): Promise<Fetched> {
    const base = resolveTrellisUrl(this.directory)
    if (!base) return { mode: "fixture" }
    const token = resolveTrellisToken()
    try {
      const res = await fetch(`${base}${path}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: token ? { authorization: `Bearer ${token}` } : {},
      })
      if (res.status === 401 || res.status === 403) return { mode: "error", error: "trellis: not configured (auth rejected)" }
      if (!res.ok) return { mode: "error", error: `trellis error (${res.status})` }
      return { mode: "live", json: await res.json() }
    } catch {
      return { mode: "error", error: "trellis offline" }
    }
  }

  private async read<T>(
    path: string,
    fixture: () => TrellisResult<T>,
    parse: (json: unknown) => T,
  ): Promise<TrellisResult<T>> {
    const r = await this.fetchJson(path)
    if (r.mode === "fixture") return fixture()
    if (r.mode === "error") return { ok: false, source: "live", error: r.error }
    try {
      return { ok: true, source: "live", data: parse(r.json) }
    } catch {
      return { ok: false, source: "live", error: `trellis: malformed response for ${path}` }
    }
  }

  health(): Promise<TrellisResult<TrellisHealth>> {
    return this.read("/health", () => ({ ok: true, source: "fixture", data: FIXTURE_HEALTH }), parseHealth)
  }

  listAgents(): Promise<TrellisResult<TrellisAgent[]>> {
    return this.read(
      "/agents",
      () => ({ ok: true, source: "fixture", data: FIXTURE_AGENTS }),
      (json) => asArray(asObject(json)["agents"]).map(parseAgent),
    )
  }

  listRuns(): Promise<TrellisResult<TrellisRun[]>> {
    return this.read(
      "/runs",
      () => ({ ok: true, source: "fixture", data: FIXTURE_RUNS }),
      (json) => asArray(asObject(json)["runs"]).map(parseRun),
    )
  }

  getRun(id: string): Promise<TrellisResult<TrellisRunDetail>> {
    return this.read(
      `/runs/${encodeURIComponent(id)}`,
      () => {
        const run = FIXTURE_RUN_DETAIL[id]
        return run ? { ok: true, source: "fixture", data: run } : { ok: false, source: "fixture", error: `run not found: ${id}` }
      },
      (json) => parseRunDetail(asObject(json)["run"]),
    )
  }

  getReport(runId: string): Promise<TrellisResult<TrellisReport>> {
    return this.read(
      `/runs/${encodeURIComponent(runId)}/report`,
      () => {
        const report = FIXTURE_REPORT[runId]
        return report ? { ok: true, source: "fixture", data: report } : { ok: false, source: "fixture", error: `no report for run: ${runId}` }
      },
      (json) => parseReport(asObject(json)["report"]),
    )
  }
}
