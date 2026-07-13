import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { Session } from "@/session/session"
import { Database } from "@opencode-ai/core/database/database"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

// /experimental/browser/status must always return HTTP 200 with a graceful shape
// so a down neko/Steel/ttyd stack degrades instead of throwing.

const it = testEffect(Layer.mergeAll(Session.defaultLayer, Database.defaultLayer, httpApiLayer))

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  return response.json.pipe(Effect.map((value) => value as T))
}

const ENV = ["OPENCODE_NEKO_CDP_URL", "OPENCODE_NEKO_URL", "OPENCODE_STEEL_URL", "OPENCODE_TTYD_URL"] as const
const ORIGINAL = Object.fromEntries(ENV.map((k) => [k, process.env[k]]))

afterEach(async () => {
  for (const k of ENV) {
    if (ORIGINAL[k] === undefined) delete process.env[k]
    else process.env[k] = ORIGINAL[k]!
  }
  await disposeAllInstances()
})

describe("experimental browser stack status (neko + Steel + ttyd)", () => {
  it.instance("nothing configured → HTTP 200, ok:false, each service clearly not-configured", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      for (const k of ENV) delete process.env[k]

      const res = yield* requestInDirectory("/experimental/browser/status", tmp.directory)
      expect(res.status).toBe(200) // graceful, never 500
      const body = yield* json<{
        ok: boolean
        neko: { ok: boolean; error?: string }
        steel: { ok: boolean; error?: string }
        ttyd: { ok: boolean; url: string | null }
      }>(res)
      expect(body.ok).toBe(false)
      expect(body.neko.ok).toBe(false)
      expect(body.neko.error).toContain("not configured")
      expect(body.steel.ok).toBe(false)
      expect(body.ttyd.ok).toBe(false)
      expect(body.ttyd.url).toBeNull()
    }),
  )

  it.instance("dead neko/steel/ttyd URLs → HTTP 200, ok:false, offline (no throw)", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      process.env.OPENCODE_NEKO_CDP_URL = "http://127.0.0.1:1"
      process.env.OPENCODE_STEEL_URL = "http://127.0.0.1:1"
      process.env.OPENCODE_TTYD_URL = "http://127.0.0.1:1"

      const res = yield* requestInDirectory("/experimental/browser/status", tmp.directory)
      expect(res.status).toBe(200)
      const body = yield* json<{ ok: boolean; neko: { ok: boolean }; steel: { ok: boolean }; ttyd: { ok: boolean } }>(res)
      expect(body.ok).toBe(false)
      expect(body.neko.ok).toBe(false)
      expect(body.steel.ok).toBe(false)
      expect(body.ttyd.ok).toBe(false)
    }),
  )
})
