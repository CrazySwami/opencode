import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { Session } from "@/session/session"
import { Database } from "@opencode-ai/core/database/database"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

// Read-only Trellis bridge routes. With no OPENCODE_TRELLIS_URL they serve
// deterministic fixtures (source:"fixture"); a dead URL degrades to
// {ok:false, error:"…offline"} — never a 500. (Malformed-live handling is
// covered by the client unit test, test/trellis/client.test.ts.)

const it = testEffect(Layer.mergeAll(Session.defaultLayer, Database.defaultLayer, httpApiLayer))

function request(path: string, directory: string, init: RequestInit = {}) {
  return requestInDirectory(path, directory, init)
}
function json<T>(response: HttpClientResponse.HttpClientResponse) {
  return response.json.pipe(Effect.map((value) => value as T))
}

const ENV_KEYS = ["OPENCODE_TRELLIS_URL", "OPENCODE_TRELLIS_URL_MAP", "OPENCODE_TRELLIS_TOKEN"] as const
const ORIGINAL = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
function clearTrellisEnv() {
  for (const k of ENV_KEYS) delete process.env[k]
}

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (ORIGINAL[k] === undefined) delete process.env[k]
    else process.env[k] = ORIGINAL[k]!
  }
  await disposeAllInstances()
})

describe("experimental Trellis bridge (read-only)", () => {
  it.instance("no URL → fixtures, clearly source:'fixture'", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      clearTrellisEnv()

      const health = yield* request("/experimental/trellis/health", tmp.directory)
      expect(health.status).toBe(200)
      const hb = yield* json<{ ok: boolean; source: string; data: { runtime: string } }>(health)
      expect(hb.ok).toBe(true)
      expect(hb.source).toBe("fixture")
      expect(hb.data.runtime).toBe("langgraph")

      const runs = yield* json<{ ok: boolean; source: string; data: unknown[] }>(
        yield* request("/experimental/trellis/runs", tmp.directory),
      )
      expect(runs.ok).toBe(true)
      expect(runs.source).toBe("fixture")
      expect(runs.data.length).toBeGreaterThan(0)

      const agents = yield* json<{ ok: boolean; data: Array<{ id: string }> }>(
        yield* request("/experimental/trellis/agents", tmp.directory),
      )
      expect(agents.data.some((a) => a.id === "armando")).toBe(true)
    }),
  )

  it.instance("run/:id + report known → fixture; unknown → ok:false (no 500)", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      clearTrellisEnv()

      const known = yield* json<{ ok: boolean; source: string }>(
        yield* request("/experimental/trellis/run/run_001", tmp.directory),
      )
      expect(known.ok).toBe(true)
      expect(known.source).toBe("fixture")

      const missing = yield* request("/experimental/trellis/run/nope", tmp.directory)
      expect(missing.status).toBe(200) // graceful, not a 404/500
      const mb = yield* json<{ ok: boolean; error: string }>(missing)
      expect(mb.ok).toBe(false)
      expect(mb.error).toContain("not found")

      const report = yield* json<{ ok: boolean }>(yield* request("/experimental/trellis/report/run_001", tmp.directory))
      expect(report.ok).toBe(true)
    }),
  )

  it.instance("dead Trellis URL → graceful {ok:false, offline}, HTTP 200", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      clearTrellisEnv()
      process.env.OPENCODE_TRELLIS_URL = "http://127.0.0.1:1" // guaranteed-refused

      const res = yield* request("/experimental/trellis/runs", tmp.directory)
      expect(res.status).toBe(200)
      const body = yield* json<{ ok: boolean; source: string; error: string }>(res)
      expect(body.ok).toBe(false)
      expect(body.source).toBe("live")
      expect(body.error).toContain("offline")
    }),
  )
})
