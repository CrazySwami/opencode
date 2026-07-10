export type ConfigInvalidError = {
  name: "ConfigInvalidError"
  data: {
    path?: string
    message?: string
    issues?: Array<{ message: string; path: string[] }>
  }
}

export type ProviderModelNotFoundError = {
  name: "ProviderModelNotFoundError"
  data: {
    providerID: string
    modelID: string
    suggestions?: string[]
  }
}

type Translator = (key: string, vars?: Record<string, string | number>) => string

function tr(translator: Translator | undefined, key: string, text: string, vars?: Record<string, string | number>) {
  if (!translator) return text
  const out = translator(key, vars)
  if (!out || out === key) return text
  return out
}

export function formatServerError(error: unknown, translate?: Translator, fallback?: string) {
  const unwrapped = unwrapNamedError(error)
  if (isConfigInvalidErrorLike(unwrapped)) return parseReadableConfigInvalidError(unwrapped, translate)
  if (isProviderModelNotFoundErrorLike(unwrapped)) return parseReadableProviderModelNotFoundError(unwrapped, translate)
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  if (fallback) return fallback
  return tr(translate, "error.chain.unknown", "Unknown error")
}

// Transient gateway / connectivity failures — the backend is momentarily
// unreachable (a 502/503/504 from Cloudflare while opencode restarts, or a raw
// network drop), NOT a real application error. Callers use this to soft-fail
// (auto-retry on reconnect) instead of showing an error toast. See
// withTransientRetry in utils/server.ts, which already retries these for ~40s;
// this catches the case where even that budget is exhausted mid-restart.
const TRANSIENT_STATUS = new Set([502, 503, 504])

export function isTransientGatewayError(error: unknown): boolean {
  // Structured: wrapClientError puts { body, status } on Error.cause.
  if (error instanceof Error && error.cause && typeof error.cause === "object") {
    const status = (error.cause as Record<string, unknown>).status
    if (typeof status === "number" && TRANSIENT_STATUS.has(status)) return true
    // Network failure with no response → wrapClientError sets status undefined
    // and a "network error (no response)" message.
    if (status === undefined && /network error \(no response\)/i.test(error.message)) return true
  }
  // Direct status field (some callers pass the response-ish object).
  if (typeof error === "object" && error !== null) {
    const status = (error as Record<string, unknown>).status
    if (typeof status === "number" && TRANSIENT_STATUS.has(status)) return true
  }
  // Message / body heuristics: browser fetch offline + Cloudflare 502 HTML.
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : ""
  if (/\b50[234]\b|bad gateway|service (temporarily )?unavailable|gateway time-?out/i.test(text)) return true
  if (/failed to fetch|networkerror|load failed|connection refused|econnrefused|err_network/i.test(text)) return true
  return false
}

function unwrapNamedError(error: unknown): unknown {
  if (error instanceof Error && error.cause && typeof error.cause === "object" && "body" in error.cause) {
    return (error.cause as Record<string, unknown>).body
  }
  return error
}

export function isSessionNotFoundError(error: unknown, sessionID: string) {
  const unwrapped = unwrapNamedError(error)
  if (typeof unwrapped === "object" && unwrapped !== null) {
    const value = unwrapped as Record<string, unknown>
    // Tagged form (SessionNotFoundError with an explicit sessionID).
    if (value._tag === "SessionNotFoundError" && value.sessionID === sessionID) return true
    // Actual server 404 form: { name: "NotFoundError", data: { message: "Session not found: <id>" } }.
    const data = value.data
    const message =
      data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>).message : undefined
    if (
      value.name === "NotFoundError" &&
      typeof message === "string" &&
      /session not found/i.test(message) &&
      message.includes(sessionID)
    )
      return true
  }
  // Plain Error("Session not found: <id>") thrown by the session loader.
  if (
    error instanceof Error &&
    typeof error.message === "string" &&
    /session not found/i.test(error.message) &&
    error.message.includes(sessionID)
  )
    return true
  return false
}

function isConfigInvalidErrorLike(error: unknown): error is ConfigInvalidError {
  if (typeof error !== "object" || error === null) return false
  const o = error as Record<string, unknown>
  return o.name === "ConfigInvalidError" && typeof o.data === "object" && o.data !== null
}

function isProviderModelNotFoundErrorLike(error: unknown): error is ProviderModelNotFoundError {
  if (typeof error !== "object" || error === null) return false
  const o = error as Record<string, unknown>
  return o.name === "ProviderModelNotFoundError" && typeof o.data === "object" && o.data !== null
}

export function parseReadableConfigInvalidError(errorInput: ConfigInvalidError, translator?: Translator) {
  const file = errorInput.data.path && errorInput.data.path !== "config" ? errorInput.data.path : "config"
  const detail = errorInput.data.message?.trim() ?? ""
  const issues = (errorInput.data.issues ?? [])
    .map((issue) => {
      const msg = issue.message.trim()
      if (!issue.path.length) return msg
      return `${issue.path.join(".")}: ${msg}`
    })
    .filter(Boolean)
  const msg = issues.length ? issues.join("\n") : detail
  if (!msg) return tr(translator, "error.chain.configInvalid", `Config file at ${file} is invalid`, { path: file })
  return tr(translator, "error.chain.configInvalidWithMessage", `Config file at ${file} is invalid: ${msg}`, {
    path: file,
    message: msg,
  })
}

function parseReadableProviderModelNotFoundError(errorInput: ProviderModelNotFoundError, translator?: Translator) {
  const p = errorInput.data.providerID.trim()
  const m = errorInput.data.modelID.trim()
  const list = (errorInput.data.suggestions ?? []).map((v) => v.trim()).filter(Boolean)
  const body = tr(translator, "error.chain.modelNotFound", `Model not found: ${p}/${m}`, { provider: p, model: m })
  const tail = tr(translator, "error.chain.checkConfig", "Check your config (opencode.json) provider/model names")
  if (list.length) {
    const suggestions = list.slice(0, 5).join(", ")
    return [body, tr(translator, "error.chain.didYouMean", `Did you mean: ${suggestions}`, { suggestions }), tail].join(
      "\n",
    )
  }
  return [body, tail].join("\n")
}
