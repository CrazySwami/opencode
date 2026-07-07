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

// Retry transient gateway failures (502/503/504 — e.g. the ~1s window while the
// server restarts) for safe methods instead of surfacing them. Without this, one
// blipped GET during boot threw the raw Cloudflare HTML into the app error
// boundary and crashed the whole app to "Something went wrong".
function withTransientRetry<F extends (input: any, init?: any) => Promise<Response>>(base: F): F {
  const wrapped = async (input: any, init?: any): Promise<Response> => {
    const method = String(
      init?.method ?? (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET"),
    ).toUpperCase()
    if (method !== "GET" && method !== "HEAD") return base(input, init)
    let lastResponse: Response | undefined
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 400 * attempt))
      try {
        const response = await base(input, init)
        if (response.status !== 502 && response.status !== 503 && response.status !== 504) return response
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
