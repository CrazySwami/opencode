export * as LangSmith from "./langsmith"

import { InstallationChannel } from "../installation/version"

/**
 * LangSmith tracing gate.
 *
 * SECURITY: this module is presence-check only. It never reads, returns,
 * logs, or echoes the value of LANGSMITH_API_KEY -- only whether it is set.
 * Do not add code here (or at any call site) that logs `process.env.LANGSMITH_API_KEY`
 * or forwards it anywhere other than as an opaque header value on an outgoing
 * OTLP exporter request.
 *
 * Tracing is OFF by default. It only turns on when BOTH of these hold:
 *   - LANGSMITH_TRACING is "1" or "true"
 *   - LANGSMITH_API_KEY is present (any non-empty string)
 *
 * LANGSMITH_PROJECT (optional) is just a label used for metadata/status
 * display -- it is not a secret.
 *
 * How spans actually reach LangSmith (exporter hook):
 * This module only flips the AI SDK's `experimental_telemetry.isEnabled` flag
 * and attaches stable metadata (session id / model / provider / env) to each
 * generateText/streamText/generateObject call. That alone does not ship spans
 * anywhere -- the AI SDK still needs a real OpenTelemetry span exporter
 * registered in the process to emit them.
 *
 * This repo already has a generic one: `packages/core/src/observability/otlp.ts`
 * builds an OTLP HTTP trace exporter from OTEL_EXPORTER_OTLP_ENDPOINT /
 * OTEL_EXPORTER_OTLP_HEADERS. LangSmith accepts OTLP directly, so the smallest
 * correct way to wire the exporter is to point that existing generic exporter
 * at LangSmith's OTLP endpoint instead of building a second, LangSmith-specific
 * OTel SDK integration:
 *
 *   OTEL_EXPORTER_OTLP_ENDPOINT=https://api.smith.langchain.com/otel
 *   OTEL_EXPORTER_OTLP_HEADERS=x-api-key=<your LangSmith API key>,Langsmith-project=<project>
 *
 * LANGSMITH_TRACING / LANGSMITH_API_KEY / LANGSMITH_PROJECT only decide
 * *whether* the AI SDK emits telemetry for this feature; OTEL_EXPORTER_OTLP_*
 * decides *where* any exporter-level spans end up. Wiring the same key twice
 * (LangSmith-specific env AND generic OTEL env) is intentional: it lets
 * tracing be enabled/disabled independently of whether an exporter endpoint
 * happens to be configured, so flipping LANGSMITH_TRACING off never requires
 * touching OTEL_EXPORTER_OTLP_* and vice versa.
 */

export interface TracingConfig {
  /** True only when LANGSMITH_TRACING is truthy AND a key is present. */
  enabled: boolean
  /** Presence-only check -- never the key value itself. */
  hasKey: boolean
  /** Optional project label (not a secret), or null if unset. */
  project: string | null
}

function truthy(value: string | undefined) {
  const normalized = value?.trim().toLowerCase()
  return normalized === "1" || normalized === "true"
}

/** Reads env at call time (not module load) so tests and runtime config changes are picked up. */
export function tracingConfig(): TracingConfig {
  const hasKey = Boolean(process.env["LANGSMITH_API_KEY"]?.trim())
  const tracingRequested = truthy(process.env["LANGSMITH_TRACING"])
  const project = process.env["LANGSMITH_PROJECT"]?.trim()
  return {
    enabled: tracingRequested && hasKey,
    hasKey,
    project: project ? project : null,
  }
}

/** Stable, non-secret span/telemetry metadata tags for AI SDK `experimental_telemetry.metadata`. */
export function tracingMetadata(tags: { sessionId?: string; model?: string; provider?: string }) {
  return {
    ...tags,
    env: InstallationChannel,
  }
}
