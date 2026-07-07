import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"

export type WorkspaceEnvScope =
  | "global"
  | "repos"
  | "project"
  | "terminal"
  | "bash"
  | "routines"
  | "browser"
  | "preview"
  | "open_design"

export type WorkspaceEnvEntry = {
  id: string
  name: string
  value: string
  scope: WorkspaceEnvScope
  target?: string
  enabled: boolean
  secret: boolean
  description?: string
  createdAt: string
  updatedAt: string
}

export type WorkspaceEnvRegistry = {
  version: 1
  updatedAt: string
  entries: WorkspaceEnvEntry[]
}

export type WorkspaceEnvPublicEntry = Omit<WorkspaceEnvEntry, "value"> & {
  hasValue: boolean
  maskedValue: string
  valuePreview?: string
}

export type WorkspaceEnvPublicRegistry = Omit<WorkspaceEnvRegistry, "entries"> & {
  path: string
  entries: WorkspaceEnvPublicEntry[]
  secretValuesExposed: false
}

const DEFAULT_SCOPE: WorkspaceEnvScope = "repos"
const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
// Names that indicate a secret. Intentionally broad: it is safer to over-flag a
// var as secret (user can uncheck) than to leak plaintext in the polled status.
const SECRET_NAME =
  /(KEY|TOKEN|SECRET|PASSWORD|PASS|PRIVATE|CREDENTIAL|COOKIE|AUTH|SESSION|DSN|JWT|WEBHOOK|CERT|FINGERPRINT|SIGNING|SALT|BEARER|SSH|GPG|PGP|OTP|DATABASE_URL|CONNECTION_STRING|CONN_STR|(?:^|_)PAT(?:_|$)|(?:^|_)API(?:_|$))/i

// A value that embeds credentials (e.g. postgres://user:pass@host) or is a long
// high-entropy token is treated as secret regardless of the variable name.
const CREDENTIAL_URL = /:\/\/[^/\s:@]+:[^/\s@]+@/
function valueLooksSecret(value: string) {
  if (!value) return false
  if (CREDENTIAL_URL.test(value)) return true
  // 40+ chars with no spaces and mixed classes -> likely a token/key.
  return value.length >= 40 && !/\s/.test(value) && /[A-Za-z]/.test(value) && /[0-9]/.test(value)
}

export function workspaceEnvPath() {
  return (
    process.env.OPENCODE_WORKSPACE_ENV_FILE ||
    path.join(process.env.HOME || os.homedir(), ".config", "hustle-env", "workspace-env.json")
  )
}

export function workspaceEnvDefaultReposRoot() {
  return process.env.OPENCODE_WORKSPACE_ENV_REPOS_ROOT || "/home/dev/repos"
}

export function readWorkspaceEnvRegistry(): WorkspaceEnvRegistry {
  const file = workspaceEnvPath()
  if (!existsSync(file)) return emptyRegistry()
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<WorkspaceEnvRegistry>
    return normalizeRegistry(parsed)
  } catch {
    return emptyRegistry()
  }
}

export function readWorkspaceEnvRegistryPublic(): WorkspaceEnvPublicRegistry {
  const registry = readWorkspaceEnvRegistry()
  return {
    ...registry,
    path: workspaceEnvPath(),
    secretValuesExposed: false,
    entries: registry.entries.map(redactEntry),
  }
}

export function upsertWorkspaceEnvEntry(input: {
  id?: string
  name: string
  value?: string
  scope?: string
  target?: string
  enabled?: boolean
  secret?: boolean
  description?: string
}) {
  const registry = readWorkspaceEnvRegistry()
  const name = input.name.trim()
  if (!VALID_NAME.test(name)) throw new Error("Environment variable names must match /^[A-Za-z_][A-Za-z0-9_]*$/")
  if (input.description && CREDENTIAL_URL.test(input.description))
    throw new Error("Description must not contain credentials (found a user:pass@ URL). Put secrets in the value, not the description.")
  const now = new Date().toISOString()
  const existing = input.id
    ? registry.entries.find((entry) => entry.id === input.id)
    : registry.entries.find((entry) => entry.name === name)
  const value = input.value === undefined ? (existing?.value ?? "") : input.value
  const entry: WorkspaceEnvEntry = {
    id: existing?.id ?? input.id ?? randomUUID(),
    name,
    value,
    scope: normalizeScope(input.scope ?? existing?.scope ?? DEFAULT_SCOPE),
    target: normalizeOptionalString(input.target ?? existing?.target),
    enabled: input.enabled ?? existing?.enabled ?? true,
    secret: input.secret ?? existing?.secret ?? (SECRET_NAME.test(name) || valueLooksSecret(value)),
    description: normalizeOptionalString(input.description ?? existing?.description),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  const entries = registry.entries.filter((item) => item.id !== entry.id && item.name !== entry.name)
  writeWorkspaceEnvRegistry({
    ...registry,
    updatedAt: now,
    entries: [...entries, entry].sort((a, b) => a.name.localeCompare(b.name)),
  })
  return redactEntry(entry)
}

export function isSecretLikeName(name: string) {
  return SECRET_NAME.test(name)
}

type ParsedDotenvLine =
  | { kind: "entry"; name: string; value: string; lineNumber: number }
  | { kind: "blank" | "comment"; lineNumber: number }
  | { kind: "malformed"; lineNumber: number; reason: string }

function parseDotenvText(text: string): ParsedDotenvLine[] {
  const out: ParsedDotenvLine[] = []
  const lines = String(text ?? "").split(/\r?\n/)
  lines.forEach((rawLine, index) => {
    const lineNumber = index + 1
    const line = rawLine.trim()
    if (!line) return out.push({ kind: "blank", lineNumber })
    if (line.startsWith("#")) return out.push({ kind: "comment", lineNumber })
    const withoutExport = line.replace(/^export\s+/i, "")
    const eq = withoutExport.indexOf("=")
    if (eq <= 0) return out.push({ kind: "malformed", lineNumber, reason: "missing KEY=VALUE" })
    const name = withoutExport.slice(0, eq).trim()
    if (!VALID_NAME.test(name))
      return out.push({ kind: "malformed", lineNumber, reason: "invalid variable name" })
    let value = withoutExport.slice(eq + 1).trim()
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))))
      value = value.slice(1, -1)
    out.push({ kind: "entry", name, value, lineNumber })
  })
  return out
}

// Validate WITHOUT returning any values (safe for chat/logs/artifacts).
export function validateDotenvText(text: string) {
  const parsed = parseDotenvText(text)
  const entries = parsed.filter((l): l is Extract<ParsedDotenvLine, { kind: "entry" }> => l.kind === "entry")
  const malformed = parsed
    .filter((l): l is Extract<ParsedDotenvLine, { kind: "malformed" }> => l.kind === "malformed")
    .map((l) => ({ lineNumber: l.lineNumber, reason: l.reason }))
  const seen = new Map<string, number>()
  const duplicates: string[] = []
  for (const entry of entries) {
    seen.set(entry.name, (seen.get(entry.name) ?? 0) + 1)
    if (seen.get(entry.name) === 2) duplicates.push(entry.name)
  }
  return {
    ok: malformed.length === 0,
    total: entries.length,
    keys: entries.map((e) => e.name),
    duplicates,
    malformed,
    secretLike: entries.filter((e) => isSecretLikeName(e.name)).map((e) => e.name),
  }
}

// Import dotenv text: last value wins for duplicate keys. Returns a
// value-free summary.
export function importDotenvText(text: string, options: { scope?: string; enabled?: boolean } = {}) {
  const parsed = parseDotenvText(text)
  const malformed = parsed
    .filter((l): l is Extract<ParsedDotenvLine, { kind: "malformed" }> => l.kind === "malformed")
    .map((l) => ({ lineNumber: l.lineNumber, reason: l.reason }))
  // Atomic: never write a partial import. If any line is malformed, reject the
  // whole paste before touching the registry.
  if (malformed.length > 0) {
    return { ok: false, created: 0, updated: 0, imported: 0, duplicateKeysCollapsed: 0, malformed, names: [] }
  }
  const entries = parsed.filter((l): l is Extract<ParsedDotenvLine, { kind: "entry" }> => l.kind === "entry")
  const byName = new Map<string, string>()
  for (const entry of entries) byName.set(entry.name, entry.value)
  const before = readWorkspaceEnvRegistry()
  const existingNames = new Set(before.entries.map((e) => e.name))
  let created = 0
  let updated = 0
  for (const [name, value] of byName) {
    if (existingNames.has(name)) updated++
    else created++
    upsertWorkspaceEnvEntry({ name, value, scope: options.scope, enabled: options.enabled })
  }
  return {
    ok: malformed.length === 0,
    created,
    updated,
    imported: byName.size,
    duplicateKeysCollapsed: entries.length - byName.size,
    malformed,
    names: [...byName.keys()],
  }
}

export function deleteWorkspaceEnvEntry(id: string) {
  const registry = readWorkspaceEnvRegistry()
  const entries = registry.entries.filter((entry) => entry.id !== id)
  const removed = entries.length !== registry.entries.length
  if (removed) writeWorkspaceEnvRegistry({ ...registry, updatedAt: new Date().toISOString(), entries })
  return { removed }
}

export function workspaceEnvForProcess(input: {
  directory?: string
  cwd?: string
  surface?: WorkspaceEnvScope | string
}) {
  const registry = readWorkspaceEnvRegistry()
  const result: Record<string, string> = {}
  for (const entry of registry.entries) {
    if (!entry.enabled) continue
    if (!entryApplies(entry, input)) continue
    result[entry.name] = entry.value
  }
  return result
}

export function workspaceEnvPromptSummary(input: {
  directory?: string
  cwd?: string
  surface?: WorkspaceEnvScope | string
}) {
  const entries = readWorkspaceEnvRegistry().entries.filter((entry) => entry.enabled && entryApplies(entry, input))
  if (entries.length === 0) return undefined
  return [
    "OpenCode workspace environment variables are configured server-side.",
    "Secret values are not shown in this prompt; use tools/terminal processes that inherit them instead of asking for values.",
    "<workspace_env>",
    ...entries.map((entry) =>
      [
        "  <var>",
        `    <name>${entry.name}</name>`,
        `    <scope>${entry.scope}</scope>`,
        `    <secret>${entry.secret ? "yes" : "no"}</secret>`,
        entry.target ? `    <target>${entry.target}</target>` : undefined,
        entry.description ? `    <description>${entry.description}</description>` : undefined,
        "  </var>",
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n"),
    ),
    "</workspace_env>",
  ].join("\n")
}

function writeWorkspaceEnvRegistry(registry: WorkspaceEnvRegistry) {
  const file = workspaceEnvPath()
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(normalizeRegistry(registry), null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, file)
}

function emptyRegistry(): WorkspaceEnvRegistry {
  return { version: 1, updatedAt: new Date(0).toISOString(), entries: [] }
}

function normalizeRegistry(input: Partial<WorkspaceEnvRegistry>): WorkspaceEnvRegistry {
  const entries = Array.isArray(input.entries) ? input.entries.flatMap(normalizeEntry) : []
  return {
    version: 1,
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : new Date(0).toISOString(),
    entries: entries.sort((a, b) => a.name.localeCompare(b.name)),
  }
}

function normalizeEntry(input: unknown): WorkspaceEnvEntry[] {
  if (!input || typeof input !== "object") return []
  const raw = input as Partial<WorkspaceEnvEntry>
  const name = typeof raw.name === "string" ? raw.name.trim() : ""
  if (!VALID_NAME.test(name)) return []
  const now = new Date().toISOString()
  return [
    {
      id: typeof raw.id === "string" && raw.id ? raw.id : randomUUID(),
      name,
      value: typeof raw.value === "string" ? raw.value : "",
      scope: normalizeScope(raw.scope),
      target: normalizeOptionalString(raw.target),
      enabled: raw.enabled !== false,
      secret: raw.secret ?? SECRET_NAME.test(name),
      description: normalizeOptionalString(raw.description),
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : now,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : now,
    },
  ]
}

function normalizeScope(value?: string): WorkspaceEnvScope {
  switch (value) {
    case "global":
    case "repos":
    case "project":
    case "terminal":
    case "bash":
    case "routines":
    case "browser":
    case "preview":
    case "open_design":
      return value
    default:
      return DEFAULT_SCOPE
  }
}

function normalizeOptionalString(value?: string) {
  const next = typeof value === "string" ? value.trim() : ""
  return next ? next : undefined
}

function redactEntry(entry: WorkspaceEnvEntry): WorkspaceEnvPublicEntry {
  const { value: _value, ...rest } = entry
  return {
    ...rest,
    hasValue: entry.value.length > 0,
    // Masked form never contains any characters of the value (safe for secrets
    // and non-secrets alike). Full value is only offered via reveal, and only
    // for non-secret entries.
    maskedValue: entry.value.length === 0 ? "(empty)" : entry.secret ? "••••" : `•••• (${entry.value.length} chars)`,
    valuePreview: entry.secret ? undefined : entry.value,
  }
}

function entryApplies(
  entry: WorkspaceEnvEntry,
  input: { directory?: string; cwd?: string; surface?: WorkspaceEnvScope | string },
) {
  const location = path.resolve(input.cwd || input.directory || process.cwd())
  if (entry.scope === "global") return true
  if (entry.scope === "repos") return contains(workspaceEnvDefaultReposRoot(), location)
  if (entry.scope === "project") return entry.target ? contains(entry.target, location) : false
  return entry.scope === input.surface
}

function contains(parent: string, child: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
}
