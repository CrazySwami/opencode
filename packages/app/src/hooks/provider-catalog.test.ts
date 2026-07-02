import { expect, test } from "bun:test"
import type { NormalizedProviderListResponse } from "@opencode-ai/session-ui/context"
import { CODEX_MULTI_AUTH_PROVIDER_ID, selectProviderCatalog } from "./provider-catalog"

const catalog = (id: string): NormalizedProviderListResponse => ({
  all: new Map([[id, { id, name: id, source: "api", env: [], options: {}, models: {} }]]),
  connected: [id],
  default: { [id]: `${id}-model` },
})

test("selects the ready catalog for an explicit directory", () => {
  const directory = catalog("directory")

  expect(
    selectProviderCatalog({
      explicit: true,
      directory: "/repo",
      catalog: { ready: true, providers: directory },
    }),
  ).toBe(directory)
})

test("returns an empty catalog while an explicit directory is unresolved", () => {
  expect(selectProviderCatalog({ explicit: true })).toEqual({ all: new Map(), connected: [], default: {} })
  expect(
    selectProviderCatalog({
      explicit: true,
      directory: "/repo",
      catalog: { ready: false, providers: catalog("directory") },
    }),
  ).toEqual({ all: new Map(), connected: [], default: {} })
})

test("uses the route catalog when it is ready", () => {
  const directory = catalog("directory")

  expect(
    selectProviderCatalog({
      explicit: false,
      directory: "/repo",
      catalog: { ready: true, providers: directory },
      global: catalog("global"),
    }),
  ).toBe(directory)
})

test("falls back to the global catalog for route consumers", () => {
  const global = catalog("global")

  expect(selectProviderCatalog({ explicit: false, global })).toBe(global)
  expect(
    selectProviderCatalog({
      explicit: false,
      directory: "/repo",
      catalog: { ready: false, providers: catalog("directory") },
      global,
    }),
  ).toBe(global)
})


test("adds a Codex multi-auth lane when OpenAI is connected", () => {
  const openaiModel = {
    id: "gpt-5.5-fast",
    name: "GPT-5.5 Fast",
    release_date: "2026-01-01",
    status: "active",
  } as any
  const global: NormalizedProviderListResponse = {
    all: new Map([
      [
        "openai",
        {
          id: "openai",
          name: "OpenAI",
          source: "custom",
          env: [],
          options: {},
          models: { "gpt-5.5-fast": openaiModel },
        },
      ],
    ]),
    connected: ["openai"],
    default: { openai: "gpt-5.5-fast" },
  }

  const result = selectProviderCatalog({ explicit: false, global })
  const codex = result.all.get(CODEX_MULTI_AUTH_PROVIDER_ID)

  expect(codex?.name).toBe("Codex Multi-Auth")
  expect(codex?.models["gpt-5.5-fast"]?.providerID).toBe(CODEX_MULTI_AUTH_PROVIDER_ID)
  expect(result.connected).toContain(CODEX_MULTI_AUTH_PROVIDER_ID)
  expect(result.default[CODEX_MULTI_AUTH_PROVIDER_ID]).toBe("gpt-5.5-fast")
})


test("hides base OpenAI when the server marks Codex multi-auth preferred", () => {
  const openaiModel = {
    id: "gpt-5.5-fast",
    name: "GPT-5.5 Fast",
    release_date: "2026-01-01",
    status: "active",
  } as any
  const global: NormalizedProviderListResponse = {
    all: new Map([
      [
        "openai",
        {
          id: "openai",
          name: "OpenAI",
          source: "custom",
          env: [],
          options: {},
          models: { "gpt-5.5-fast": openaiModel },
        },
      ],
      [
        CODEX_MULTI_AUTH_PROVIDER_ID,
        {
          id: CODEX_MULTI_AUTH_PROVIDER_ID,
          name: "Codex Multi-Auth",
          source: "custom",
          env: [],
          options: { baseProviderID: "openai", hideBaseProvider: true },
          models: { "gpt-5.5-fast": { ...openaiModel, providerID: CODEX_MULTI_AUTH_PROVIDER_ID } },
        },
      ],
    ]),
    connected: ["openai", CODEX_MULTI_AUTH_PROVIDER_ID],
    default: { openai: "gpt-5.5-fast", [CODEX_MULTI_AUTH_PROVIDER_ID]: "gpt-5.5-fast" },
  }

  const result = selectProviderCatalog({ explicit: false, global })

  expect(result.all.has("openai")).toBe(false)
  expect(result.connected).not.toContain("openai")
  expect(result.connected).toContain(CODEX_MULTI_AUTH_PROVIDER_ID)
  expect("openai" in result.default).toBe(false)
})
