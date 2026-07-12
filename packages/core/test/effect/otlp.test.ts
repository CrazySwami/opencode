import { afterEach, describe, expect, test } from "bun:test"
import { Otlp } from "../../src/observability/otlp"

// The load-bearing regression for "trace them all": before this, enabling
// LangSmith (LANGSMITH_TRACING + LANGSMITH_API_KEY) created spans but exported
// NOTHING, because the exporter only looked at OTEL_EXPORTER_OTLP_ENDPOINT.
// resolveExporter now auto-derives a LangSmith OTLP target, so enabling tracing
// actually ships spans. These tests pin that precedence + derivation.

const ENV = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "LANGSMITH_API_KEY",
  "LANGSMITH_TRACING",
  "LANGSMITH_PROJECT",
  "LANGSMITH_ENDPOINT",
] as const
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]])) as Record<(typeof ENV)[number], string | undefined>

function clearAll() {
  for (const k of ENV) delete process.env[k]
}

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe("Otlp.resolveExporter", () => {
  test("no env → undefined, exporterConfigured false", () => {
    clearAll()
    expect(Otlp.resolveExporter()).toBeUndefined()
    expect(Otlp.exporterConfigured()).toBe(false)
  })

  test("explicit OTEL_EXPORTER_OTLP_ENDPOINT wins + parses headers", () => {
    clearAll()
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://collector.example/otlp/"
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "authorization=Bearer abc,x-tenant=acme"
    const e = Otlp.resolveExporter()
    expect(e?.endpoint).toBe("https://collector.example/otlp") // trailing slash trimmed
    expect(e?.headers).toEqual({ authorization: "Bearer abc", "x-tenant": "acme" })
    expect(Otlp.exporterConfigured()).toBe(true)
  })

  test("derives a LangSmith OTLP exporter when tracing is enabled and OTEL is unset", () => {
    clearAll()
    process.env.LANGSMITH_TRACING = "1"
    process.env.LANGSMITH_API_KEY = "lsv2-secret-should-not-leak"
    process.env.LANGSMITH_PROJECT = "token-maxing"
    const e = Otlp.resolveExporter()
    expect(e?.endpoint).toBe("https://api.smith.langchain.com/otel")
    expect(e?.headers?.["x-api-key"]).toBe("lsv2-secret-should-not-leak")
    expect(e?.headers?.["Langsmith-Project"]).toBe("token-maxing")
    expect(Otlp.exporterConfigured()).toBe(true)
  })

  test("explicit OTEL endpoint beats the LangSmith derivation", () => {
    clearAll()
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318"
    process.env.LANGSMITH_TRACING = "1"
    process.env.LANGSMITH_API_KEY = "lsv2-secret"
    const e = Otlp.resolveExporter()
    expect(e?.endpoint).toBe("http://127.0.0.1:4318")
    expect(e?.headers).toBeUndefined() // no OTEL headers set
  })

  test("honors a custom LANGSMITH_ENDPOINT base", () => {
    clearAll()
    process.env.LANGSMITH_TRACING = "1"
    process.env.LANGSMITH_API_KEY = "lsv2-secret"
    process.env.LANGSMITH_ENDPOINT = "https://eu.api.smith.langchain.com/"
    expect(Otlp.resolveExporter()?.endpoint).toBe("https://eu.api.smith.langchain.com/otel")
  })

  test("LangSmith requested but NO key → not enabled → no exporter (fail-safe)", () => {
    clearAll()
    process.env.LANGSMITH_TRACING = "1" // key missing
    expect(Otlp.resolveExporter()).toBeUndefined()
    expect(Otlp.exporterConfigured()).toBe(false)
  })

  test("never leaks the key anywhere but the x-api-key header value", () => {
    clearAll()
    process.env.LANGSMITH_TRACING = "1"
    process.env.LANGSMITH_API_KEY = "lsv2-secret-should-not-leak"
    const e = Otlp.resolveExporter()!
    expect(e.endpoint).not.toMatch(/lsv2-secret/)
    // the only place the secret may appear is the x-api-key header value
    const nonKeyHeaders = { ...e.headers }
    delete nonKeyHeaders["x-api-key"]
    expect(JSON.stringify(nonKeyHeaders)).not.toMatch(/lsv2-secret/)
  })
})
