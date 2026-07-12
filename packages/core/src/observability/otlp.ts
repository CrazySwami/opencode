import { Layer } from "effect"
import { OtlpLogger } from "effect/unstable/observability"
import { Flag } from "../flag/flag"
import { InstallationChannel, InstallationVersion } from "../installation/version"
import { LangSmith } from "./langsmith"
import { runID } from "./shared"

/** LangSmith's OTLP ingest path (it speaks OTLP directly). */
const LANGSMITH_DEFAULT_BASE = "https://api.smith.langchain.com"

function parseHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined
  return raw.split(",").reduce(
    (acc, entry) => {
      const [key, ...value] = entry.split("=")
      acc[key] = value.join("=")
      return acc
    },
    {} as Record<string, string>,
  )
}

/**
 * Resolve the effective OTLP trace/log exporter target, read at CALL time (so
 * boot env — and tests — are honored). Precedence:
 *   1. explicit OTEL_EXPORTER_OTLP_ENDPOINT (+ OTEL_EXPORTER_OTLP_HEADERS) wins.
 *   2. else, if LangSmith tracing is enabled (LANGSMITH_TRACING + LANGSMITH_API_KEY),
 *      auto-derive the LangSmith OTLP endpoint + `x-api-key`/`Langsmith-Project`
 *      headers — so enabling LangSmith actually EXPORTS spans instead of silently
 *      creating no-op ones (the prior footgun: status showed enabled:true while
 *      nothing shipped). The key is used only as an opaque outgoing header value.
 *   3. else, no exporter (returns undefined).
 */
export function resolveExporter(): { endpoint: string; headers?: Record<string, string> } | undefined {
  const explicit = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]?.trim()
  if (explicit) {
    return { endpoint: explicit.replace(/\/+$/, ""), headers: parseHeaders(process.env["OTEL_EXPORTER_OTLP_HEADERS"]) }
  }
  const ls = LangSmith.tracingConfig()
  if (ls.enabled) {
    const base = (process.env["LANGSMITH_ENDPOINT"]?.trim() || LANGSMITH_DEFAULT_BASE).replace(/\/+$/, "")
    const headers: Record<string, string> = { "x-api-key": process.env["LANGSMITH_API_KEY"]!.trim() }
    if (ls.project) headers["Langsmith-Project"] = ls.project
    // Base may or may not already end in /otel; normalize to exactly one.
    const endpoint = base.endsWith("/otel") ? base : `${base}/otel`
    return { endpoint, headers }
  }
  return undefined
}

/** True when spans/logs will actually be exported somewhere. Used by the status route. */
export function exporterConfigured(): boolean {
  return Boolean(resolveExporter())
}

function resourceAttributes() {
  const value = process.env.OTEL_RESOURCE_ATTRIBUTES
  if (!value) return {}
  try {
    return Object.fromEntries(
      value.split(",").map((entry) => {
        const index = entry.indexOf("=")
        if (index < 1) throw new Error("Invalid OTEL_RESOURCE_ATTRIBUTES entry")
        return [decodeURIComponent(entry.slice(0, index)), decodeURIComponent(entry.slice(index + 1))]
      }),
    )
  } catch {
    return {}
  }
}

export function resource(): { serviceName: string; serviceVersion: string; attributes: Record<string, string> } {
  return {
    serviceName: "opencode",
    serviceVersion: InstallationVersion,
    attributes: {
      ...resourceAttributes(),
      "deployment.environment.name": InstallationChannel,
      "opencode.client": Flag.OPENCODE_CLIENT,
      "opencode.run": runID,
      "service.instance.id": runID,
    },
  }
}

export function loggers() {
  const exporter = resolveExporter()
  if (!exporter) return []
  return [OtlpLogger.make({ url: `${exporter.endpoint}/v1/logs`, resource: resource(), headers: exporter.headers })]
}

export async function tracingLayer() {
  const exporter = resolveExporter()
  if (!exporter) return Layer.empty
  const NodeSdk = await import("@effect/opentelemetry/NodeSdk")
  const OTLP = await import("@opentelemetry/exporter-trace-otlp-http")
  const SdkBase = await import("@opentelemetry/sdk-trace-base")
  const { AsyncLocalStorageContextManager } = await import("@opentelemetry/context-async-hooks")
  const { context } = await import("@opentelemetry/api")

  // The Effect Node SDK does not register a global context manager, but the AI SDK uses it to parent spans.
  const manager = new AsyncLocalStorageContextManager()
  manager.enable()
  context.setGlobalContextManager(manager)

  return NodeSdk.layer(() => ({
    resource: resource(),
    spanProcessor: new SdkBase.BatchSpanProcessor(
      new OTLP.OTLPTraceExporter({
        url: `${exporter.endpoint}/v1/traces`,
        headers: exporter.headers,
      }),
    ),
  }))
}

export * as Otlp from "./otlp"
