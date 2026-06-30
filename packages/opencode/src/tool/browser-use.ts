import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./browser-use.txt"

const actions = [
  "status",
  "sessions",
  "create",
  "run",
  "navigate",
  "viewport",
  "state",
  "snapshot",
  "click",
  "type",
  "keys",
  "wait",
  "close",
] as const

export const Parameters = Schema.Struct({
  action: Schema.Literals(actions).annotate({
    description: "Browser Use action to run against the CT100 Browser Use bridge.",
  }),
  sessionID: Schema.optional(Schema.String).annotate({
    description: "Browser Use session id returned by create or sessions. Required for session-specific actions.",
  }),
  task: Schema.optional(Schema.String).annotate({
    description: "Natural-language task for create or run.",
  }),
  url: Schema.optional(Schema.String).annotate({
    description: "URL for create, run, or navigate.",
  }),
  text: Schema.optional(Schema.String).annotate({
    description: "Text for type or keys.",
  }),
  index: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: "Browser Use element index for click or type.",
  }),
  x: Schema.optional(Schema.Int).annotate({
    description: "X coordinate for click.",
  }),
  y: Schema.optional(Schema.Int).annotate({
    description: "Y coordinate for click.",
  }),
  width: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(320))).annotate({
    description: "Viewport width for viewport.",
  }),
  height: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(240))).annotate({
    description: "Viewport height for viewport.",
  }),
  seconds: Schema.optional(Schema.Number).annotate({
    description: "Wait duration in seconds for wait.",
  }),
  model: Schema.optional(Schema.String).annotate({
    description: "Optional Browser Use model override passed to the bridge.",
  }),
  headless: Schema.optional(Schema.Boolean).annotate({
    description: "Optional create override. Defaults to the bridge's visible browser mode.",
  }),
})

type Action = (typeof actions)[number]
type Metadata = {
  action: Action
  bridgeURL: string
  sessionID?: string
  liveURL?: string
}

export const BrowserUseTool = Tool.define<typeof Parameters, Metadata, never>(
  "browser_use",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const bridgeURL = browserUseBridgeURL()
          if (!["status", "sessions"].includes(params.action)) {
            yield* ctx.ask({
              permission: "browser_use",
              patterns: [params.action],
              always: ["status", "sessions", "state", "snapshot"],
              metadata: {
                action: params.action,
                sessionID: params.sessionID,
                url: params.url,
              },
            })
          }

          const result = yield* Effect.promise(() => runBrowserUse(params, bridgeURL))
          const sessionID = extractSessionID(params, result)
          const liveURL = typeof result?.liveUrl === "string" ? result.liveUrl : result?.health?.liveUrl

          return {
            title: `browser_use ${params.action}`,
            output: JSON.stringify(redactBrowserUseResult(result), null, 2),
            metadata: {
              action: params.action,
              bridgeURL,
              ...(sessionID ? { sessionID } : {}),
              ...(typeof liveURL === "string" ? { liveURL } : {}),
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

async function runBrowserUse(params: Schema.Schema.Type<typeof Parameters>, bridgeURL: string) {
  switch (params.action) {
    case "status": {
      const [health, sessions] = await Promise.all([
        requestJSON(bridgeURL, "/health"),
        requestJSON(bridgeURL, "/sessions"),
      ])
      return { ok: Boolean(health?.ok), bridgeURL, profilePolicy: browserUseProfilePolicy(), health, sessions }
    }
    case "sessions":
      return await requestJSON(bridgeURL, "/sessions")
    case "create":
      return await requestJSON(bridgeURL, "/sessions", {
        method: "POST",
        body: {
          task: params.task,
          url: normalizeURL(params.url),
          model: params.model,
          headless: params.headless,
          keepAlive: true,
        },
      })
    case "run":
      return await requestJSON(bridgeURL, `/sessions/${encodeURIComponent(requireSession(params))}/run`, {
        method: "POST",
        body: {
          task: params.task,
          url: normalizeURL(params.url),
          model: params.model,
          keepAlive: true,
        },
      })
    case "navigate":
      return await requestJSON(bridgeURL, `/sessions/${encodeURIComponent(requireSession(params))}/navigate`, {
        method: "POST",
        body: { url: requireURL(params), keepAlive: true },
      })
    case "viewport":
      return await requestJSON(bridgeURL, `/sessions/${encodeURIComponent(requireSession(params))}/viewport`, {
        method: "POST",
        body: {
          width: params.width ?? 1440,
          height: params.height ?? 1000,
          keepAlive: true,
        },
      })
    case "state":
      return await requestJSON(bridgeURL, `/sessions/${encodeURIComponent(requireSession(params))}/state`)
    case "snapshot":
      return await requestJSON(bridgeURL, `/sessions/${encodeURIComponent(requireSession(params))}/snapshot`)
    case "click":
      return await requestJSON(bridgeURL, `/sessions/${encodeURIComponent(requireSession(params))}/click`, {
        method: "POST",
        body: {
          index: params.index,
          coordinateX: params.x,
          coordinateY: params.y,
        },
      })
    case "type":
      if (!params.text) throw new Error("browser_use.type requires text")
      return await requestJSON(bridgeURL, `/sessions/${encodeURIComponent(requireSession(params))}/type`, {
        method: "POST",
        body: { index: params.index, text: params.text, clear: true },
      })
    case "keys":
      if (!params.text) throw new Error("browser_use.keys requires text")
      return await requestJSON(bridgeURL, `/sessions/${encodeURIComponent(requireSession(params))}/keys`, {
        method: "POST",
        body: { keys: params.text },
      })
    case "wait":
      return await requestJSON(bridgeURL, `/sessions/${encodeURIComponent(requireSession(params))}/wait`, {
        method: "POST",
        body: { ms: Math.round((params.seconds ?? 1) * 1000) },
      })
    case "close":
      return await requestJSON(bridgeURL, `/sessions/${encodeURIComponent(requireSession(params))}/close`, {
        method: "POST",
        body: {},
      })
  }
}

async function requestJSON(
  bridgeURL: string,
  route: string,
  options: { method?: "GET" | "POST"; body?: Record<string, unknown> } = {},
) {
  const response = await fetch(`${bridgeURL}${route}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(stripUndefined(options.body)) : undefined,
  })
  const text = await response.text()
  const body = text ? JSON.parse(text) : {}
  if (!response.ok) {
    const detail = typeof body?.detail === "string" ? body.detail : text
    throw new Error(`Browser Use bridge HTTP ${response.status}: ${detail}`)
  }
  return body
}

function browserUseBridgeURL() {
  return (process.env.OPENCODE_BROWSER_USE_URL || "http://127.0.0.1:8768").replace(/\/+$/, "")
}

function browserUseProfilePolicy() {
  const persistentProfileRequested = process.env.OPENCODE_BROWSER_USE_PERSISTENT_PROFILE === "1"
  const extensionsRequested = process.env.OPENCODE_BROWSER_USE_EXTENSIONS === "1"
  const lastPassRequested = process.env.OPENCODE_BROWSER_USE_LASTPASS === "1"
  const accessConfigured = Boolean(
    process.env.OPENCODE_CLOUDFLARE_ACCESS_AUD && process.env.OPENCODE_CLOUDFLARE_ACCESS_TEAM_DOMAIN,
  )
  const liveExposureEnabled = process.env.OPENCODE_LIVE_BROWSER_EXPOSE !== "0"
  const accessBoundaryReady = liveExposureEnabled && accessConfigured
  const persistentProfileReady = accessBoundaryReady || (liveExposureEnabled && persistentProfileRequested)
  return {
    status: persistentProfileReady
      ? accessBoundaryReady
        ? "manual_profile_setup_required"
        : "persistent_profile_enabled_by_explicit_live_override"
      : accessBoundaryReady
        ? "safe_default_no_persistent_auth"
        : "blocked_access_boundary",
    requiredAccessBoundary: "Cloudflare Access GitHub login for code.hustletogether.com",
    accessBoundaryReady,
    persistentProfile: {
      requested: persistentProfileRequested,
      enabled: persistentProfileReady && persistentProfileRequested,
      status: persistentProfileReady
        ? accessBoundaryReady
          ? "manual_profile_setup_required"
          : "enabled_by_explicit_live_override"
        : "blocked_until_access_boundary",
    },
    extensions: {
      requested: extensionsRequested,
      enabled: accessBoundaryReady && extensionsRequested,
      status: accessBoundaryReady
        ? extensionsRequested
          ? "manual_install_required"
          : "disabled_by_policy"
        : "blocked_until_access_boundary",
    },
    lastPass: {
      requested: lastPassRequested,
      enabled: accessBoundaryReady && extensionsRequested && lastPassRequested,
      status: accessBoundaryReady
        ? extensionsRequested && lastPassRequested
          ? "manual_install_and_login_required"
          : "disabled_by_policy"
        : "blocked_until_access_boundary",
    },
  }
}

function requireSession(params: Schema.Schema.Type<typeof Parameters>) {
  if (!params.sessionID) throw new Error(`browser_use.${params.action} requires sessionID`)
  return params.sessionID
}

function requireURL(params: Schema.Schema.Type<typeof Parameters>) {
  const url = normalizeURL(params.url)
  if (!url) throw new Error(`browser_use.${params.action} requires url`)
  return url
}

function normalizeURL(raw?: string) {
  const value = raw?.trim()
  if (!value) return undefined
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value
  if (value.includes(".") && !value.includes(" ")) return `https://${value}`
  return value
}

function stripUndefined(input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
}

function extractSessionID(params: Schema.Schema.Type<typeof Parameters>, result: any) {
  if (params.sessionID) return params.sessionID
  if (typeof result?.id === "string") return result.id
  return undefined
}

function redactBrowserUseResult(input: any): any {
  if (Array.isArray(input)) return input.map(redactBrowserUseResult)
  if (!input || typeof input !== "object") return input
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => {
      if (/password|passwd|passphrase|secret|token|cookie|authorization|auth/i.test(key)) return [key, "[redacted]"]
      if (key === "screenshotBase64" && typeof value === "string") return [key, `[base64 png ${value.length} chars]`]
      return [key, redactBrowserUseResult(value)]
    }),
  )
}
