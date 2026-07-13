/**
 * Deterministic Trellis fixtures — used whenever no live Trellis URL is
 * configured (the M0–M2 default). Modeled on Trellis's own vocabulary: Armando
 * (chief-engineer agent) + sprouts (per-task sandbox subagents). Consumers MUST
 * surface these as "FIXTURE DATA" (the client returns `source: "fixture"`).
 */
import type { TrellisAgent, TrellisHealth, TrellisReport, TrellisRun, TrellisRunDetail } from "./types"

export const FIXTURE_HEALTH: TrellisHealth = {
  status: "ok",
  version: "0.4.0-sprint-zero",
  runtime: "langgraph",
  checkedAt: "2026-07-12T00:00:00.000Z",
}

export const FIXTURE_AGENTS: TrellisAgent[] = [
  { id: "armando", name: "Armando", role: "chief-engineer", status: "idle" },
  { id: "sprout-reviewer", name: "Reviewer sprout", role: "reviewer", status: "idle" },
  { id: "sprout-analyzer", name: "Analyzer sprout", role: "analyzer", status: "idle" },
]

export const FIXTURE_RUNS: TrellisRun[] = [
  {
    id: "run_001",
    agentId: "armando",
    title: "PLAT-108 sandbox e2e",
    status: "completed",
    startedAt: "2026-07-12T00:00:00.000Z",
    finishedAt: "2026-07-12T00:12:00.000Z",
    linear: "PLAT-108",
  },
  {
    id: "run_002",
    agentId: "sprout-analyzer",
    title: "Analyze failing eval",
    status: "running",
    startedAt: "2026-07-12T00:20:00.000Z",
    finishedAt: null,
    linear: "PLAT-111",
  },
]

export const FIXTURE_RUN_DETAIL: Record<string, TrellisRunDetail> = {
  run_001: {
    ...FIXTURE_RUNS[0]!,
    steps: [
      { at: "2026-07-12T00:00:05.000Z", kind: "plan", summary: "Draft the sandbox e2e plan" },
      { at: "2026-07-12T00:03:00.000Z", kind: "tool", summary: "Provisioned disposable sandbox" },
      { at: "2026-07-12T00:11:00.000Z", kind: "review", summary: "Reviewer sprout approved" },
    ],
  },
  run_002: {
    ...FIXTURE_RUNS[1]!,
    steps: [{ at: "2026-07-12T00:20:05.000Z", kind: "plan", summary: "Reproduce the failing eval case" }],
  },
}

export const FIXTURE_REPORT: Record<string, TrellisReport> = {
  run_001: {
    runId: "run_001",
    format: "openbook",
    title: "PLAT-108 sandbox e2e — report",
    generatedAt: "2026-07-12T00:12:30.000Z",
    body: "# PLAT-108 sandbox e2e\n\n**What happened.** Armando planned and ran the disposable-sandbox e2e; a reviewer sprout approved.\n\n**Result.** Passed. No mutations to external systems.\n\n**Follow-ups.** None.",
  },
}
