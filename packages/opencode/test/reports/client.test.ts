import { afterEach, describe, expect, test } from "bun:test"
import { ReportsRemoteClient, reportsConfigured } from "../../src/reports/client"

const ENV = ["OPENCODE_REPORTS_URL", "OPENCODE_REPORTS_URL_MAP", "OPENCODE_REPORTS_TOKEN"] as const
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

describe("ReportsRemoteClient — fixtures-first (no URL)", () => {
  test("health/listReports return fixture data, clearly source:'fixture'", async () => {
    clearEnv()
    const c = new ReportsRemoteClient()
    expect(reportsConfigured()).toBe(false)
    const h = await c.health()
    expect(h).toMatchObject({ ok: true, source: "fixture" })
    if (h.ok) expect(h.data.count).toBeGreaterThan(0)
    const r = await c.listReports()
    expect(r.ok && r.source === "fixture" && r.data.every((x) => x.format === "openbook")).toBe(true)
  })

  test("getReport known → fixture; unknown → ok:false (never throws)", async () => {
    clearEnv()
    const c = new ReportsRemoteClient()
    const hit = await c.getReport("daily-2026-07-11")
    expect(hit).toMatchObject({ ok: true, source: "fixture" })
    if (hit.ok) expect(hit.data.date).toBe("2026-07-11")
    const miss = await c.getReport("nope")
    expect(miss.ok).toBe(false)
    if (!miss.ok) expect(miss.error).toContain("not found")
  })
})

describe("ReportsRemoteClient — live (URL set)", () => {
  test("200 → live data, source:'live', and forwards Bearer token (never echoed)", async () => {
    clearEnv()
    process.env.OPENCODE_REPORTS_URL = "http://reports.local"
    process.env.OPENCODE_REPORTS_TOKEN = "tk-secret-should-not-leak"
    let seenAuth: string | undefined
    stubFetch(200, { status: "ok", count: 7, latestDate: "2026-07-13", checkedAt: "2026-07-13T00:00:00Z" }, (_u, init) => {
      seenAuth = new Headers(init?.headers as any).get("authorization") ?? undefined
    })
    const res = await new ReportsRemoteClient().health()
    expect(res).toMatchObject({ ok: true, source: "live" })
    if (res.ok) expect(res.data.count).toBe(7)
    expect(seenAuth).toBe("Bearer tk-secret-should-not-leak") // sent to the feed…
    expect(JSON.stringify(res)).not.toMatch(/tk-secret/) // …but never in the result
  })

  test("malformed live JSON → ok:false, cannot corrupt state", async () => {
    clearEnv()
    process.env.OPENCODE_REPORTS_URL = "http://reports.local"
    stubFetch(200, { nonsense: true }) // missing required 'status'
    const res = await new ReportsRemoteClient().health()
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain("malformed")
  })

  test("5xx → ok:false; 401/403 → 'not configured'", async () => {
    clearEnv()
    process.env.OPENCODE_REPORTS_URL = "http://reports.local"
    stubFetch(503, {})
    expect((await new ReportsRemoteClient().listReports()).ok).toBe(false)
    stubFetch(401, {})
    const auth = await new ReportsRemoteClient().listReports()
    expect(auth.ok).toBe(false)
    if (!auth.ok) expect(auth.error).toContain("not configured")
  })

  test("network throw → graceful 'offline'", async () => {
    clearEnv()
    process.env.OPENCODE_REPORTS_URL = "http://reports.local"
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch
    const res = await new ReportsRemoteClient().listReports()
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain("offline")
  })
})

describe("ReportsRemoteClient — per-directory isolation", () => {
  test("URL map resolves a distinct endpoint per directory", async () => {
    clearEnv()
    process.env.OPENCODE_REPORTS_URL_MAP = JSON.stringify({ "/personal": "http://personal.reports", "/mf": "http://mf.reports" })
    expect(reportsConfigured("/personal")).toBe(true)
    expect(reportsConfigured("/mf")).toBe(true)
    expect(reportsConfigured("/unknown")).toBe(false) // no global → falls to fixtures
    let hit: string | undefined
    stubFetch(200, { status: "ok", count: 0, latestDate: null, checkedAt: "2026-07-13T00:00:00Z" }, (u) => {
      hit = u
    })
    await new ReportsRemoteClient("/mf").health()
    expect(hit).toBe("http://mf.reports/health")
  })
})
