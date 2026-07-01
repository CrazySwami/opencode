import type { NormalizedProviderListResponse } from "@opencode-ai/session-ui/context"

const emptyProviderCatalog: NormalizedProviderListResponse = { all: new Map(), connected: [], default: {} }
export const CODEX_MULTI_AUTH_PROVIDER_ID = "codex-multi-auth"
export const CODEX_MULTI_AUTH_BASE_PROVIDER_ID = "openai"

function withCodexMultiAuthProvider(catalog: NormalizedProviderListResponse): NormalizedProviderListResponse {
  const base = catalog.all.get(CODEX_MULTI_AUTH_BASE_PROVIDER_ID)
  if (!base) return catalog
  if (!catalog.connected.includes(CODEX_MULTI_AUTH_BASE_PROVIDER_ID)) return catalog

  const models = Object.fromEntries(
    Object.entries(base.models).map(([id, model]) => [
      id,
      {
        ...model,
        providerID: CODEX_MULTI_AUTH_PROVIDER_ID,
      },
    ]),
  )
  const firstModel = catalog.default[CODEX_MULTI_AUTH_BASE_PROVIDER_ID] ?? Object.keys(models)[0]
  if (!firstModel) return catalog

  const all = new Map(catalog.all)
  all.set(CODEX_MULTI_AUTH_PROVIDER_ID, {
    ...base,
    id: CODEX_MULTI_AUTH_PROVIDER_ID,
    name: "Codex Multi-Auth",
    source: "custom",
    env: [],
    options: {
      ...base.options,
      baseProviderID: CODEX_MULTI_AUTH_BASE_PROVIDER_ID,
      experimental: true,
    },
    models,
  })

  return {
    ...catalog,
    all,
    connected: catalog.connected.includes(CODEX_MULTI_AUTH_PROVIDER_ID)
      ? catalog.connected
      : [...catalog.connected, CODEX_MULTI_AUTH_PROVIDER_ID],
    default: { ...catalog.default, [CODEX_MULTI_AUTH_PROVIDER_ID]: firstModel },
  }
}

type DirectoryCatalog = {
  ready: boolean
  providers: NormalizedProviderListResponse
}

type ProviderCatalogInput =
  | {
      explicit: true
      directory?: string
      catalog?: DirectoryCatalog
    }
  | {
      explicit: false
      directory?: string
      catalog?: DirectoryCatalog
      global: NormalizedProviderListResponse
    }

export function selectProviderCatalog(input: ProviderCatalogInput) {
  const catalog = input.directory && input.catalog?.ready ? input.catalog.providers : input.explicit ? emptyProviderCatalog : input.global

  return withCodexMultiAuthProvider(catalog)
}
