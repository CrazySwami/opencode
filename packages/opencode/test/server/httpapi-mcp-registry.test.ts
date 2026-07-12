import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { Session } from "@/session/session"
import { Database } from "@opencode-ai/core/database/database"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"
import { __resetMcpRegistryCacheForTest } from "@/server/routes/instance/httpapi/server"

// Covers the live-registry fallback resolved from the TODO at
// src/server/routes/instance/httpapi/server.ts:163. mcpRegistryCatalog() tries
// the OpenDesign daemon first; when OD is offline it now tries the official
// MCP registry (registry.modelcontextprotocol.io, env-overridable via
// OPENCODE_MCP_REGISTRY_URL) before falling back to the hardcoded seed.
// OPENCODE_OD_URL is always pointed at a dead port here to force that fallback
// branch deterministically.

const it = testEffect(Layer.mergeAll(Session.defaultLayer, Database.defaultLayer, httpApiLayer))

function request(path: string, directory: string, init: RequestInit = {}) {
  return requestInDirectory(path, directory, init)
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  return response.json.pipe(Effect.map((value) => value as T))
}

const ENV_KEYS = ["OPENCODE_OD_URL", "OPENCODE_MCP_REGISTRY_URL"] as const
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
  __resetMcpRegistryCacheForTest()
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

type CatalogEntry = { name: string; title: string; description: string; transport: string; homepage: string; install?: string }
type CatalogBody = { ok: boolean; source: string; note: string; registries: string[]; servers: CatalogEntry[] }

describe("mcp/registry live-registry fallback", () => {
  it.instance("registry stub returns 200 → source:registry, mapped remote entry", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      process.env.OPENCODE_OD_URL = yield* Effect.promise(deadDaemonUrl)
      process.env.OPENCODE_MCP_REGISTRY_URL = stubDaemon(200, {
        servers: [
          {
            server: {
              name: "x/y",
              title: "Y",
              description: "d",
              remotes: [{ type: "streamable-http", url: "https://z" }],
            },
          },
        ],
      })
      const res = yield* request("/experimental/mcp/registry", tmp.directory)
      expect(res.status).toBe(200)
      const body = yield* json<CatalogBody>(res)
      expect(body.ok).toBe(true)
      expect(body.source).toBe("registry")
      const entry = body.servers.find((s) => s.name === "x/y")
      expect(entry).toBeDefined()
      expect(entry?.transport).toBe("remote")
      expect(entry?.title).toBe("Y")
      expect(entry?.description).toBe("d")
      expect(entry?.install).toBe("https://z")
    }),
  )

  it.instance("registry stub returns 500 + empty cache → falls through to seed", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      process.env.OPENCODE_OD_URL = yield* Effect.promise(deadDaemonUrl)
      process.env.OPENCODE_MCP_REGISTRY_URL = stubDaemon(500, { boom: true })
      const res = yield* request("/experimental/mcp/registry", tmp.directory)
      expect(res.status).toBe(200)
      const body = yield* json<CatalogBody>(res)
      expect(body.ok).toBe(true)
      expect(body.source).toBe("seed")
      expect(body.servers.map((s) => s.name)).toContain("github")
    }),
  )

  it.instance("cache: successful fetch then registry goes down → still served from TTL cache", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      process.env.OPENCODE_OD_URL = yield* Effect.promise(deadDaemonUrl)
      process.env.OPENCODE_MCP_REGISTRY_URL = stubDaemon(200, {
        servers: [
          {
            server: {
              name: "cached/one",
              title: "Cached",
              description: "d",
              remotes: [{ type: "streamable-http", url: "https://cached" }],
            },
          },
        ],
      })
      const first = yield* request("/experimental/mcp/registry", tmp.directory)
      const firstBody = yield* json<CatalogBody>(first)
      expect(firstBody.source).toBe("registry")
      expect(firstBody.servers.map((s) => s.name)).toContain("cached/one")

      // Registry now goes down, but the TTL cache should still serve the
      // previously-fetched entries instead of falling back to the seed.
      process.env.OPENCODE_MCP_REGISTRY_URL = stubDaemon(500, {})
      const second = yield* request("/experimental/mcp/registry", tmp.directory)
      const secondBody = yield* json<CatalogBody>(second)
      expect(secondBody.source).toBe("registry")
      expect(secondBody.servers.map((s) => s.name)).toContain("cached/one")
    }),
  )
})
