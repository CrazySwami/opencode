/**
 * ReportsRemoteClient — the read-only bridge to the personal daily reports feed.
 *
 * Design invariants (mirroring the Trellis bridge):
 *  - READ-ONLY: only GETs; no method mutates anything.
 *  - FIXTURES-FIRST: when no reports URL is configured for the directory, every
 *    method returns deterministic fixture data marked `source: "fixture"`.
 *  - NEVER THROWS / CAN'T CORRUPT STATE: any network/timeout/HTTP-error/malformed
 *    response resolves to `{ ok: false, ... }`; malformed live JSON is validated
 *    and rejected (never partially applied).
 *  - ISOLATION: the base URL + token are resolved PER-DIRECTORY, and the token
 *    is only ever used as an outgoing header — never returned to a caller.
 */
import type { DailyReport, ReportResult, ReportsHealth } from "./types"
import { FIXTURE_HEALTH, FIXTURE_REPORTS, FIXTURE_REPORT_BY_ID } from "./fixtures"

const TIMEOUT_MS = 3000

/** Resolve the reports base URL for a directory, or undefined → fixtures. */
function resolveReportsUrl(directory?: string): string | undefined {
  const raw = process.env["OPENCODE_REPORTS_URL_MAP"]
  if (raw && directory) {
    try {
      const map = JSON.parse(raw) as Record<string, unknown>
      const perDir = map[directory]
      if (typeof perDir === "string" && perDir.trim()) return perDir.trim()
    } catch {
      // malformed map → fall through to the global
    }
  }
  const global = process.env["OPENCODE_REPORTS_URL"]?.trim()
  return global || undefined
}

function resolveReportsToken(): string | undefined {
  return process.env["OPENCODE_REPORTS_TOKEN"]?.trim() || undefined
}

/** True when a live reports endpoint is configured for this directory. */
export function reportsConfigured(directory?: string): boolean {
  return resolveReportsUrl(directory) !== undefined
}

// --- minimal validators: return the typed value or throw (→ ok:false) ---------
function str(v: unknown): string {
  if (typeof v !== "string") throw new Error("expected string")
  return v
}
function strOrNull(v: unknown): string | null {
  return v == null ? null : str(v)
}
function num(v: unknown): number {
  if (typeof v !== "number") throw new Error("expected number")
  return v
}
function asObject(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("expected object")
  return v as Record<string, unknown>
}
function asArray(v: unknown): unknown[] {
  if (!Array.isArray(v)) throw new Error("expected array")
  return v
}
function parseHealth(raw: unknown): ReportsHealth {
  const o = asObject(raw)
  return {
    status: str(o["status"]),
    count: num(o["count"]),
    latestDate: strOrNull(o["latestDate"]),
    checkedAt: typeof o["checkedAt"] === "string" ? (o["checkedAt"] as string) : new Date().toISOString(),
  }
}
function parseReport(raw: unknown): DailyReport {
  const o = asObject(raw)
  return {
    id: str(o["id"]),
    date: str(o["date"]),
    title: str(o["title"]),
    summary: str(o["summary"]),
    format: str(o["format"]),
    source: str(o["source"]),
    body: str(o["body"]),
    generatedAt: typeof o["generatedAt"] === "string" ? (o["generatedAt"] as string) : new Date().toISOString(),
  }
}

type Fetched =
  | { mode: "fixture" }
  | { mode: "live"; json: unknown }
  | { mode: "error"; error: string }

export class ReportsRemoteClient {
  constructor(private readonly directory?: string) {}

  private async fetchJson(path: string): Promise<Fetched> {
    const base = resolveReportsUrl(this.directory)
    if (!base) return { mode: "fixture" }
    const token = resolveReportsToken()
    try {
      const res = await fetch(`${base}${path}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: token ? { authorization: `Bearer ${token}` } : {},
      })
      if (res.status === 401 || res.status === 403) return { mode: "error", error: "reports: not configured (auth rejected)" }
      if (!res.ok) return { mode: "error", error: `reports error (${res.status})` }
      return { mode: "live", json: await res.json() }
    } catch {
      return { mode: "error", error: "reports offline" }
    }
  }

  private async read<T>(
    path: string,
    fixture: () => ReportResult<T>,
    parse: (json: unknown) => T,
  ): Promise<ReportResult<T>> {
    const r = await this.fetchJson(path)
    if (r.mode === "fixture") return fixture()
    if (r.mode === "error") return { ok: false, source: "live", error: r.error }
    try {
      return { ok: true, source: "live", data: parse(r.json) }
    } catch {
      return { ok: false, source: "live", error: `reports: malformed response for ${path}` }
    }
  }

  health(): Promise<ReportResult<ReportsHealth>> {
    return this.read("/health", () => ({ ok: true, source: "fixture", data: FIXTURE_HEALTH }), parseHealth)
  }

  listReports(): Promise<ReportResult<DailyReport[]>> {
    return this.read(
      "/reports",
      () => ({ ok: true, source: "fixture", data: FIXTURE_REPORTS }),
      (json) => asArray(asObject(json)["reports"]).map(parseReport),
    )
  }

  getReport(id: string): Promise<ReportResult<DailyReport>> {
    return this.read(
      `/reports/${encodeURIComponent(id)}`,
      () => {
        const report = FIXTURE_REPORT_BY_ID[id]
        return report
          ? { ok: true, source: "fixture", data: report }
          : { ok: false, source: "fixture", error: `report not found: ${id}` }
      },
      (json) => parseReport(asObject(json)["report"]),
    )
  }
}
