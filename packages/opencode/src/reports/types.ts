/**
 * Typed contracts for the read-only personal daily reports bridge.
 *
 * The reports feed has NO live endpoint today, so these shapes are INFERRED
 * and the fixtures define the contract until a real read API exists. Every
 * report is an OpenBook-format markdown document; OpenCode never owns report
 * generation and never writes back to the feed.
 */

/** How a reading was obtained. `fixture` is deterministic seed data, clearly labeled. */
export type ReportSource = "live" | "fixture"

/** Discriminated result every client method returns — never throws. */
export type ReportResult<T> =
  | { ok: true; source: ReportSource; data: T }
  | { ok: false; source: ReportSource; error: string }

export interface DailyReport {
  id: string
  date: string
  title: string
  summary: string
  /** Always "openbook" today; kept open for future formats. */
  format: string
  /** Which system/routine produced the report. Never a credential. */
  source: string
  /** OpenBook markdown body. */
  body: string
  generatedAt: string
}

export interface ReportsHealth {
  status: string
  count: number
  latestDate: string | null
  checkedAt: string
}
