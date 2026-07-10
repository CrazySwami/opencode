import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  generateImage,
  imageProviderStatus,
  isImageProviderID,
  pickProvider,
  type ImageProviderStatus,
} from "../../../src/tool/image-gen"

const ENV_KEYS = ["RECRAFT_API_KEY", "GEMINI_API_KEY", "OPENCODE_IMAGE_HUB_URL"] as const
const originalEnv: Record<string, string | undefined> = {}
const originalFetch = globalThis.fetch

beforeEach(() => {
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key]
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
  globalThis.fetch = originalFetch
})

function status(overrides: Partial<{ local: boolean; recraft: boolean; gemini: boolean }>): ImageProviderStatus {
  return {
    local: { id: "local", reachable: overrides.local ?? false, url: "http://127.0.0.1:8766" },
    recraft: { id: "recraft", configured: overrides.recraft ?? false },
    gemini: { id: "gemini", configured: overrides.gemini ?? false },
  }
}

describe("isImageProviderID", () => {
  test("accepts the known provider ids", () => {
    expect(isImageProviderID("local")).toBe(true)
    expect(isImageProviderID("recraft")).toBe(true)
    expect(isImageProviderID("gemini")).toBe(true)
  })

  test("rejects anything else", () => {
    expect(isImageProviderID("dalle")).toBe(false)
    expect(isImageProviderID(undefined)).toBe(false)
    expect(isImageProviderID(42)).toBe(false)
  })
})

describe("pickProvider", () => {
  test("picks the first available provider in default order (local > recraft > gemini)", () => {
    expect(pickProvider(status({ local: true, recraft: true, gemini: true }))).toBe("local")
    expect(pickProvider(status({ local: false, recraft: true, gemini: true }))).toBe("recraft")
    expect(pickProvider(status({ local: false, recraft: false, gemini: true }))).toBe("gemini")
  })

  test("returns undefined gracefully when nothing is available", () => {
    expect(pickProvider(status({}))).toBeUndefined()
  })

  test("honors an explicit preference when that provider is available", () => {
    expect(pickProvider(status({ local: true, recraft: true }), "recraft")).toBe("recraft")
  })

  test("falls back to the default order when the preferred provider is unavailable", () => {
    expect(pickProvider(status({ local: true, recraft: false }), "recraft")).toBe("local")
  })

  test("falls back all the way through when the preference and first choices are unavailable", () => {
    expect(pickProvider(status({ local: false, recraft: false, gemini: true }), "recraft")).toBe("gemini")
  })
})

describe("imageProviderStatus", () => {
  test("never leaks key values -- only presence/reachability booleans", async () => {
    process.env.RECRAFT_API_KEY = "sk-recraft-super-secret-value"
    process.env.GEMINI_API_KEY = "gm-gemini-super-secret-value"
    globalThis.fetch = (() => Promise.reject(new Error("network unreachable"))) as unknown as typeof fetch

    const result = await imageProviderStatus({ timeoutMs: 50 })

    expect(result.recraft).toEqual({ id: "recraft", configured: true })
    expect(result.gemini).toEqual({ id: "gemini", configured: true })
    expect(result.local.reachable).toBe(false)

    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain("sk-recraft-super-secret-value")
    expect(serialized).not.toContain("gm-gemini-super-secret-value")
  })

  test("reports local hub as unreachable when the probe fails, without throwing", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch
    const result = await imageProviderStatus({ timeoutMs: 50 })
    expect(result.local.reachable).toBe(false)
  })

  test("reports local hub as reachable when the probe succeeds", async () => {
    globalThis.fetch = ((_url: string) => Promise.resolve(new Response("{}", { status: 200 }))) as unknown as typeof fetch
    const result = await imageProviderStatus({ timeoutMs: 50 })
    expect(result.local.reachable).toBe(true)
  })
})

describe("generateImage", () => {
  test("returns a graceful failure shape when no provider is available (no throw)", async () => {
    delete process.env.RECRAFT_API_KEY
    delete process.env.GEMINI_API_KEY
    globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch

    const result = await generateImage({ prompt: "a red bicycle" })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/no image generation provider is available/i)
    }
  })

  test("returns a graceful failure for a blank prompt without contacting any provider", async () => {
    let called = false
    globalThis.fetch = (() => {
      called = true
      return Promise.reject(new Error("should not be called"))
    }) as unknown as typeof fetch

    const result = await generateImage({ prompt: "   " })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/prompt is required/i)
    expect(called).toBe(false)
  })

  test("never leaks the provider API key in an error message when the provider call fails", async () => {
    const secret = "sk-recraft-should-never-appear-1234567890"
    process.env.RECRAFT_API_KEY = secret
    delete process.env.GEMINI_API_KEY

    globalThis.fetch = ((url: string) => {
      // Local hub probe/generate calls fail so selection falls through to recraft;
      // the recraft call itself throws an error that (if unredacted) would embed
      // the secret, simulating a library that echoes request details in errors.
      if (url.includes("127.0.0.1:8766") || url.includes(process.env.OPENCODE_IMAGE_HUB_URL ?? "")) {
        return Promise.reject(new Error("local hub unreachable"))
      }
      return Promise.reject(new Error(`request failed for Bearer ${secret}`))
    }) as unknown as typeof fetch

    const result = await generateImage({ prompt: "a blue bicycle" })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).not.toContain(secret)
      expect(result.provider).toBe("recraft")
    }
  })

  test("dispatches to the local hub and returns a data URI when it responds with b64_json", async () => {
    delete process.env.RECRAFT_API_KEY
    delete process.env.GEMINI_API_KEY
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      if (String(url).endsWith("/status")) return Promise.resolve(new Response("{}", { status: 200 }))
      if (String(url).endsWith("/v1/images/generations")) {
        expect(init?.method).toBe("POST")
        return Promise.resolve(
          new Response(JSON.stringify({ data: [{ b64_json: "QUJD" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        )
      }
      return Promise.reject(new Error(`unexpected url: ${url}`))
    }) as unknown as typeof fetch

    const result = await generateImage({ prompt: "a green bicycle" })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.provider).toBe("local")
      expect(result.dataUri).toBe("data:image/png;base64,QUJD")
    }
  })
})
