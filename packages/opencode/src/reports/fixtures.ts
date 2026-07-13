/**
 * Deterministic personal daily report fixtures — used whenever no reports URL
 * is configured (the default). Each body is OpenBook markdown. Consumers MUST
 * surface these as "FIXTURE DATA" (the client returns `source: "fixture"`).
 */
import type { DailyReport, ReportsHealth } from "./types"

export const FIXTURE_HEALTH: ReportsHealth = {
  status: "ok",
  count: 3,
  latestDate: "2026-07-13",
  checkedAt: "2026-07-13T00:00:00.000Z",
}

export const FIXTURE_REPORTS: DailyReport[] = [
  {
    id: "daily-2026-07-11",
    date: "2026-07-11",
    title: "Daily report — 2026-07-11",
    summary: "Brand Studio quality campaign wave 1 landed; CT100 stayed healthy all day.",
    format: "openbook",
    source: "opencode-daily-routine",
    generatedAt: "2026-07-11T23:45:00.000Z",
    body: "# Daily report — 2026-07-11\n\n**What happened.** Shipped Brand Studio quality-campaign wave 1 (logo-first colors, honest UI counts). CT100 load stayed under 4 all day; no watchdog events.\n\n**Result.** 12 commits merged, 0 incidents. Eval harness green on all gold specs.\n\n**Follow-ups.** Start wave 2 (social scraping migration) once ScrapeCreators keys arrive.",
  },
  {
    id: "daily-2026-07-12",
    date: "2026-07-12",
    title: "Daily report — 2026-07-12",
    summary: "Token-maxing daemon rotation verified live; dashboard tracing phase kicked off.",
    format: "openbook",
    source: "opencode-daily-routine",
    generatedAt: "2026-07-12T23:50:00.000Z",
    body: "# Daily report — 2026-07-12\n\n**What happened.** Verified token-maxing daemon most-headroom rotation against live GLM/Claude/Codex adapters. Kicked off the central-dashboard tracing phase.\n\n**Result.** Rotation picked the right provider in 20/20 sampled decisions. Tracing spec drafted.\n\n**Follow-ups.** Wire Grok and Gemini adapters when keys land; add a second Codex account to the pool.",
  },
  {
    id: "daily-2026-07-13",
    date: "2026-07-13",
    title: "Daily report — 2026-07-13",
    summary: "Reports bridge scaffolded fixtures-first; no external systems touched.",
    format: "openbook",
    source: "opencode-daily-routine",
    generatedAt: "2026-07-13T23:40:00.000Z",
    body: "# Daily report — 2026-07-13\n\n**What happened.** Scaffolded the read-only personal daily reports bridge (fixtures-first, OpenBook format), mirroring the Trellis bridge invariants.\n\n**Result.** Client + fixtures + tests in place. No mutations to external systems.\n\n**Follow-ups.** Point OPENCODE_REPORTS_URL at the real feed once it exposes /health and /reports.",
  },
]

export const FIXTURE_REPORT_BY_ID: Record<string, DailyReport> = Object.fromEntries(
  FIXTURE_REPORTS.map((r) => [r.id, r]),
)
