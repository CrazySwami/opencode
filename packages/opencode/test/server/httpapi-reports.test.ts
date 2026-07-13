import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { Session } from "@/session/session"
import { Database } from "@opencode-ai/core/database/database"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

// Personal daily-reports routes: fixtures when no feed is configured; a dead feed
// degrades to {ok:false} — never a 500.

const it = testEffect(Layer.mergeAll(Session.defaultLayer, Database.defaultLayer, httpApiLayer))

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  return response.json.pipe(Effect.map((value) => value as T))
}

const ENV = ["OPENCODE_REPORTS_URL", "OPENCODE_REPORTS_URL_MAP", "OPENCODE_REPORTS_TOKEN"] as const
const ORIGINAL = Object.fromEntries(ENV.map((k) => [k, process.env[k]]))

afterEach(async () => {
  for (const k of ENV) {
    if (ORIGINAL[k] === undefined) delete process.env[k]
    else process.env[k] = ORIGINAL[k]!
  }
  await disposeAllInstances()
})

describe("experimental daily reports (OpenBook)", () => {
  it.instance("no feed → fixtures, clearly source:'fixture'", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      for (const k of ENV) delete process.env[k]

      const list = yield* requestInDirectory("/experimental/reports/list", tmp.directory)
      expect(list.status).toBe(200)
      const lb = yield* json<{ ok: boolean; source: string; data: Array<{ id: string; date: string; body: string }> }>(list)
      expect(lb.ok).toBe(true)
      expect(lb.source).toBe("fixture")
      expect(lb.data.length).toBeGreaterThan(0)

      const first = lb.data[0]!.id
      const one = yield* json<{ ok: boolean; source: string }>(
        yield* requestInDirectory(`/experimental/reports/get/${first}`, tmp.directory),
      )
      expect(one.ok).toBe(true)
      expect(one.source).toBe("fixture")

      const missing = yield* requestInDirectory("/experimental/reports/get/nope", tmp.directory)
      expect(missing.status).toBe(200) // graceful, not 404/500
      const mb = yield* json<{ ok: boolean; error: string }>(missing)
      expect(mb.ok).toBe(false)
      expect(mb.error).toContain("not found")
    }),
  )

  it.instance("dead feed URL → graceful {ok:false, offline}, HTTP 200", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      process.env.OPENCODE_REPORTS_URL = "http://127.0.0.1:1"

      const res = yield* requestInDirectory("/experimental/reports/list", tmp.directory)
      expect(res.status).toBe(200)
      const body = yield* json<{ ok: boolean; source: string; error: string }>(res)
      expect(body.ok).toBe(false)
      expect(body.source).toBe("live")
      expect(body.error).toContain("offline")
    }),
  )
})
