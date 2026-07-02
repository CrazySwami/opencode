import { Effect, Schema } from "effect"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import * as Tool from "./tool"
import DESCRIPTION from "./account-status.txt"

export const Parameters = Schema.Struct({
  detail: Schema.optional(Schema.Literals(["summary", "environment"])).annotate({
    description: "Level of account/status detail. Defaults to summary.",
  }),
  action: Schema.optional(Schema.Literals(["status", "set-active", "set-rotation"])).annotate({
    description: "Codex multi-auth action. Defaults to status. set-active requires alias. set-rotation requires strategy.",
  }),
  alias: Schema.optional(Schema.String).annotate({
    description: "Codex multi-auth account alias for set-active.",
  }),
  strategy: Schema.optional(Schema.Literals(["round-robin", "least-used", "random", "weighted-round-robin"])).annotate({
    description: "Codex multi-auth rotation strategy for set-rotation.",
  }),
})

type Metadata = {
  detail: "summary" | "environment"
  action: "status" | "set-active" | "set-rotation"
}

type CodexAccountSummary = {
  alias: string
  email: string | null
  accountId: string | null
  enabled: boolean
  active: boolean
  source: string
  usageCount: number | null
  lastUsed: number | null
  lastSeenAt: number | null
  expiresAt: number | null
}

function readJsonObject(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function codexMultiAuthGuardStorePath() {
  const home = process.env.HOME || "/home/dev"
  const profileName = process.env.OPENCODE_MULTI_AUTH_PROFILE || "guard22-codex-multi-auth"
  return path.join(home, ".opencode-profiles", profileName, "home", ".config", "opencode-multi-auth", "accounts.json")
}

function codexRuntimeProofPath() {
  const home = process.env.HOME || "/home/dev"
  return path.join(home, ".local", "share", "opencode-codex-multi-auth", "runtime-proof.json")
}

function conversationStatePath() {
  return path.join(
    process.env.OPENCODE_STATE_EXPORT_DIR || "/home/dev/.local/share/opencode-workspace-state/conversations",
    "latest.json",
  )
}

function summarizeCodexAccount(alias: string, value: unknown, activeAlias: string | null): CodexAccountSummary {
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  return {
    alias,
    email: typeof record.email === "string" ? record.email : null,
    accountId: typeof record.accountId === "string" ? record.accountId : null,
    enabled: record.enabled !== false,
    active: alias === activeAlias,
    source: typeof record.source === "string" ? record.source : "opencode-multi-auth",
    usageCount: typeof record.usageCount === "number" ? record.usageCount : null,
    lastUsed: typeof record.lastUsed === "number" ? record.lastUsed : null,
    lastSeenAt: typeof record.lastSeenAt === "number" ? record.lastSeenAt : null,
    expiresAt: typeof record.expiresAt === "number" ? record.expiresAt : null,
  }
}

function codexStatus() {
  const store = codexMultiAuthGuardStorePath()
  const data = readJsonObject(store)
  const accountsObject = data?.accounts
  const accountsRecord =
    accountsObject && typeof accountsObject === "object" && !Array.isArray(accountsObject)
      ? (accountsObject as Record<string, unknown>)
      : null
  const aliases = accountsRecord ? Object.keys(accountsRecord) : []
  const activeAlias =
    typeof data?.activeAlias === "string" && data.activeAlias.trim()
      ? data.activeAlias.trim()
      : (aliases[0] ?? null)
  const runtimeProof = readJsonObject(codexRuntimeProofPath())
  const runtimeReady = runtimeProof?.ok === true && runtimeProof?.state !== "failed"
  const settings = data?.settings && typeof data.settings === "object" && !Array.isArray(data.settings) ? data.settings as Record<string, unknown> : {}
  const rotationStrategy =
    typeof data?.rotationStrategy === "string"
      ? data.rotationStrategy
      : typeof settings.rotationStrategy === "string"
        ? settings.rotationStrategy
        : "round-robin"
  const conversationState = readJsonObject(conversationStatePath())

  return {
    providerID: "codex-multi-auth",
    baseProviderID: "openai",
    configured: aliases.length > 0,
    accountCount: aliases.length,
    activeAccount: activeAlias,
    rotationStrategy,
    runtimeReady,
    sendBlocked: !(aliases.length > 0 && runtimeReady),
    sendRouting: aliases.length > 0 && runtimeReady ? "multi-auth-sidecar-prompt-adapter" : "blocked-or-pending",
    accountStore: {
      type: "guard22",
      path: store,
      exists: existsSync(store),
    },
    accounts: aliases.map((alias) => summarizeCodexAccount(alias, accountsRecord?.[alias], activeAlias)),
    runtimeProof: runtimeProof
      ? {
          ok: runtimeProof.ok === true,
          state: typeof runtimeProof.state === "string" ? runtimeProof.state : null,
          accountAlias: typeof runtimeProof.accountAlias === "string" ? runtimeProof.accountAlias : null,
          verifiedAt: typeof runtimeProof.verifiedAt === "string" ? runtimeProof.verifiedAt : null,
          durationMs: typeof runtimeProof.durationMs === "number" ? runtimeProof.durationMs : null,
        }
      : null,
    routes: {
      status: "/experimental/codex-multi-auth/status",
      login: "/experimental/codex-multi-auth/login",
      account: "/experimental/codex-multi-auth/account",
      conversations: "/experimental/conversations/state",
      exportConversations: "/experimental/conversations/export",
    },
    conversationState: conversationState
      ? {
          generatedAt: conversationState.generatedAt,
          outputRoot: conversationState.outputRoot,
          counts: conversationState.counts,
          terminalState: conversationState.terminalState,
        }
      : {
          ok: false,
          error: "Conversation state export has not run yet.",
          latestPath: conversationStatePath(),
        },
  }
}

function updateCodexStore(mutator: (data: Record<string, unknown>, accounts: Record<string, unknown>) => Record<string, unknown>) {
  const store = codexMultiAuthGuardStorePath()
  try {
    const data = readJsonObject(store)
    const accounts = data?.accounts
    if (!data || !accounts || typeof accounts !== "object" || Array.isArray(accounts)) {
      return { ok: false, error: "Codex multi-auth account store is not available.", store, status: codexStatus() }
    }
    const next = mutator(data, accounts as Record<string, unknown>)
    writeFileSync(store, JSON.stringify(next, null, 2))
    return { ok: true, store, status: codexStatus() }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), store, status: codexStatus() }
  }
}

export const AccountStatusTool = Tool.define<typeof Parameters, Metadata, never>(
  "account_status",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>) =>
        Effect.gen(function* () {
          const detail = params.detail ?? "summary"
          const action = params.action ?? "status"
          let actionResult: Record<string, unknown> | undefined

          if (action === "set-active") {
            const alias = params.alias?.trim()
            actionResult = updateCodexStore((data, accounts) => {
              if (!alias || !Object.prototype.hasOwnProperty.call(accounts, alias)) {
                throw new Error(`Unknown Codex account alias: ${alias || "empty"}`)
              }
              return {
                ...data,
                activeAlias: alias,
                forcedAlias: null,
                forcedUntil: null,
                lastManualSwitchAt: Date.now(),
              }
            })
          }

          if (action === "set-rotation") {
            const strategy = params.strategy
            actionResult = updateCodexStore((data) => {
              const settings =
                data.settings && typeof data.settings === "object" && !Array.isArray(data.settings)
                  ? (data.settings as Record<string, unknown>)
                  : {}
              return {
                ...data,
                rotationStrategy: strategy,
                settings: { ...settings, rotationStrategy: strategy },
              }
            })
          }

          const status = {
            hostname: process.env.OPENCODE_HOSTNAME ?? null,
            openDesignConfigured: !!(
              process.env.OD_API_TOKEN ||
              process.env.OPENCODE_OPEN_DESIGN_TOKEN ||
              process.env.OD_DAEMON_URL ||
              process.env.OPENCODE_OPEN_DESIGN_DAEMON_URL
            ),
            browserHome: process.env.OPENCODE_BROWSER_HOME ?? null,
            macViewConfigured: !!process.env.OPENCODE_MAC_VIEW_URL,
            playwrightCLI: process.env.OPENCODE_PLAYWRIGHT_CLI ?? "npx -y @playwright/cli",
            codexMultiAuth: codexStatus(),
            actionResult,
            tools: [
              "browser",
              "browser_use",
              "terminal",
              "open_design",
              "mac_view",
              "resource_status",
              "artifact",
              "file_browser",
              "account_status",
              "routines",
              "workspace_tabs",
            ],
            ...(detail === "environment"
              ? {
                  env: {
                    OD_DAEMON_URL: process.env.OD_DAEMON_URL ? "[set]" : "[unset]",
                    OD_API_TOKEN: process.env.OD_API_TOKEN ? "[set]" : "[unset]",
                    OPENCODE_OPEN_DESIGN_DAEMON_URL: process.env.OPENCODE_OPEN_DESIGN_DAEMON_URL ? "[set]" : "[unset]",
                    OPENCODE_OPEN_DESIGN_TOKEN: process.env.OPENCODE_OPEN_DESIGN_TOKEN ? "[set]" : "[unset]",
                    OPENCODE_MAC_VIEW_URL: process.env.OPENCODE_MAC_VIEW_URL ? "[set]" : "[unset]",
                    OPENCODE_MAC_RESOURCE_HOST: process.env.OPENCODE_MAC_RESOURCE_HOST ? "[set]" : "[unset]",
                  },
                }
              : {}),
          }
          return {
            title: "account status",
            output: JSON.stringify(status, null, 2),
            metadata: { detail, action },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
