/**
 * Typed contracts for the read-only Trellis bridge.
 *
 * Trellis (Mirror Factory's Open SWE / LangGraph runtime) has NO live/MCP
 * endpoint today, so these shapes are INFERRED and the fixtures define the
 * contract until a real read API exists. Everything here is read-only metadata;
 * OpenCode never owns Trellis execution.
 */

/** How a reading was obtained. `fixture` is deterministic seed data, clearly labeled. */
export type TrellisSource = "live" | "fixture"

/** Discriminated result every client method returns — never throws. */
export type TrellisResult<T> =
  | { ok: true; source: TrellisSource; data: T }
  | { ok: false; source: TrellisSource; error: string }

export interface TrellisHealth {
  status: string
  version: string | null
  runtime: string | null
  checkedAt: string
}

export interface TrellisAgent {
  id: string
  name: string
  role: string | null
  status: string | null
}

export interface TrellisRun {
  id: string
  agentId: string
  title: string
  status: string
  startedAt: string | null
  finishedAt: string | null
  /** Non-secret linkage (e.g. a Linear key). Never a credential. */
  linear: string | null
}

export interface TrellisRunStep {
  at: string
  kind: string
  summary: string
}

export interface TrellisRunDetail extends TrellisRun {
  steps: TrellisRunStep[]
}

export interface TrellisReport {
  runId: string
  format: string
  title: string
  body: string
  generatedAt: string
}
