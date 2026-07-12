import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { Session } from "@/session/session"
import { Database } from "@opencode-ai/core/database/database"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

// Handler contract under test lives in
//   src/server/routes/instance/httpapi/server.ts
//     - GET /experimental/tracing/status (search "tracing/status")
//
// This is the fix for the "enabled but exporting nothing" footgun: tracing
// can be `enabled:true` (LANGSMITH_TRACING + LANGSMITH_API_KEY) yet ship
// zero spans if no OTLP exporter is resolvable. The route now also reports
// `exporterConfigured` (from Otlp.exporterConfigured(), which auto-derives
// a LangSmith OTLP exporter when LangSmith tracing is enabled) and
// `exporting` (enabled && exporterConfigured), so callers can see the real
// end-to-end state instead of just the intent-to-trace flag.

const it = testEffect(Layer.mergeAll(Session.defaultLayer, Database.defaultLayer, httpApiLayer))

function request(path: string, directory: string, init: RequestInit = {}) {
  return requestInDirectory(path, directory, init)
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  return response.json.pipe(Effect.map((value) => value as T))
}

type TracingStatus = {
  ok: boolean
  enabled: boolean
  project: string | null
  hasKey: boolean
  exporterConfigured: boolean
  exporting: boolean
  recordsContent: boolean
}

// Env is read at call time by LangSmith.tracingConfig() / Otlp.exporterConfigured(),
// so setting it before the request (and restoring it after) is sufficient --
// no server restart needed between cases.
const ENV_KEYS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "LANGSMITH_TRACING",
  "LANGSMITH_API_KEY",
  "LANGSMITH_PROJECT",
  "LANGSMITH_ENDPOINT",
  "OPENCODE_TRACE_RECORD_CONTENT",
] as const

const ORIGINAL_ENV: Record<string, string | undefined> = {}
for (const key of ENV_KEYS) ORIGINAL_ENV[key] = process.env[key]

function clearTracingEnv() {
  for (const key of ENV_KEYS) delete process.env[key]
}

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key]
    else process.env[key] = ORIGINAL_ENV[key]
  }
  await disposeAllInstances()
})

describe("experimental HttpApi: /experimental/tracing/status", () => {
  it.instance("no tracing env → disabled, no key, no exporter, not exporting", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      clearTracingEnv()
      const res = yield* request("/experimental/tracing/status", tmp.directory)
      expect(res.status).toBe(200)
      const body = yield* json<TracingStatus>(res)
      expect(body.ok).toBe(true)
      expect(body.enabled).toBe(false)
      expect(body.hasKey).toBe(false)
      expect(body.exporterConfigured).toBe(false)
      expect(body.exporting).toBe(false)
    }),
  )

  it.instance(
    "LangSmith enabled → enabled, hasKey, exporterConfigured auto-derived, exporting (footgun-fix proof)",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        clearTracingEnv()
        process.env.LANGSMITH_TRACING = "1"
        process.env.LANGSMITH_API_KEY = "lsv2-test"
        const res = yield* request("/experimental/tracing/status", tmp.directory)
        expect(res.status).toBe(200)
        const body = yield* json<TracingStatus>(res)
        expect(body.ok).toBe(true)
        expect(body.enabled).toBe(true)
        expect(body.hasKey).toBe(true)
        // Load-bearing: before the fix, this path reported enabled:true but
        // exporterConfigured was not derived from LangSmith config, so spans
        // silently went nowhere. Now the exporter is auto-derived.
        expect(body.exporterConfigured).toBe(true)
        expect(body.exporting).toBe(true)
      }),
  )

  it.instance(
    "explicit OTEL endpoint, LangSmith off → exporterConfigured true but telemetry disabled",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        clearTracingEnv()
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318"
        const res = yield* request("/experimental/tracing/status", tmp.directory)
        expect(res.status).toBe(200)
        const body = yield* json<TracingStatus>(res)
        expect(body.ok).toBe(true)
        expect(body.exporterConfigured).toBe(true)
        expect(body.enabled).toBe(false)
        expect(body.exporting).toBe(false)
      }),
  )

  it.instance("recordsContent reflects OPENCODE_TRACE_RECORD_CONTENT (off by default)", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      clearTracingEnv()
      const res = yield* request("/experimental/tracing/status", tmp.directory)
      expect(res.status).toBe(200)
      const body = yield* json<TracingStatus>(res)
      expect(body.recordsContent).toBe(false)
    }),
  )

  it.instance("recordsContent reflects OPENCODE_TRACE_RECORD_CONTENT=1", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      clearTracingEnv()
      process.env.OPENCODE_TRACE_RECORD_CONTENT = "1"
      const res = yield* request("/experimental/tracing/status", tmp.directory)
      expect(res.status).toBe(200)
      const body = yield* json<TracingStatus>(res)
      expect(body.recordsContent).toBe(true)
    }),
  )

  it.instance("never leaks the LangSmith API key value in the response body", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      clearTracingEnv()
      process.env.LANGSMITH_TRACING = "1"
      process.env.LANGSMITH_API_KEY = "lsv2-test"
      const res = yield* request("/experimental/tracing/status", tmp.directory)
      expect(res.status).toBe(200)
      const text = yield* res.text
      expect(text).not.toMatch(/lsv2-test/)
    }),
  )
})
