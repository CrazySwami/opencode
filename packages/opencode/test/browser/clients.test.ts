import { afterEach, describe, expect, test } from "bun:test"
import { NekoClient, nekoConfigured, rewriteCdpHost } from "../../src/browser/neko-client"
import { SteelClient, steelConfigured } from "../../src/browser/steel-client"

const ENV = [
  "OPENCODE_NEKO_URL",
  "OPENCODE_NEKO_CDP_URL",
  "OPENCODE_NEKO_CDP_URL_MAP",
  "OPENCODE_STEEL_URL",
  "OPENCODE_STEEL_URL_MAP",
  "OPENCODE_STEEL_VIEWER_URL",
  "OPENCODE_STEEL_TOKEN",
] as const
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
  }) as unknown as typeof fetch
}

describe("rewriteCdpHost (the 127.0.0.1 proxy gotcha)", () => {
  test("rewrites Chromium's reported localhost ws host to the reachable CDP host", () => {
    const out = rewriteCdpHost("ws://127.0.0.1:9222/devtools/page/ABC", "http://ct100:9223")
    expect(out).toBe("ws://ct100:9223/devtools/page/ABC")
  })
  test("uses wss when the CDP base is https", () => {
    const out = rewriteCdpHost("ws://127.0.0.1:9222/devtools/browser/X", "https://ct100.example:9223")
    expect(out).toBe("wss://ct100.example:9223/devtools/browser/X")
  })
  test("garbage in → returned unchanged (never throws)", () => {
    expect(rewriteCdpHost("not a url", "http://ct100:9223")).toBe("not a url")
  })
})

describe("NekoClient", () => {
  test("no CDP URL → configured=false, health ok:false (clear message)", async () => {
    clearEnv()
    expect(nekoConfigured()).toBe(false)
    const res = await new NekoClient().health()
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain("not configured")
  })

  test("health parses /json/version and reports viewer config", async () => {
    clearEnv()
    process.env.OPENCODE_NEKO_CDP_URL = "http://ct100:9223"
    process.env.OPENCODE_NEKO_URL = "http://ct100:8080"
    let seenHost: string | undefined
    stubFetch(200, { Browser: "Chrome/126.0", "Protocol-Version": "1.3" }, (_u, init) => {
      seenHost = new Headers(init?.headers as any).get("host") ?? undefined
    })
    const res = await new NekoClient().health()
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.data.browser).toBe("Chrome/126.0")
      expect(res.data.viewerConfigured).toBe(true)
      expect(res.data.cdpUrl).toBe("http://ct100:9223")
    }
    expect(seenHost).toBe("localhost") // DevTools Host-header workaround
  })

  test("listTargets rewrites every target's ws host to the reachable CDP host", async () => {
    clearEnv()
    process.env.OPENCODE_NEKO_CDP_URL = "http://ct100:9223"
    stubFetch(200, [
      { id: "1", type: "page", title: "t", url: "https://x", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/1" },
    ])
    const res = await new NekoClient().listTargets()
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data[0].webSocketDebuggerUrl).toBe("ws://ct100:9223/devtools/page/1")
  })

  test("CDP 500 / network throw → graceful ok:false, never throws", async () => {
    clearEnv()
    process.env.OPENCODE_NEKO_CDP_URL = "http://ct100:9223"
    stubFetch(503, {})
    expect((await new NekoClient().listTargets()).ok).toBe(false)
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch
    const res = await new NekoClient().health()
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain("offline")
  })

  test("per-directory CDP URL map resolves a distinct endpoint", async () => {
    clearEnv()
    process.env.OPENCODE_NEKO_CDP_URL_MAP = JSON.stringify({ "/mf": "http://mf:9223" })
    expect(nekoConfigured("/mf")).toBe(true)
    expect(nekoConfigured("/unknown")).toBe(false)
    let hit: string | undefined
    stubFetch(200, { Browser: "Chrome" }, (u) => {
      hit = u
    })
    await new NekoClient("/mf").health()
    expect(hit).toBe("http://mf:9223/json/version")
  })
})

describe("SteelClient", () => {
  test("no URL → configured=false, health ok:false", async () => {
    clearEnv()
    expect(steelConfigured()).toBe(false)
    const res = await new SteelClient().health()
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain("not configured")
  })

  test("health ok + exposes viewer; token sent as header but never echoed", async () => {
    clearEnv()
    process.env.OPENCODE_STEEL_URL = "http://ct100:3000"
    process.env.OPENCODE_STEEL_VIEWER_URL = "http://ct100:5173"
    process.env.OPENCODE_STEEL_TOKEN = "steel-secret-should-not-leak"
    let seenKey: string | undefined
    stubFetch(200, { ok: true }, (_u, init) => {
      seenKey = new Headers(init?.headers as any).get("steel-api-key") ?? undefined
    })
    const res = await new SteelClient().health()
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data.viewerUrl).toBe("http://ct100:5173")
    expect(seenKey).toBe("steel-secret-should-not-leak") // sent to Steel…
    expect(JSON.stringify(res)).not.toMatch(/steel-secret/) // …never in the result
  })

  test("createSession parses id + connect/viewer urls; 401 → auth rejected", async () => {
    clearEnv()
    process.env.OPENCODE_STEEL_URL = "http://ct100:3000"
    stubFetch(200, { id: "sess_1", status: "live", websocketUrl: "ws://ct100:9224/x", sessionViewerUrl: "http://ct100:5173/s/sess_1" })
    const created = await new SteelClient().createSession({ url: "https://example.com" })
    expect(created.ok).toBe(true)
    if (created.ok) {
      expect(created.data.id).toBe("sess_1")
      expect(created.data.websocketUrl).toContain("9224")
    }
    stubFetch(401, {})
    const auth = await new SteelClient().health()
    expect(auth.ok).toBe(false)
    if (!auth.ok) expect(auth.error).toContain("auth")
  })
})
