import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { Session } from "@/session/session"
import { Database } from "@opencode-ai/core/database/database"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

// Handler contracts under test live in
//   src/server/routes/instance/httpapi/server.ts (~lines 3133–3278)
// These are graceful-degradation proxies over local daemons whose base URLs are
// read from env AT REQUEST TIME, so each branch (offline / reachable-5xx /
// reachable-ok) is forced deterministically by pointing the env at a dead port
// or a throwaway Bun stub server.

const it = testEffect(Layer.mergeAll(Session.defaultLayer, Database.defaultLayer, httpApiLayer))

function request(path: string, directory: string, init: RequestInit = {}) {
  return requestInDirectory(path, directory, init)
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  return response.json.pipe(Effect.map((value) => value as T))
}

// --- env + stub-server lifecycle -------------------------------------------

const ENV_KEYS = [
  "OPENCODE_TOKEN_MAXING_URL",
  "OPENCODE_TOKEN_MAXING_TOKEN",
  "OPENCODE_FLEET_URL",
  "OPENCODE_AUTO_IMPROVE_URL",
  "OPENCODE_OD_URL",
  "OPENCODE_MCP_REGISTRY_URL",
] as const

const ORIGINAL_ENV: Record<string, string | undefined> = {}
for (const key of ENV_KEYS) ORIGINAL_ENV[key] = process.env[key]

const liveServers: Array<{ stop: (closeActiveConnections?: boolean) => unknown }> = []

afterEach(async () => {
  for (const server of liveServers.splice(0)) {
    try {
      await server.stop(true)
    } catch {
      // already stopped
    }
  }
  for (const key of ENV_KEYS) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key]
    else process.env[key] = ORIGINAL_ENV[key]
  }
  await disposeAllInstances()
})

// A URL whose port had a server that is now stopped → connection refused fast.
async function deadDaemonUrl(): Promise<string> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("x") })
  const port = server.port
  await server.stop(true)
  return `http://127.0.0.1:${port}`
}

// A live stub daemon that returns the given status + JSON payload.
function stubDaemon(status: number, payload: unknown): string {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      }),
  })
  liveServers.push(server)
  return `http://127.0.0.1:${server.port}`
}

// A live stub daemon that returns the given status + JSON payload, invoking
// `onRequest` with the incoming Request so callers can inspect headers.
function stubDaemonCapture(status: number, payload: unknown, onRequest: (req: Request) => void): string {
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      onRequest(req)
      return new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      })
    },
  })
  liveServers.push(server)
  return `http://127.0.0.1:${server.port}`
}

// --- token-maxing/usage -----------------------------------------------------

describe("experimental daemon-proxy HttpApi", () => {
  it.instance("token-maxing/usage: daemon offline → ok:false, empty snapshots, 200", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      process.env.OPENCODE_TOKEN_MAXING_URL = yield* Effect.promise(deadDaemonUrl)
      const res = yield* request("/experimental/token-maxing/usage", tmp.directory)
      expect(res.status).toBe(200)
      const body = yield* json<{ ok: boolean; error: string; snapshots: unknown[] }>(res)
      expect(body.ok).toBe(false)
      expect(body.error).toContain("offline")
      expect(body.snapshots).toEqual([])
    }),
  )

  it.instance("token-maxing/usage: daemon 500 → ok:false, error mentions status", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      process.env.OPENCODE_TOKEN_MAXING_URL = stubDaemon(500, { boom: true })
      const res = yield* request("/experimental/token-maxing/usage", tmp.directory)
      expect(res.status).toBe(200)
      const body = yield* json<{ ok: boolean; error: string; snapshots: unknown[] }>(res)
      expect(body.ok).toBe(false)
      expect(body.error).toContain("(500)")
      expect(body.snapshots).toEqual([])
    }),
  )

  it.instance("token-maxing/usage: daemon ok → ok:true + merged fields", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      process.env.OPENCODE_TOKEN_MAXING_URL = stubDaemon(200, { snapshots: [{ id: "a" }], marker: "xyz" })
      const res = yield* request("/experimental/token-maxing/usage", tmp.directory)
      expect(res.status).toBe(200)
      const body = yield* json<{ ok: boolean; marker: string; snapshots: unknown[] }>(res)
      expect(body.ok).toBe(true)
      expect(body.marker).toBe("xyz")
      expect(body.snapshots).toEqual([{ id: "a" }])
    }),
  )

  // --- fleet/sessions -------------------------------------------------------

  it.instance("fleet/sessions: daemon offline → ok:false, empty sessions, count 0", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      process.env.OPENCODE_FLEET_URL = yield* Effect.promise(deadDaemonUrl)
      const res = yield* request("/experimental/fleet/sessions", tmp.directory)
      expect(res.status).toBe(200)
      const body = yield* json<{ ok: boolean; error: string; sessions: unknown[]; count: number }>(res)
      expect(body.ok).toBe(false)
      expect(body.error).toContain("offline")
      expect(body.sessions).toEqual([])
      expect(body.count).toBe(0)
    }),
  )

  it.instance("fleet/sessions: daemon 503 → ok:false, error mentions status", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      process.env.OPENCODE_FLEET_URL = stubDaemon(503, {})
      const res = yield* request("/experimental/fleet/sessions", tmp.directory)
      const body = yield* json<{ ok: boolean; error: string }>(res)
      expect(body.ok).toBe(false)
      expect(body.error).toContain("(503)")
    }),
  )

  it.instance("fleet/sessions: daemon ok → ok:true + merged sessions", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      process.env.OPENCODE_FLEET_URL = stubDaemon(200, { sessions: [{ id: "s1" }], count: 1 })
      const res = yield* request("/experimental/fleet/sessions", tmp.directory)
      const body = yield* json<{ ok: boolean; sessions: unknown[]; count: number }>(res)
      expect(body.ok).toBe(true)
      expect(body.sessions).toEqual([{ id: "s1" }])
      expect(body.count).toBe(1)
    }),
  )

  // --- auto-improve/status --------------------------------------------------

  it.instance("auto-improve/status: daemon offline → ok:false, empty projects", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      process.env.OPENCODE_AUTO_IMPROVE_URL = yield* Effect.promise(deadDaemonUrl)
      const res = yield* request("/experimental/auto-improve/status", tmp.directory)
      expect(res.status).toBe(200)
      const body = yield* json<{ ok: boolean; error: string; projects: unknown[] }>(res)
      expect(body.ok).toBe(false)
      expect(body.error).toContain("offline")
      expect(body.projects).toEqual([])
    }),
  )

  it.instance("auto-improve/status: daemon ok → ok:true + merged projects", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      process.env.OPENCODE_AUTO_IMPROVE_URL = stubDaemon(200, { projects: [{ id: "p1" }] })
      const res = yield* request("/experimental/auto-improve/status", tmp.directory)
      const body = yield* json<{ ok: boolean; projects: unknown[] }>(res)
      expect(body.ok).toBe(true)
      expect(body.projects).toEqual([{ id: "p1" }])
    }),
  )

  // --- token-maxing/switch (operator-token gated) ---------------------------

  it.instance("token-maxing/switch: no operator token → 403 not configured", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      delete process.env.OPENCODE_TOKEN_MAXING_TOKEN
      const res = yield* request("/experimental/token-maxing/switch", tmp.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adapterId: "x" }),
      })
      expect(res.status).toBe(403)
      const body = yield* json<{ ok: boolean; error: string }>(res)
      expect(body.ok).toBe(false)
      expect(body.error).toContain("not configured")
    }),
  )

  it.instance("token-maxing/switch: token set + malformed JSON → 400", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      process.env.OPENCODE_TOKEN_MAXING_TOKEN = "operator-secret"
      const res = yield* request("/experimental/token-maxing/switch", tmp.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      })
      expect(res.status).toBe(400)
      const body = yield* json<{ ok: boolean; error: string }>(res)
      expect(body.ok).toBe(false)
      expect(body.error).toContain("invalid JSON body")
    }),
  )

  it.instance("token-maxing/switch: token set + daemon offline → 502", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      process.env.OPENCODE_TOKEN_MAXING_TOKEN = "operator-secret"
      process.env.OPENCODE_TOKEN_MAXING_URL = yield* Effect.promise(deadDaemonUrl)
      const res = yield* request("/experimental/token-maxing/switch", tmp.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adapterId: "openai-api" }),
      })
      expect(res.status).toBe(502)
      const body = yield* json<{ ok: boolean; error: string }>(res)
      expect(body.ok).toBe(false)
      expect(body.error).toContain("offline")
    }),
  )

  it.instance("token-maxing/switch: token set + daemon ok → 200, ok:true + merged decision", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      process.env.OPENCODE_TOKEN_MAXING_TOKEN = "operator-secret"
      process.env.OPENCODE_TOKEN_MAXING_URL = stubDaemon(200, {
        ok: true,
        decision: { fromAdapterId: "glm-sub:x", toAdapterId: "glm-sub:y", reason: "rotating" },
      })
      const res = yield* request("/experimental/token-maxing/switch", tmp.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adapterId: "glm-sub:x" }),
      })
      expect(res.status).toBe(200)
      const body = yield* json<{ ok: boolean; decision: { toAdapterId: string } }>(res)
      expect(body.ok).toBe(true)
      expect(body.decision.toAdapterId).toBe("glm-sub:y")
    }),
  )

  it.instance("token-maxing/switch: forwards x-operator-token to daemon, never echoes it back", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      process.env.OPENCODE_TOKEN_MAXING_TOKEN = "operator-secret"
      const captured: { token: string | null } = { token: null }
      process.env.OPENCODE_TOKEN_MAXING_URL = stubDaemonCapture(200, { ok: true, decision: { toAdapterId: "glm-sub:y" } }, (req) => {
        captured.token = req.headers.get("x-operator-token")
      })
      const res = yield* request("/experimental/token-maxing/switch", tmp.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adapterId: "glm-sub:x" }),
      })
      expect(res.status).toBe(200)
      const body = yield* json<Record<string, unknown>>(res)
      expect(captured.token).toBe("operator-secret")
      expect(JSON.stringify(body)).not.toMatch(/operator-secret/)
    }),
  )

  // --- mcp/registry + skills (OD-daemon fallback to local seed) -------------

  it.instance("mcp/registry: OD offline → 200, ok:true, seed catalog served", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      process.env.OPENCODE_OD_URL = yield* Effect.promise(deadDaemonUrl)
      // Also force the official-registry fallback offline (dead port) so this
      // test deterministically exercises the last-resort hardcoded seed
      // regardless of real network reachability in the test environment. The
      // live-registry fallback itself is covered in
      // test/server/httpapi-mcp-registry.test.ts.
      process.env.OPENCODE_MCP_REGISTRY_URL = yield* Effect.promise(deadDaemonUrl)
      const res = yield* request("/experimental/mcp/registry", tmp.directory)
      expect(res.status).toBe(200)
      const body = yield* json<{ ok: boolean; source: string; servers: Array<{ name: string }> }>(res)
      expect(body.ok).toBe(true)
      expect(body.source).toBe("seed")
      expect(body.servers.map((s) => s.name)).toContain("github")
    }),
  )

  it.instance("skills: OD offline → 200, ok:true, arrays present", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      process.env.OPENCODE_OD_URL = yield* Effect.promise(deadDaemonUrl)
      const res = yield* request("/experimental/skills", tmp.directory)
      expect(res.status).toBe(200)
      const body = yield* json<{ ok: boolean; roots: unknown[]; skills: unknown[] }>(res)
      expect(body.ok).toBe(true)
      expect(Array.isArray(body.roots)).toBe(true)
      expect(Array.isArray(body.skills)).toBe(true)
    }),
  )
})
