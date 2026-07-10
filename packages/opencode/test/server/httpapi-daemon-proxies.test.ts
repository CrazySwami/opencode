// Route tests for the daemon-proxy endpoints added for the central-dashboard
// tabs (token-maxing, fleet, auto-improve). The daemons are NOT running in the
// test env and the URL envs are pointed at a dead port, so these assert the
// GRACEFUL offline / refused shapes each proxy must return (never a dead socket
// or ok:true on a broken daemon).
import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { Session } from "@/session/session"
import { Database } from "@opencode-ai/core/database/database"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, Database.defaultLayer, httpApiLayer))

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  return response.json.pipe(Effect.map((value) => value as T))
}

// A definitely-closed address so each proxy takes its offline branch fast.
const DEAD = "http://127.0.0.1:1"

beforeEach(() => {
  process.env.OPENCODE_TOKEN_MAXING_URL = DEAD
  process.env.OPENCODE_FLEET_URL = DEAD
  process.env.OPENCODE_AUTO_IMPROVE_URL = DEAD
  delete process.env.OPENCODE_TOKEN_MAXING_TOKEN
})

afterEach(async () => {
  delete process.env.OPENCODE_TOKEN_MAXING_URL
  delete process.env.OPENCODE_FLEET_URL
  delete process.env.OPENCODE_AUTO_IMPROVE_URL
  await disposeAllInstances()
  await resetDatabase()
})

describe("daemon-proxy experimental routes", () => {
  it.instance("token-maxing/usage returns a graceful offline shape", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const res = yield* requestInDirectory("/experimental/token-maxing/usage", tmp.directory)
      expect(res.status).toBe(200)
      const body = yield* json<any>(res)
      expect(body.ok).toBe(false)
      expect(String(body.error)).toContain("offline")
      expect(body.snapshots).toEqual([])
    }),
  )

  it.instance("token-maxing/switch is refused (403) when no operator token is configured", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const res = yield* requestInDirectory("/experimental/token-maxing/switch", tmp.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adapterId: "openai-sub:1" }),
      })
      expect(res.status).toBe(403)
      const body = yield* json<any>(res)
      expect(body.ok).toBe(false)
      expect(String(body.error)).toContain("not configured")
    }),
  )

  it.instance("fleet/sessions returns a graceful offline shape", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const res = yield* requestInDirectory("/experimental/fleet/sessions", tmp.directory)
      expect(res.status).toBe(200)
      const body = yield* json<any>(res)
      expect(body.ok).toBe(false)
      expect(String(body.error)).toContain("offline")
      expect(body.sessions).toEqual([])
    }),
  )

  it.instance("auto-improve/status returns a graceful offline shape", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const res = yield* requestInDirectory("/experimental/auto-improve/status", tmp.directory)
      expect(res.status).toBe(200)
      const body = yield* json<any>(res)
      expect(body.ok).toBe(false)
      expect(String(body.error)).toContain("offline")
      expect(body.projects).toEqual([])
    }),
  )
})
