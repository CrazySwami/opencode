import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { ServerConnection } from "@/context/server"
import { decode64 } from "@/utils/base64"

export function authTokenFromCredentials(input: { username?: string; password: string }) {
  return btoa(`${input.username ?? "opencode"}:${input.password}`)
}

export function authFromToken(token: string | null) {
  const decoded = decode64(token ?? undefined)
  if (!decoded) return
  const separator = decoded.indexOf(":")
  if (separator === -1) return
  return {
    username: decoded.slice(0, separator) || "opencode",
    password: decoded.slice(separator + 1),
  }
}

// Retry transient gateway failures (502/503/504) and network errors for safe
// methods instead of surfacing them. A full opencode restart is a 6-40s outage
// (memory-growth watchdog recycle), not the ~1s proxy blip this originally
// targeted — so the budget spans ~40s of wall time with capped exponential
// backoff + jitter, enough to bridge a real backend restart. Only idempotent
// GET/HEAD are retried; non-idempotent methods pass straight through so a POST
// is never silently duplicated. If the budget is exhausted the last 502/error is
// returned, and callers (e.g. loadSessions) treat it as a transient/soft failure
// rather than a hard error toast.
const TRANSIENT_STATUS = new Set([502, 503, 504])
const RETRY_BUDGET_MS = 40_000
const RETRY_BACKOFF_CAP_MS = 4_000

function withTransientRetry<F extends (input: any, init?: any) => Promise<Response>>(base: F): F {
  const wrapped = async (input: any, init?: any): Promise<Response> => {
    const method = String(
      init?.method ?? (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET"),
    ).toUpperCase()
    if (method !== "GET" && method !== "HEAD") return base(input, init)
    const deadline = Date.now() + RETRY_BUDGET_MS
    let lastResponse: Response | undefined
    let lastError: unknown
    for (let attempt = 0; ; attempt++) {
      if (attempt > 0) {
        if (Date.now() >= deadline) break
        // Exponential backoff (400ms → cap 4s) with ±25% jitter to avoid a
        // thundering herd of reconnecting tabs hitting the box as it comes back.
        const backoff = Math.min(400 * 2 ** (attempt - 1), RETRY_BACKOFF_CAP_MS)
        const delay = backoff * (0.75 + Math.random() * 0.5)
        await new Promise((resolve) => setTimeout(resolve, Math.min(delay, Math.max(0, deadline - Date.now()))))
      }
      try {
        const response = await base(input, init)
        if (!TRANSIENT_STATUS.has(response.status)) return response
        lastResponse = response
      } catch (error) {
        lastError = error
      }
    }
    if (lastResponse) return lastResponse
    throw lastError
  }
  return wrapped as F
}

export function createSdkForServer({
  server,
  ...config
}: Omit<NonNullable<Parameters<typeof createOpencodeClient>[0]>, "baseUrl"> & {
  server: ServerConnection.HttpBase
}) {
  const auth = (() => {
    if (!server.password) return
    return {
      Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
    }
  })()

  const baseFetch = (config.fetch ?? ((input: any, init?: any) => globalThis.fetch(input, init))) as (
    input: any,
    init?: any,
  ) => Promise<Response>

  return createOpencodeClient({
    ...config,
    fetch: withTransientRetry(baseFetch) as NonNullable<Parameters<typeof createOpencodeClient>[0]>["fetch"],
    headers: {
      ...(config.headers instanceof Headers ? Object.fromEntries(config.headers.entries()) : config.headers),
      ...auth,
    },
    baseUrl: server.url,
  })
}
