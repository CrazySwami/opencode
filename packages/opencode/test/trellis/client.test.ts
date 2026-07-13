import { afterEach, describe, expect, test } from "bun:test"
import { TrellisRemoteClient, trellisConfigured } from "../../src/trellis/client"

const ENV = ["OPENCODE_TRELLIS_URL", "OPENCODE_TRELLIS_URL_MAP", "OPENCODE_TRELLIS_TOKEN"] as const
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]])) as Record<(typeof ENV)[number], string | undefined>
const realFetch = globalThis.fetch

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  globalThis.fetch = realFetch
})

function clearEnv() {
  for (const k of ENV) delete process.env[k]
}
function stubFetch(status: number, body: unknown, capture?: (url: string, init?: RequestInit) => void) {
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    capture?.(String(url), init)
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
}

describe("TrellisRemoteClient — fixtures-first (no URL)", () => {
  test("health/agents/runs return fixture data, clearly source:'fixture'", async () => {
    clearEnv()
    const c = new TrellisRemoteClient()
    expect(trellisConfigured()).toBe(false)
    const h = await c.health()
    expect(h).toMatchObject({ ok: true, source: "fixture" })
    if (h.ok) expect(h.data.runtime).toBe("langgraph")
    const a = await c.listAgents()
    expect(a.ok && a.source === "fixture" && a.data.some((x) => x.id === "armando")).toBe(true)
    const r = await c.listRuns()
    expect(r.ok && r.source === "fixture" && r.data.length).toBeTruthy()
  })

  test("getRun/getReport known → fixture; unknown → ok:false (never throws)", async () => {
    clearEnv()
    const c = new TrellisRemoteClient()
    expect((await c.getRun("run_001")).ok).toBe(true)
    const miss = await c.getRun("nope")
    expect(miss.ok).toBe(false)
    if (!miss.ok) expect(miss.error).toContain("not found")
    expect((await c.getReport("run_001")).ok).toBe(true)
    expect((await c.getReport("nope")).ok).toBe(false)
  })
})

describe("TrellisRemoteClient — live (URL set)", () => {
  test("200 → live data, source:'live', and forwards Bearer token (never echoed)", async () => {
    clearEnv()
    process.env.OPENCODE_TRELLIS_URL = "http://trellis.local"
    process.env.OPENCODE_TRELLIS_TOKEN = "tk-secret-should-not-leak"
    let seenAuth: string | undefined
    stubFetch(200, { status: "ok", version: "9", runtime: "langgraph", checkedAt: "2026-07-12T00:00:00Z" }, (_u, init) => {
      seenAuth = new Headers(init?.headers as any).get("authorization") ?? undefined
    })
    const res = await new TrellisRemoteClient().health()
    expect(res).toMatchObject({ ok: true, source: "live" })
    if (res.ok) expect(res.data.version).toBe("9")
    expect(seenAuth).toBe("Bearer tk-secret-should-not-leak") // sent to Trellis…
    expect(JSON.stringify(res)).not.toMatch(/tk-secret/) // …but never in the result
  })

  test("malformed live JSON → ok:false, cannot corrupt state", async () => {
    clearEnv()
    process.env.OPENCODE_TRELLIS_URL = "http://trellis.local"
    stubFetch(200, { nonsense: true }) // missing required 'status'
    const res = await new TrellisRemoteClient().health()
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain("malformed")
  })

  test("5xx → ok:false; 401/403 → 'not configured'", async () => {
    clearEnv()
    process.env.OPENCODE_TRELLIS_URL = "http://trellis.local"
    stubFetch(503, {})
    expect((await new TrellisRemoteClient().listRuns()).ok).toBe(false)
    stubFetch(401, {})
    const auth = await new TrellisRemoteClient().listRuns()
    expect(auth.ok).toBe(false)
    if (!auth.ok) expect(auth.error).toContain("not configured")
  })

  test("network throw → graceful 'offline'", async () => {
    clearEnv()
    process.env.OPENCODE_TRELLIS_URL = "http://trellis.local"
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch
    const res = await new TrellisRemoteClient().listRuns()
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain("offline")
  })
})

describe("TrellisRemoteClient — per-directory isolation", () => {
  test("URL map resolves a distinct endpoint per directory", async () => {
    clearEnv()
    process.env.OPENCODE_TRELLIS_URL_MAP = JSON.stringify({ "/personal": "http://personal.trellis", "/mf": "http://mf.trellis" })
    expect(trellisConfigured("/personal")).toBe(true)
    expect(trellisConfigured("/mf")).toBe(true)
    expect(trellisConfigured("/unknown")).toBe(false) // no global → falls to fixtures
    let hit: string | undefined
    stubFetch(200, { status: "ok", version: null, runtime: null, checkedAt: "2026-07-12T00:00:00Z" }, (u) => {
      hit = u
    })
    await new TrellisRemoteClient("/mf").health()
    expect(hit).toBe("http://mf.trellis/health")
  })
})
