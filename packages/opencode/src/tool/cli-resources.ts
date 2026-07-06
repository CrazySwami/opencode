import { Effect, Schema } from "effect"
import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import * as Tool from "./tool"
import DESCRIPTION from "./cli-resources.txt"
import { collectResourceStatus, type ResourceStatusResponse } from "./resource-status"
import { codexResourceStatus } from "./account-status"

const execFileAsync = promisify(execFile)

// Every CLI probe is bounded in time and output. Nothing here reads or returns
// secret material: no auth.json values, no ~/.claude.json contents, no keyring
// data, no OAuth tokens, no env values. Only names, availability, methods, and
// file presence booleans are surfaced.
const PROBE_TIMEOUT_MS = 6_000
const PROBE_MAX_BUFFER = 96_000
const STATUS_CACHE_TTL_MS = 8_000

const SAFETY_NOTES = [
  "Read-only status. No auth.json, ~/.claude.json, keyring values, OAuth/refresh tokens, API keys, cookies, or env values are ever serialized.",
  "Every CLI probe is timeout-bounded and output-bounded.",
  "OpenCode providers, Codex CLI accounts, Claude Code settings, and Antigravity keyring auth are separate systems shown side by side, not merged.",
  "Claude Code and Antigravity are CLI resources with their own auth/session stores, not OpenCode model providers.",
  "Running actions (claude doctor, agy models) may spawn CLI sessions or auth flows and are approval-gated in the UI.",
]

const TOOLS = ["cli_resources", "resource_status", "account_status", "workspace_tabs"]
const ACTIONS = [
  "refresh",
  "open_codex_auth",
  "set_codex_active",
  "force_codex_account",
  "run_claude_doctor",
  "run_antigravity_models",
  "attach_to_chat",
]

export type CliResourceSection = "system" | "opencode" | "codex" | "claude" | "antigravity"

type BoundedResult = {
  ok: boolean
  stdout: string
  stderr: string
  timedOut: boolean
  error?: string
}

function stripAnsi(value: string) {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\x1b\[[0-9;]*m/g, "")
}

function cleanError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, " ").slice(0, 200)
}

function home() {
  return process.env.HOME || os.homedir() || "/home/dev"
}

function resolveBinary(candidates: string[]): string | null {
  for (const candidate of candidates) {
    try {
      if (candidate && existsSync(candidate)) return candidate
    } catch {
      /* ignore */
    }
  }
  return null
}

async function runBounded(cmd: string, args: string[], extraEnv?: Record<string, string>): Promise<BoundedResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: PROBE_MAX_BUFFER,
      env: { ...process.env, ...(extraEnv ?? {}) },
    })
    return { ok: true, stdout: String(stdout), stderr: String(stderr), timedOut: false }
  } catch (error) {
    const anyError = error as { stdout?: unknown; stderr?: unknown; killed?: boolean; signal?: string; message?: string }
    const timedOut = anyError?.killed === true || anyError?.signal === "SIGTERM" || /timed out|ETIMEDOUT/i.test(String(anyError?.message ?? ""))
    return {
      ok: false,
      stdout: String(anyError?.stdout ?? ""),
      stderr: String(anyError?.stderr ?? ""),
      timedOut,
      error: cleanError(error),
    }
  }
}

// ---------------------------------------------------------------------------
// OpenCode providers (native provider/auth catalog, redacted).
// ---------------------------------------------------------------------------

// The instance's own /provider route is the authoritative catalog (ids, display
// names, per-provider default model, model counts, connected/visible state). Its
// raw payload DOES carry secrets (Provider.Info.key and options.apiKey), so we
// only ever read a strict whitelist of non-secret fields from it.
const PROVIDER_CATALOG_URL = process.env.OPENCODE_CLI_RESOURCES_PROVIDER_URL || "http://127.0.0.1:8299/provider"

// Display-name fallback for credentialed providers that are hidden from the
// catalog (e.g. base OpenAI while Codex Multi-Auth is ready), so the id alone
// is not shown.
const KNOWN_PROVIDER_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  "zai-coding-plan": "Z.AI Coding Plan",
  google: "Google",
  "amazon-bedrock": "Amazon Bedrock",
  openrouter: "OpenRouter",
}

// Read auth.json structure only: provider id -> auth method. Never token values.
function readAuthMethods(): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSyncSafe(path.join(home(), ".local/share/opencode/auth.json")))
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
    const out: Record<string, string> = {}
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      const type = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).type : undefined
      out[id] = typeof type === "string" ? type : "unknown"
    }
    return out
  } catch {
    return {}
  }
}

function readFileSyncSafe(file: string): string {
  return readFileSync(file, "utf8")
}

type ProviderCatalog = {
  connected: string[]
  default: Record<string, string>
  byId: Record<string, { name?: string; source?: string; modelCount: number }>
  availableCount: number
}

async function fetchProviderCatalog(): Promise<ProviderCatalog | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5_000)
    const res = await fetch(PROVIDER_CATALOG_URL, { signal: controller.signal }).finally(() => clearTimeout(timer))
    if (!res.ok) return null
    const body = (await res.json()) as { all?: unknown[]; default?: Record<string, string>; connected?: string[] }
    const all = Array.isArray(body.all) ? body.all : []
    const byId: ProviderCatalog["byId"] = {}
    for (const raw of all) {
      if (!raw || typeof raw !== "object") continue
      const info = raw as Record<string, unknown>
      const id = typeof info.id === "string" ? info.id : undefined
      if (!id) continue
      // Whitelist only: id, name, source, model COUNT. Never key/options/models/env.
      const models = info.models && typeof info.models === "object" && !Array.isArray(info.models) ? info.models : {}
      byId[id] = {
        name: typeof info.name === "string" ? info.name : undefined,
        source: typeof info.source === "string" ? info.source : undefined,
        modelCount: Object.keys(models as Record<string, unknown>).length,
      }
    }
    return {
      connected: Array.isArray(body.connected) ? body.connected.filter((x): x is string => typeof x === "string") : [],
      default: body.default && typeof body.default === "object" ? body.default : {},
      byId,
      availableCount: all.length,
    }
  } catch {
    return null
  }
}

async function probeOpenCode() {
  const binary = resolveBinary(["/usr/bin/opencode", "/usr/local/bin/opencode", path.join(home(), ".local/bin/opencode")])
  const authPathDefault = "~/.local/share/opencode/auth.json"
  const configCandidates = [
    path.join(home(), ".config/opencode/opencode.jsonc"),
    path.join(home(), ".config/opencode/opencode.json"),
    path.join(home(), ".config/opencode/config.json"),
  ]
  const configPath = resolveBinary(configCandidates)
  const authFileExists = existsSync(path.join(home(), ".local/share/opencode/auth.json"))
  if (!binary) {
    return {
      installed: false,
      binary: null,
      providers: [],
      authPath: authPathDefault,
      authFileExists,
      configPath: configPath ? configPath.replace(home(), "~") : null,
      warnings: ["opencode binary not found"],
      note: "OpenCode provider credentials live in auth.json and are never read here.",
    }
  }
  const warnings: string[] = []
  const authMethods = readAuthMethods()
  const catalog = await fetchProviderCatalog()

  type ProviderEntry = {
    id: string
    name: string
    source: string | null
    authMethod: string
    credentialed: boolean
    connected: boolean
    visible: boolean | null
    hiddenReason?: string
    defaultModel: string | null
    modelCount: number | null
  }

  if (catalog) {
    // Merge the runtime catalog (visible in the model picker) with credentialed
    // providers from auth.json. A credentialed provider that is not in the
    // catalog's connected list is hidden (e.g. base OpenAI while Codex
    // Multi-Auth is ready).
    const connectedSet = new Set(catalog.connected)
    const ids = new Set<string>([...catalog.connected, ...Object.keys(authMethods)])
    const providers: ProviderEntry[] = [...ids].map((id) => {
      const meta = catalog.byId[id]
      const credentialed = id in authMethods
      const connected = connectedSet.has(id)
      const hidden = credentialed && !connected
      const authMethod = authMethods[id] ?? (id === "codex-multi-auth" ? "oauth" : connected ? "managed" : "unknown")
      return {
        id,
        name: meta?.name ?? KNOWN_PROVIDER_NAMES[id] ?? id,
        source: meta?.source ?? null,
        authMethod,
        credentialed,
        connected,
        visible: hidden ? false : connected ? true : null,
        ...(hidden ? { hiddenReason: id === "openai" ? "Hidden from the model picker while Codex Multi-Auth is ready" : "Credentialed but not in the active model picker" } : {}),
        defaultModel: catalog.default[id] ?? null,
        modelCount: meta ? meta.modelCount : null,
      }
    })
    // Connected/visible first, then hidden, then the rest.
    providers.sort((a, b) => Number(b.connected) - Number(a.connected) || Number(b.credentialed) - Number(a.credentialed))
    return {
      installed: true,
      binary,
      catalogAvailable: true,
      providers,
      providerCount: providers.length,
      connectedCount: catalog.connected.length,
      availableCount: catalog.availableCount,
      authPath: authPathDefault,
      authFileExists,
      configPath: configPath ? configPath.replace(home(), "~") : null,
      warnings,
      note: "Enriched from the instance provider catalog. Only ids, display names, auth methods, default model ids, and model counts are shown; auth.json/options/key values are never read.",
    }
  }

  // Fallback: no catalog available — parse the redacted `opencode auth list` and
  // keep discoverable-but-unavailable fields as null (unknown), not guessed.
  const result = await runBounded(binary, ["auth", "list"])
  let authPath = authPathDefault
  const providers: ProviderEntry[] = []
  if (result.ok || result.stdout) {
    const lines = stripAnsi(result.stdout).split(/\r?\n/)
    for (const rawLine of lines) {
      const line = rawLine.trim()
      const credMatch = line.match(/Credentials\s+(\S+)/)
      if (credMatch?.[1]) authPath = credMatch[1]
      const bulletMatch = line.match(/^[│|]?\s*[●•*]\s+(.+)$/)
      if (!bulletMatch?.[1]) continue
      const rest = bulletMatch[1].trim()
      if (/^credentials$/i.test(rest) || /credential(s)?$/i.test(rest)) continue
      const methodMatch = rest.match(/^(.*?)\s+(api|oauth|wellknown|apikey|api key)\s*$/i)
      const name = methodMatch ? methodMatch[1].trim() : rest
      const method = methodMatch ? methodMatch[2].toLowerCase() : "unknown"
      providers.push({
        id: name,
        name,
        source: null,
        authMethod: method,
        credentialed: true,
        connected: true,
        visible: null,
        defaultModel: null,
        modelCount: null,
      })
    }
    warnings.push("Provider catalog unavailable; default model and model counts are unknown.")
  }
  if (!result.ok) warnings.push(result.timedOut ? "opencode auth list timed out" : "opencode auth list failed")
  return {
    installed: true,
    binary,
    catalogAvailable: false,
    providers,
    providerCount: providers.length,
    authPath,
    authFileExists,
    configPath: configPath ? configPath.replace(home(), "~") : null,
    warnings,
    note: "Provider catalog unavailable; showing credentialed providers only. Values marked unknown are not guessed.",
  }
}

// ---------------------------------------------------------------------------
// Codex CLI / Codex Multi-Auth (reuse existing account status).
// ---------------------------------------------------------------------------

function probeCodex() {
  try {
    const codex = codexResourceStatus()
    return {
      source: "account_status.codexMultiAuth",
      configured: codex.configured,
      accountCount: codex.accountCount,
      activeAccount: codex.activeAccount,
      forcedAccount: codex.forcedAccount,
      rotationStrategy: codex.rotationStrategy,
      runtimeReady: codex.runtimeReady,
      sendRouting: codex.sendRouting,
      baseProviderVisibility: codex.baseProviderVisibility,
      accounts: codex.accounts,
      runtimeProof: codex.runtimeProof,
      warnings: codex.configured ? [] : ["No Codex multi-auth accounts configured yet."],
      note: "Full Codex account actions live in the account_status tool and the Codex section UI.",
    }
  } catch (error) {
    return { source: "account_status.codexMultiAuth", configured: false, accountCount: 0, accounts: [], warnings: [cleanError(error)] }
  }
}

// ---------------------------------------------------------------------------
// Claude Code CLI (installed state, safe settings presence, telemetry flags).
// ---------------------------------------------------------------------------

async function probeClaude() {
  const binary = resolveBinary([
    path.join(home(), ".local/bin/claude"),
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ])
  const settings = {
    userSettings: existsSync(path.join(home(), ".claude/settings.json")) ? "present" : "missing",
    userConfig: existsSync(path.join(home(), ".claude.json")) ? "present" : "missing",
    projectSettings: "unknown",
  }
  const telemetryConfigured = !!(
    process.env.CLAUDE_CODE_ENABLE_TELEMETRY ||
    process.env.OTEL_METRICS_EXPORTER ||
    process.env.OTEL_LOGS_EXPORTER ||
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  )
  const telemetry = {
    enabled: process.env.CLAUDE_CODE_ENABLE_TELEMETRY === "1",
    configured: telemetryConfigured,
    note: "OpenTelemetry cost/token metrics require explicit CLI configuration.",
  }
  const warnings: string[] = []
  if (!binary) {
    return {
      installed: false,
      binary: null,
      version: null,
      doctorAvailable: false,
      settings,
      telemetry,
      warnings: ["claude binary not found"],
      note: "Claude Code has its own settings/session stores; config contents are never read here.",
    }
  }
  const version = await runBounded(binary, ["--version"])
  const versionString = version.ok ? stripAnsi(version.stdout).trim().split(/\r?\n/)[0]?.slice(0, 80) ?? null : null
  if (!version.ok) warnings.push(version.timedOut ? "claude --version timed out" : "claude --version failed")
  return {
    installed: true,
    binary: binary.replace(home(), "~"),
    version: versionString,
    doctorAvailable: version.ok,
    settings,
    telemetry,
    warnings,
    actions: ["run_claude_doctor"],
    note: "Installed/version + settings-file presence only. Settings contents, tokens, and ~/.claude.json are never read.",
  }
}

// ---------------------------------------------------------------------------
// Antigravity CLI (`agy`) — installed state, safe subcommand availability.
// ---------------------------------------------------------------------------

async function probeAntigravity() {
  const binary = resolveBinary([
    path.join(home(), ".local/bin/agy"),
    "/usr/local/bin/agy",
    "/usr/bin/agy",
  ])
  const auth = {
    state: "unknown",
    note: "Antigravity auth uses the system keyring or an SSH authorization URL. Tokens are never read or displayed.",
  }
  if (!binary) {
    return {
      installed: false,
      binary: null,
      commandName: "agy",
      helpAvailable: false,
      modelsAvailable: null,
      pluginsAvailable: null,
      auth,
      warnings: ["agy binary not found"],
      note: "The command name on this host is agy, not antigravity.",
    }
  }
  const help = await runBounded(binary, ["--help"])
  const helpText = stripAnsi(`${help.stdout}\n${help.stderr}`)
  const hasSubcommand = (name: string) => new RegExp(`(^|\\n)\\s*${name}\\b`, "i").test(helpText)
  const warnings: string[] = []
  if (!help.ok && !helpText.trim()) warnings.push(help.timedOut ? "agy --help timed out" : "agy --help failed")
  // modelsAvailable / pluginsAvailable are whether the subcommand exists, not
  // whether it was run. Running `agy models` may require auth and is left to the
  // approval-gated run action.
  return {
    installed: true,
    binary: binary.replace(home(), "~"),
    commandName: "agy",
    helpAvailable: help.ok || helpText.trim().length > 0,
    modelsAvailable: hasSubcommand("models"),
    pluginsAvailable: hasSubcommand("plugin"),
    subcommands: ["models", "plugin", "install", "update", "changelog"].filter((name) => hasSubcommand(name)),
    auth,
    warnings,
    actions: ["run_antigravity_models"],
    note: "`agy models` may trigger keyring/SSH auth and is approval-gated; not run automatically.",
  }
}

// ---------------------------------------------------------------------------
// Aggregate status (cached briefly to bound CLI spawns under polling).
// ---------------------------------------------------------------------------

let cache: { at: number; value: Awaited<ReturnType<typeof buildStatus>> } | undefined

async function buildStatus() {
  const checkedAt = new Date().toISOString()
  const [system, opencode, claude, antigravity] = await Promise.all([
    collectResourceStatus("all").catch((): ResourceStatusResponse => ({ ok: true, checkedAt })),
    probeOpenCode().catch((error) => ({ installed: false, providers: [], warnings: [cleanError(error)] })),
    probeClaude().catch((error) => ({ installed: false, warnings: [cleanError(error)] })),
    probeAntigravity().catch((error) => ({ installed: false, warnings: [cleanError(error)] })),
  ])
  const codex = probeCodex()
  const systemSection = { source: "resource_status", ...system }
  const lanes = buildLanes({ checkedAt, system: systemSection, opencode, codex, claude, antigravity })
  return {
    ok: true as const,
    checkedAt,
    lanes,
    system: systemSection,
    opencode,
    codex,
    claude,
    antigravity,
    sections: ["overview", "system", "opencode", "codex", "claude", "antigravity"],
    tools: TOOLS,
    actions: ACTIONS,
    safety: SAFETY_NOTES,
  }
}

// A compact, redacted per-lane summary so the Overview UI and the LLM share one
// cohesive "connected resources" view. Only safe fields (status, source, paths,
// versions, active provider/account) — never tokens or secret values.
function buildLanes(input: {
  checkedAt: string
  system: any
  opencode: any
  codex: any
  claude: any
  antigravity: any
}) {
  const { checkedAt, system, opencode, codex, claude, antigravity } = input
  const codexStatus = !codex?.configured ? "needs-setup" : codex?.runtimeReady ? "connected" : "needs-setup"
  const antigravityStatus = !antigravity?.installed
    ? "unavailable"
    : antigravity?.auth?.state && antigravity.auth.state !== "unknown"
      ? "connected"
      : "needs-auth"
  return [
    {
      id: "codex",
      label: "Codex Multi-Auth",
      section: "codex",
      source: "terminal-sidecar",
      status: codexStatus,
      detail: codex?.configured
        ? `${codex.accountCount} account(s) · rotation ${codex.rotationStrategy ?? "unknown"}`
        : "no accounts authorized",
      active: codex?.activeAccount ?? null,
      version: null,
      path: "server-local multi-auth profile store",
      lastChecked: checkedAt,
      actions: ["set active", "force account", "clear force", "authenticate", "runtime proof"],
      note: "Custom sidecar; base OpenAI is hidden from the model picker while this is ready.",
    },
    {
      id: "opencode",
      label: "OpenCode Providers",
      section: "opencode",
      source: "api·config",
      status: opencode?.installed ? "connected" : "unavailable",
      detail: opencode?.catalogAvailable
        ? `${opencode.connectedCount ?? 0} connected · ${opencode.availableCount ?? 0} available`
        : opencode?.installed
          ? `${opencode.providerCount ?? 0} credentialed (catalog unavailable)`
          : "opencode not found",
      active: null,
      version: null,
      path: opencode?.binary ?? null,
      lastChecked: checkedAt,
      actions: ["view"],
      note: "Native provider catalog + auth.json; managed in Settings.",
    },
    {
      id: "claude",
      label: "Claude Code",
      section: "claude",
      source: "cli",
      status: claude?.installed ? "connected" : "unavailable",
      detail: claude?.installed
        ? `settings ${claude.settings?.userSettings ?? "unknown"} · telemetry ${claude.telemetry?.configured ? "configured" : "off"}`
        : "not installed",
      active: null,
      version: claude?.version ?? null,
      path: claude?.binary ?? null,
      lastChecked: checkedAt,
      actions: claude?.installed ? ["run claude doctor"] : [],
      note: "Separate CLI with its own auth/session store; not an OpenCode provider.",
    },
    {
      id: "antigravity",
      label: "Antigravity",
      section: "antigravity",
      source: "cli",
      status: antigravityStatus,
      detail: antigravity?.installed
        ? `agy · models ${antigravity.modelsAvailable === true ? "available" : antigravity.modelsAvailable === false ? "missing" : "unknown"}`
        : "not installed (agy)",
      active: null,
      version: null,
      path: antigravity?.binary ?? null,
      lastChecked: checkedAt,
      actions: antigravity?.installed ? ["check models"] : [],
      note: "Keyring/SSH auth; tokens never read. Separate CLI, not an OpenCode provider.",
    },
    {
      id: "system",
      label: "System",
      section: "system",
      source: "metrics",
      status: system?.server?.online ? "connected" : "unknown",
      detail: system?.server?.hostname ? `server ${system.server.hostname}` : "CPU/RAM/storage metrics",
      active: null,
      version: null,
      path: null,
      lastChecked: checkedAt,
      actions: ["view"],
      note: "CT100 + Mac resource metrics.",
    },
  ]
}

export async function collectCliResourcesStatus(force = false) {
  const now = Date.now()
  if (!force && cache && now - cache.at < STATUS_CACHE_TTL_MS) return cache.value
  const value = await buildStatus()
  cache = { at: now, value }
  return value
}

export async function cliResourcesSection(section: CliResourceSection) {
  const status = await collectCliResourcesStatus()
  return {
    ok: true,
    checkedAt: status.checkedAt,
    section,
    data: (status as Record<string, unknown>)[section] ?? null,
    safety: status.safety,
  }
}

// ---------------------------------------------------------------------------
// Approval-gated run actions (UI only). Bounded, redacted, auth-safe.
// ---------------------------------------------------------------------------

export async function runCliResourceAction(probe: string) {
  if (probe === "claude-doctor") {
    const binary = resolveBinary([path.join(home(), ".local/bin/claude"), "/usr/local/bin/claude", "/usr/bin/claude"])
    if (!binary) return { ok: false, probe, error: "claude binary not found" }
    const result = await runBounded(binary, ["doctor", "--help"])
    const text = stripAnsi(`${result.stdout}\n${result.stderr}`).trim().slice(0, 2_000)
    return {
      ok: result.ok,
      probe,
      available: result.ok,
      output: text || (result.timedOut ? "claude doctor timed out" : "no output"),
      note: "Ran `claude doctor --help` (safe, no config contents printed).",
    }
  }
  if (probe === "antigravity-models") {
    const binary = resolveBinary([path.join(home(), ".local/bin/agy"), "/usr/local/bin/agy", "/usr/bin/agy"])
    if (!binary) return { ok: false, probe, error: "agy binary not found" }
    const result = await runBounded(binary, ["models"])
    let text = stripAnsi(`${result.stdout}\n${result.stderr}`).trim()
    // Never surface auth URLs or tokens. If output looks like an auth prompt,
    // redact it and report needsAuth instead.
    const looksLikeAuth = /https?:\/\/|authoriz|sign in|log in|keyring|token/i.test(text)
    if (looksLikeAuth) {
      return {
        ok: false,
        probe,
        needsAuth: true,
        output: "Antigravity requires authentication (keyring or SSH authorization URL). Complete auth in a terminal; the URL/token is intentionally not shown here.",
        note: "`agy models` output was withheld because it contained auth material.",
      }
    }
    text = text.slice(0, 2_000)
    return {
      ok: result.ok,
      probe,
      output: text || (result.timedOut ? "agy models timed out" : "no output"),
      note: "Ran `agy models` (bounded). Auth material, if any, is withheld.",
    }
  }
  return { ok: false, error: `Unknown cli-resources probe: ${probe}` }
}

// ---------------------------------------------------------------------------
// Read-only LLM tool. Mutations/run actions stay in account_status and the
// approval-gated UI run route.
// ---------------------------------------------------------------------------

export const Parameters = Schema.Struct({
  action: Schema.optional(
    Schema.Literals(["status", "probe-opencode", "probe-codex", "probe-claude", "probe-antigravity"]),
  ).annotate({
    description:
      "status = full redacted CLI resources snapshot (system, opencode, codex, claude, antigravity). probe-* = one section only. Defaults to status. Read-only.",
  }),
})

type ToolMetadata = { action: string }

const SECTION_FOR_ACTION: Record<string, CliResourceSection> = {
  "probe-opencode": "opencode",
  "probe-codex": "codex",
  "probe-claude": "claude",
  "probe-antigravity": "antigravity",
}

export const CliResourcesTool = Tool.define<typeof Parameters, ToolMetadata, never>(
  "cli_resources",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>) =>
        Effect.gen(function* () {
          const action = params.action ?? "status"
          const section = SECTION_FOR_ACTION[action]
          const body = section
            ? yield* Effect.promise(() => cliResourcesSection(section))
            : yield* Effect.promise(() => collectCliResourcesStatus())
          return {
            title: `cli_resources ${action}`,
            output: JSON.stringify(body, null, 2),
            metadata: { action },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
