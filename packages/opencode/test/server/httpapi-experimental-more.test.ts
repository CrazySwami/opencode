import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { Session } from "@/session/session"
import { Database } from "@opencode-ai/core/database/database"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

// Handler contracts under test live in
//   src/server/routes/instance/httpapi/server.ts
//     - GET  /experimental/image/providers            (~line 993)
//     - GET  /experimental/home-chat/projects          (~line 1335, odHomeChatProjects ~1290)
//     - POST /experimental/fleet/continue/:cli/:id     (~line 3283, fleetContinueResponse ~1245)
//     - GET  /experimental/workspace-tabs/status       (~line 3045)
//     - GET  /experimental/workspace-tabs/pending      (~line 3070)
// The last two delegate to pure, in-memory functions in src/tool/workspace-tabs.ts
// that hold module-level state (no HTTP/daemon I/O), so they're deterministic as
// long as nothing in this process mutates that state first -- this file never
// POSTs to /workspace-tabs/action|client-state|ack, so that holds.

const it = testEffect(Layer.mergeAll(Session.defaultLayer, Database.defaultLayer, httpApiLayer))

function request(path: string, directory: string, init: RequestInit = {}) {
  return requestInDirectory(path, directory, init)
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  return response.json.pipe(Effect.map((value) => value as T))
}

// --- env + stub-server lifecycle -------------------------------------------
//
// image/providers reads OPENCODE_IMAGE_HUB_URL (default 127.0.0.1:8766) plus
// RECRAFT_API_KEY/GEMINI_API_KEY presence; home-chat/projects and fleet/continue
// read OPENCODE_OD_URL / OPENCODE_FLEET_URL. All forced at request time so the
// tests never depend on -- or race with -- anything actually listening on those
// default ports on the host.

const ENV_KEYS = [
  "OPENCODE_IMAGE_HUB_URL",
  "RECRAFT_API_KEY",
  "GEMINI_API_KEY",
  "OPENCODE_OD_URL",
  "OPENCODE_FLEET_URL",
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

// --- image/providers ---------------------------------------------------

describe("experimental HttpApi (more routes)", () => {
  it.instance("image/providers: local unreachable, no keys → 200 with id/url/reachable + configured shape", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      process.env.OPENCODE_IMAGE_HUB_URL = yield* Effect.promise(deadDaemonUrl)
      delete process.env.RECRAFT_API_KEY
      delete process.env.GEMINI_API_KEY
      const res = yield* request("/experimental/image/providers", tmp.directory)
      expect(res.status).toBe(200)
      const body = yield* json<{
        local: { id: string; reachable: boolean; url: string }
        recraft: { id: string; configured: boolean }
        gemini: { id: string; configured: boolean }
      }>(res)
      expect(body.local.id).toBe("local")
      expect(body.local.reachable).toBe(false)
      expect(typeof body.local.url).toBe("string")
      expect(body.recraft).toEqual({ id: "recraft", configured: false })
      expect(body.gemini).toEqual({ id: "gemini", configured: false })
    }),
  )

  it.instance("image/providers: RECRAFT_API_KEY set → recraft.configured true", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      process.env.OPENCODE_IMAGE_HUB_URL = yield* Effect.promise(deadDaemonUrl)
      process.env.RECRAFT_API_KEY = "test-key-123"
      delete process.env.GEMINI_API_KEY
      const res = yield* request("/experimental/image/providers", tmp.directory)
      expect(res.status).toBe(200)
      const body = yield* json<{ recraft: { configured: boolean } }>(res)
      expect(body.recraft.configured).toBe(true)
    }),
  )

  // --- home-chat/projects (OD daemon proxy) -------------------------------

  it.instance("home-chat/projects: OD offline → ok:false, error, empty projects, 200", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      process.env.OPENCODE_OD_URL = yield* Effect.promise(deadDaemonUrl)
      const res = yield* request("/experimental/home-chat/projects", tmp.directory)
      expect(res.status).toBe(200)
      const body = yield* json<{ ok: boolean; error: string; projects: unknown[] }>(res)
      expect(body.ok).toBe(false)
      expect(body.error).toBe("OpenDesign offline")
      expect(body.projects).toEqual([])
    }),
  )

  it.instance("home-chat/projects: OD 500 → ok:false, error, empty projects (reachable-but-erroring)", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      process.env.OPENCODE_OD_URL = stubDaemon(500, { boom: true })
      const res = yield* request("/experimental/home-chat/projects", tmp.directory)
      expect(res.status).toBe(200)
      const body = yield* json<{ ok: boolean; error: string; projects: unknown[] }>(res)
      expect(body.ok).toBe(false)
      expect(body.error).toBe("OpenDesign offline")
      expect(body.projects).toEqual([])
    }),
  )

  it.instance("home-chat/projects: OD ok → ok:true, maps id/name/baseDir from metadata", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      process.env.OPENCODE_OD_URL = stubDaemon(200, {
        projects: [
          { id: "p1", name: "Project One", metadata: { baseDir: "/tmp/p1" } },
          { id: "p2" },
        ],
      })
      const res = yield* request("/experimental/home-chat/projects", tmp.directory)
      expect(res.status).toBe(200)
      const body = yield* json<{
        ok: boolean
        daemon: string
        projects: Array<{ id: string; name: string; baseDir: string | null }>
      }>(res)
      expect(body.ok).toBe(true)
      expect(body.projects).toEqual([
        { id: "p1", name: "Project One", baseDir: "/tmp/p1" },
        { id: "p2", name: "Untitled", baseDir: null },
      ])
    }),
  )

  // --- fleet/continue/:cli/:id --------------------------------------------
  // Only the daemon-offline branch is exercised here (see the "SKIPPED"
  // notes below for why the two validation-error branches are dead code
  // through the real router and thus untestable at the HTTP layer).

  it.instance("fleet/continue: daemon offline → SSE error event, no hang", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      process.env.OPENCODE_FLEET_URL = yield* Effect.promise(deadDaemonUrl)
      const res = yield* request("/experimental/fleet/continue/claude/session-1", tmp.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "hi" }),
      })
      const text = yield* res.text
      expect(text).toContain("event: error")
      expect(text).toContain("fleet service offline")
    }),
  )

  // --- workspace-tabs: status / pending (pure, in-memory, no daemon I/O) --

  it.instance("workspace-tabs/status: 200 + registry shape (no client state yet)", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const res = yield* request("/experimental/workspace-tabs/status", tmp.directory)
      expect(res.status).toBe(200)
      const body = yield* json<{
        ok: boolean
        registryVersion: number
        activeStateSource: string
        clientState: unknown
        pendingActions: unknown[]
        tabs: Array<{ id: string }>
        contracts: { clientCanOpenTabs: boolean; serverCanRequestTabs: boolean }
      }>(res)
      expect(body.ok).toBe(true)
      expect(typeof body.registryVersion).toBe("number")
      expect(Array.isArray(body.pendingActions)).toBe(true)
      expect(Array.isArray(body.tabs)).toBe(true)
      expect(body.tabs.length).toBeGreaterThan(0)
      expect(body.contracts.clientCanOpenTabs).toBe(true)
      expect(body.contracts.serverCanRequestTabs).toBe(true)
    }),
  )

  it.instance("workspace-tabs/pending: 200 + ok:true, empty actions with no sessionID/clientID", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const res = yield* request("/experimental/workspace-tabs/pending", tmp.directory)
      expect(res.status).toBe(200)
      const body = yield* json<{ ok: boolean; sessionID: string | null; clientID: string | null; actions: unknown[] }>(
        res,
      )
      expect(body.ok).toBe(true)
      expect(body.sessionID).toBeNull()
      expect(body.clientID).toBeNull()
      expect(Array.isArray(body.actions)).toBe(true)
    }),
  )
})

// SKIPPED, with reasons:
// - /experimental/fleet/continue reachable-daemon success path: relays a live
//   SSE byte stream from the fleet daemon (Stream.fromAsyncIterable over a
//   fetch() reader) -- exercising it deterministically would mean building a
//   miniature SSE-speaking stub and asserting on streamed chunk timing, which
//   is exactly the "streaming, non-deterministic" case the task says to skip.
// - fleet/continue "Missing cli/id" 400 branch: unreachable through the real
//   router, since the router only invokes this handler for paths that already
//   structurally match /experimental/fleet/continue/:cli/:id (two segments
//   present). The regex re-match inside the handler can't fail to find them.
// - fleet/continue "Malformed cli/id" 400 branch (decodeURIComponent throwing
//   in the handler): empirically unreachable through the real HTTP layer.
//   The underlying router is find-my-way (effect/unstable/http/HttpRouter),
//   whose own dispatch calls decodeURI() on the *entire* raw path first
//   (lib/url-sanitizer.js's safeDecodeURI) for any "%XX" sequence that isn't
//   one of its whitelisted reserved-char codes (# $ & + , / : ; = ? @ %).
//   Any percent-sequence malformed enough to later break the handler's own
//   decodeURIComponent(m[1]/m[2]) is, by the same token, malformed enough to
//   break that upstream decodeURI() call too -- which find-my-way catches
//   and turns into a plain 404 (RouteNotFound) before the handler ever runs.
//   Verified directly: requesting
//   POST /experimental/fleet/continue/%E0/session-1 (a lone invalid UTF-8
//   lead byte) returns 404, not 400 -- confirming the handler's catch branch
//   is dead code given the current router. Left uncovered rather than
//   asserting a 404 that would silently pass if the router's decode
//   behavior changes and the branch became reachable (a false-negative risk
//   worse than no test).
// - /experimental/workspace-tabs/client-state: this is a POST that mutates
//   shared module-level state (tool/workspace-tabs.ts's `latestClientState`
//   and `latestClientStateBySession` singletons), not a "simple GET returning
//   JSON" per the task's own qualifier -- and touching it here would leak
//   state into the /status and /pending assertions above (order-dependent).
