import { afterEach, describe, expect, test } from "bun:test"
import * as http from "node:http"
import type { AddressInfo } from "node:net"
import { Otlp } from "../../src/observability/otlp"

// Tier-B evidence: prove a span is actually EXPORTED over OTLP to a collector,
// not merely that tracing is "enabled". We stand up a real node:http server
// (a mock OTLP collector), point resolveExporter() at it via env, build the
// exact exporter shape tracingLayer() constructs (OTLPTraceExporter -> a span
// processor -> a tracer provider), emit one real span, force-flush, and assert
// the mock collector received an actual POST /v1/traces with a non-empty body.

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

interface CapturedRequest {
  url: string
  method: string
  bodyLength: number
  headers: http.IncomingHttpHeaders
}

interface MockCollector {
  server: http.Server
  port: number
  requests: CapturedRequest[]
}

/** A minimal mock OTLP collector: records every request, always replies 200. */
function startMockCollector(): Promise<MockCollector> {
  const requests: CapturedRequest[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", () => {
      requests.push({
        url: req.url ?? "",
        method: req.method ?? "",
        bodyLength: Buffer.concat(chunks).length,
        headers: req.headers,
      })
      res.writeHead(200, { "content-type": "application/json" })
      res.end("{}")
    })
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo
      resolve({ server, port: address.port, requests })
    })
  })
}

let collector: MockCollector | undefined
// Anything with an async shutdown() we need to tear down after each test
// (tracer providers). Collected so a failed assertion still cleans up.
let shutdowns: Array<() => Promise<unknown>> = []

afterEach(async () => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  for (const shutdown of shutdowns) {
    await shutdown().catch(() => {})
  }
  shutdowns = []
  if (collector) {
    await new Promise<void>((resolve) => collector!.server.close(() => resolve()))
    collector = undefined
  }
})

/**
 * Builds the same exporter shape `tracingLayer()` uses (OTLPTraceExporter ->
 * span processor -> BasicTracerProvider), emits one real span, and force-flushes
 * it so the export happens synchronously with respect to the test.
 *
 * @opentelemetry/sdk-trace-base@2.6.1's BasicTracerProvider takes span
 * processors via the constructor's `spanProcessors` array (there is no
 * `addSpanProcessor` method on this version), so that's the shape used here.
 */
async function emitOneSpan(target: { endpoint: string; headers?: Record<string, string> }) {
  const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http")
  const { BasicTracerProvider, SimpleSpanProcessor } = await import("@opentelemetry/sdk-trace-base")

  const exporter = new OTLPTraceExporter({
    url: `${target.endpoint}/v1/traces`,
    headers: target.headers,
  })
  const processor = new SimpleSpanProcessor(exporter)
  const provider = new BasicTracerProvider({ spanProcessors: [processor] })
  shutdowns.push(() => provider.shutdown())

  const tracer = provider.getTracer("otlp-span-export-test")
  const span = tracer.startSpan("token-maxing.test")
  span.setAttribute("session.id", "ses_test")
  span.end()

  await provider.forceFlush()
}

describe("OTLP span export reaches a real collector (Tier-B)", () => {
  test("explicit OTEL_EXPORTER_OTLP_ENDPOINT: span is POSTed to /v1/traces with a non-empty body", async () => {
    clearAll()
    collector = await startMockCollector()
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${collector.port}`

    const target = Otlp.resolveExporter()!
    expect(target.endpoint).toBe(`http://127.0.0.1:${collector.port}`)

    await emitOneSpan(target)

    const hits = collector.requests.filter((r) => r.url.endsWith("/v1/traces"))
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].method).toBe("POST")
    expect(hits[0].bodyLength).toBeGreaterThan(0)
  })

  test("LangSmith-derived endpoint: span reaches the collector, x-api-key header present, key never leaks elsewhere", async () => {
    clearAll()
    collector = await startMockCollector()
    process.env.LANGSMITH_TRACING = "1"
    process.env.LANGSMITH_API_KEY = "lsv2-secret-should-not-leak"
    process.env.LANGSMITH_ENDPOINT = `http://127.0.0.1:${collector.port}`
    // OTEL_EXPORTER_OTLP_ENDPOINT intentionally left unset so resolveExporter()
    // must take the LangSmith auto-derive branch.

    const target = Otlp.resolveExporter()!
    expect(target.endpoint).toBe(`http://127.0.0.1:${collector.port}/otel`)

    await emitOneSpan(target)

    const hits = collector.requests.filter((r) => r.url.endsWith("/v1/traces"))
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].bodyLength).toBeGreaterThan(0)
    expect(hits[0].headers["x-api-key"]).toBe("lsv2-secret-should-not-leak")

    // Secret guard: the collector must never observe the key anywhere but the
    // x-api-key header value (not in the URL, not in any other header).
    for (const req of collector.requests) {
      expect(req.url).not.toMatch(/lsv2-secret/)
      const otherHeaders = { ...req.headers }
      delete otherHeaders["x-api-key"]
      expect(JSON.stringify(otherHeaders)).not.toMatch(/lsv2-secret/)
    }
  })
})
