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
  valuePreview?: string
}

export type WorkspaceEnvPublicRegistry = Omit<WorkspaceEnvRegistry, "entries"> & {
  path: string
  entries: WorkspaceEnvPublicEntry[]
  secretValuesExposed: false
}

const DEFAULT_SCOPE: WorkspaceEnvScope = "repos"
const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASS|PRIVATE|CREDENTIAL|COOKIE|AUTH|SESSION)/i

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
    secret: input.secret ?? existing?.secret ?? SECRET_NAME.test(name),
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
