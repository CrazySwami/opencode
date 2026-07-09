import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./routines.txt"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { spawn } from "node:child_process"
import path from "node:path"

// Hosts a routine can execute on. `ssh` null = run locally (this machine);
// otherwise the command runs via `ssh <alias> <command>`. Extensible — add
// entries here (or later from ~/.ssh/config) to expose more run targets.
export const ROUTINE_HOSTS: Record<string, { label: string; ssh: string | null }> = {
  local: { label: "This machine", ssh: null },
  ct100: { label: "CT100 (hustle-dev)", ssh: "hustle-dev" },
}
const DEFAULT_HOST = "local"
// Hard cap so a runaway routine command can't hang the runner forever.
const ROUTINE_RUN_TIMEOUT_MS = 5 * 60 * 1000
const ROUTINE_OUTPUT_CAP = 64 * 1024

export const Parameters = Schema.Struct({
  action: Schema.optional(Schema.Literals(["status", "list", "get", "logs", "create", "update", "delete", "enable", "disable", "run"])).annotate({
    description: "Routine action to run. Defaults to list.",
  }),
  id: Schema.optional(Schema.String).annotate({
    description: "Routine id for get/logs actions.",
  }),
  name: Schema.optional(Schema.String).annotate({
    description: "Routine name when creating a disabled draft routine.",
  }),
  description: Schema.optional(Schema.String).annotate({
    description: "Routine description when creating a disabled draft routine.",
  }),
  schedule: Schema.optional(Schema.String).annotate({
    description: "Human-readable schedule for a disabled draft routine.",
  }),
  command: Schema.optional(Schema.String).annotate({
    description: "Command to review before enabling the routine.",
  }),
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enabled state for update. Created routines are always disabled drafts.",
  }),
  host: Schema.optional(Schema.String).annotate({
    description: "Machine the routine runs on. One of: local (this machine), ct100 (hustle-dev). Defaults to local.",
  }),
  icon: Schema.optional(Schema.String).annotate({
    description: "Optional icon name/emoji shown for the routine in the UI.",
  }),
  tags: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Optional routine tags for create/update.",
  }),
  notify: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Optional notification channels for create/update.",
  }),
})

type Metadata = {
  action: "status" | "list" | "get" | "logs" | "create" | "update" | "delete" | "enable" | "disable" | "run"
  id?: string
}

export type Routine = {
  id: string
  name: string
  description?: string
  schedule?: string
  command?: string
  enabled: boolean
  host?: string
  icon?: string
  tags?: readonly string[]
  notify?: readonly string[]
  createdAt: string
  updatedAt: string
  lastRunAt?: string
  nextRunAt?: string
  lastStatus?: "ok" | "error" | "running" | "never"
  lastExitCode?: number
}

export type RoutineLog = {
  time: string
  routineID: string
  level: "info" | "warn" | "error"
  message: string
}

export const RoutinesTool = Tool.define<typeof Parameters, Metadata, never>(
  "routines",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>) =>
        Effect.gen(function* () {
          const action = params.action ?? "list"
          const result = yield* Effect.promise(() =>
            routinesAction({
              action,
              id: params.id,
              name: params.name,
              description: params.description,
              schedule: params.schedule,
              command: params.command,
              enabled: params.enabled,
              host: params.host,
              icon: params.icon,
              tags: params.tags,
              notify: params.notify,
            }),
          )
          return {
            title: `routines ${action}`,
            output: JSON.stringify(result, null, 2),
            metadata: { action, id: params.id },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export async function routinesStatus() {
  const home = routinesHome()
  ensureRoutinesStore()
  const routines = readRoutines()
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    home,
    jobsFile: routinesFile(),
    logsDir: routinesLogsDir(),
    mutationsEnabled: routinesMutationsEnabled(),
    runEnabled: routinesRunEnabled(),
    hosts: Object.entries(ROUTINE_HOSTS).map(([id, h]) => ({ id, label: h.label, remote: !!h.ssh })),
    accessBoundaryRequired: routinesMutationsEnabled() ? null : "Set OPENCODE_ROUTINES_MUTATIONS=1 to allow disabled draft writes.",
    mutationPolicy: routinesMutationsEnabled() ? "disabled_draft_writes_enabled" : "disabled_draft_writes_disabled",
    scheduler: {
      engine: "opencode-native-json-store",
      externalPlugin: "opencode-scheduler-compatible",
      note: routinesMutationsEnabled()
        ? "Live route can create disabled draft routines. Manual runs stay disabled unless OPENCODE_ROUTINES_RUN_ENABLED=1."
        : "The tab/tool can wrap opencode-scheduler later; disabled draft writes are off until OPENCODE_ROUTINES_MUTATIONS=1.",
    },
    counts: {
      total: routines.length,
      enabled: routines.filter((routine) => routine.enabled).length,
      disabled: routines.filter((routine) => !routine.enabled).length,
      errors: routines.filter((routine) => routine.lastStatus === "error").length,
    },
  }
}

export async function routinesAction(input: {
  action?: "status" | "list" | "get" | "logs" | "create" | "update" | "delete" | "enable" | "disable" | "run"
  id?: string
  name?: string
  description?: string
  schedule?: string
  command?: string
  enabled?: boolean
  host?: string
  icon?: string
  tags?: readonly string[]
  notify?: readonly string[]
}) {
  const action = input.action ?? "list"
  if (action === "status") return routinesStatus()
  if (action === "logs") return routineLogs(input.id)
  if (action === "create") return createRoutineDraft(input)
  if (action === "update") return updateRoutine(input.id, input)
  if (action === "delete") return deleteRoutine(input.id)
  if (action === "enable") return updateRoutine(input.id, { enabled: true })
  if (action === "disable") return updateRoutine(input.id, { enabled: false })
  if (action === "run") return runRoutine(input.id)
  if (action === "get") {
    const routine = readRoutines().find((item) => item.id === input.id)
    return { ok: !!routine, routine: routine ?? null }
  }
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    routines: readRoutines(),
    status: await routinesStatus(),
  }
}

export async function createRoutineDraft(input: {
  name?: string
  description?: string
  schedule?: string
  command?: string
  host?: string
  icon?: string
  tags?: readonly string[]
  notify?: readonly string[]
}) {
  if (!routinesMutationsEnabled()) {
    return {
      ok: false,
      error: "Disabled draft routine creation is not enabled.",
      mutationPolicy: "disabled_draft_writes_disabled",
    }
  }
  const name = input.name?.trim()
  if (!name) {
    return {
      ok: false,
      error: "Routine name is required.",
    }
  }

  const now = new Date().toISOString()
  const routines = readRoutines()
  const routine: Routine = {
    id: uniqueRoutineID(name, routines),
    name,
    description: optionalText(input.description),
    schedule: optionalText(input.schedule) || "manual",
    command: optionalText(input.command),
    enabled: false,
    host: input.host && ROUTINE_HOSTS[input.host] ? input.host : DEFAULT_HOST,
    icon: optionalText(input.icon),
    tags: sanitizedList(input.tags, ["draft"]),
    notify: sanitizedList(input.notify, ["in-app"]),
    createdAt: now,
    updatedAt: now,
    lastStatus: "never",
  }
  writeRoutines([...routines, routine])
  return {
    ok: true,
    generatedAt: now,
    routine,
    status: await routinesStatus(),
  }
}

export async function updateRoutine(
  id: string | undefined,
  input: {
    name?: string
    description?: string
    schedule?: string
    command?: string
    enabled?: boolean
    host?: string
    icon?: string
    tags?: readonly string[]
    notify?: readonly string[]
  },
) {
  if (!routinesMutationsEnabled()) {
    return {
      ok: false,
      error: "Routine updates are not enabled.",
      mutationPolicy: "disabled_draft_writes_disabled",
    }
  }
  const safe = id ? safeID(id) : undefined
  if (!safe) return { ok: false, error: "Routine id is required." }
  const routines = readRoutines()
  const index = routines.findIndex((routine) => routine.id === safe)
  if (index < 0) return { ok: false, error: `Routine not found: ${safe}` }

  const current = routines[index]!
  const updated: Routine = {
    ...current,
    name: optionalText(input.name) ?? current.name,
    description: input.description === undefined ? current.description : optionalText(input.description),
    schedule: input.schedule === undefined ? current.schedule : optionalText(input.schedule) || "manual",
    command: input.command === undefined ? current.command : optionalText(input.command),
    enabled: typeof input.enabled === "boolean" ? input.enabled : current.enabled,
    host: input.host === undefined ? current.host : input.host && ROUTINE_HOSTS[input.host] ? input.host : DEFAULT_HOST,
    icon: input.icon === undefined ? current.icon : optionalText(input.icon),
    tags: input.tags === undefined ? cloneList(current.tags) : sanitizedList(input.tags, current.tags ?? []),
    notify: input.notify === undefined ? cloneList(current.notify) : sanitizedList(input.notify, current.notify ?? []),
    updatedAt: new Date().toISOString(),
  }
  routines[index] = updated
  writeRoutines(routines)
  return {
    ok: true,
    generatedAt: updated.updatedAt,
    routine: updated,
    status: await routinesStatus(),
  }
}

export async function deleteRoutine(id: string | undefined) {
  if (!routinesMutationsEnabled()) {
    return {
      ok: false,
      error: "Routine deletes are not enabled.",
      mutationPolicy: "disabled_draft_writes_disabled",
    }
  }
  const safe = id ? safeID(id) : undefined
  if (!safe) return { ok: false, error: "Routine id is required." }
  const routines = readRoutines()
  const next = routines.filter((routine) => routine.id !== safe)
  if (next.length === routines.length) return { ok: false, error: `Routine not found: ${safe}` }
  writeRoutines(next)
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    deletedID: safe,
    status: await routinesStatus(),
  }
}

function routineLogFile(routineID: string) {
  return path.join(routinesLogsDir(), `${safeID(routineID)}.jsonl`)
}

function appendRoutineLog(routineID: string, level: RoutineLog["level"], message: string) {
  ensureRoutinesStore()
  const entry: RoutineLog = { time: new Date().toISOString(), routineID, level, message }
  try {
    appendFileSync(routineLogFile(routineID), JSON.stringify(entry) + "\n")
  } catch {
    // best-effort logging; never let a log write fail a run
  }
}

function patchRoutine(id: string, patch: Partial<Routine>) {
  const routines = readRoutines()
  const idx = routines.findIndex((routine) => routine.id === id)
  if (idx === -1) return
  routines[idx] = { ...routines[idx], ...patch, updatedAt: new Date().toISOString() }
  writeRoutines(routines)
}

// Execute a routine command on the selected host. ssh=null runs locally via a
// shell; otherwise it runs over `ssh <alias>` (BatchMode so it never blocks on a
// password prompt). Output is capped and the whole run is time-boxed.
function runCommandOnHost(host: string, command: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const target = ROUTINE_HOSTS[host] ?? ROUTINE_HOSTS[DEFAULT_HOST]
    const [cmd, args] = target.ssh
      ? (["ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", target.ssh, command]] as const)
      : (["/bin/sh", ["-c", command]] as const)
    let output = ""
    let done = false
    const append = (buf: Buffer) => {
      if (output.length >= ROUTINE_OUTPUT_CAP) return
      output += buf.toString("utf8")
      if (output.length > ROUTINE_OUTPUT_CAP) output = output.slice(0, ROUTINE_OUTPUT_CAP) + "\n…(truncated)"
    }
    const settle = (code: number, extra?: string) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code, output: extra ? output + extra : output })
    }
    const child = spawn(cmd, args as unknown as string[], { stdio: ["ignore", "pipe", "pipe"] })
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      settle(124, "\n…(timed out)")
    }, ROUTINE_RUN_TIMEOUT_MS)
    child.stdout?.on("data", append)
    child.stderr?.on("data", append)
    child.on("error", (err) => settle(127, `\nspawn error: ${err.message}`))
    child.on("close", (code) => settle(code ?? 0))
  })
}

export async function runRoutine(id: string | undefined) {
  const safe = id ? safeID(id) : undefined
  if (!safe) return { ok: false, error: "Routine id is required." }
  const routine = readRoutines().find((item) => item.id === safe)
  if (!routine) return { ok: false, error: `Routine not found: ${safe}` }
  if (!routinesRunEnabled()) {
    return {
      ok: false,
      routine,
      error: "Routine manual runs are disabled. Set OPENCODE_ROUTINES_RUN_ENABLED=1 to allow routine command execution.",
      mutationPolicy: "manual_runs_disabled",
    }
  }
  if (!routine.command || !routine.command.trim()) {
    return { ok: false, routine, error: "Routine has no command to run." }
  }
  const host = routine.host && ROUTINE_HOSTS[routine.host] ? routine.host : DEFAULT_HOST
  const startedAt = new Date().toISOString()
  patchRoutine(safe, { lastStatus: "running", lastRunAt: startedAt })
  appendRoutineLog(safe, "info", `run started on host=${host} (${ROUTINE_HOSTS[host].label})`)

  const { code, output } = await runCommandOnHost(host, routine.command)
  const status: Routine["lastStatus"] = code === 0 ? "ok" : "error"
  for (const line of output.split(/\r?\n/).filter(Boolean).slice(-100)) {
    appendRoutineLog(safe, status === "ok" ? "info" : "error", line)
  }
  appendRoutineLog(safe, status === "ok" ? "info" : "error", `run finished exit=${code} status=${status}`)
  patchRoutine(safe, { lastStatus: status, lastExitCode: code })

  return {
    ok: code === 0,
    generatedAt: new Date().toISOString(),
    routine: readRoutines().find((item) => item.id === safe),
    run: { host, hostLabel: ROUTINE_HOSTS[host].label, exitCode: code, status, output: output.slice(0, 4000) },
  }
}

export function readRoutines(): Routine[] {
  ensureRoutinesStore()
  try {
    const parsed = JSON.parse(readFileSync(routinesFile(), "utf8")) as { routines?: Routine[] }
    return Array.isArray(parsed.routines) ? parsed.routines : []
  } catch {
    return []
  }
}

export async function routineLogs(id?: string) {
  ensureRoutinesStore()
  const ids = id ? [id] : readRoutines().map((routine) => routine.id)
  const logs = ids.flatMap((routineID) => readRoutineLogFile(routineID).map((log) => ({ ...log, routineID }))).slice(-200)
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    logs,
  }
}

function readRoutineLogFile(routineID: string): RoutineLog[] {
  const file = path.join(routinesLogsDir(), `${safeID(routineID)}.jsonl`)
  if (!existsSync(file)) return []
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as RoutineLog]
      } catch {
        return []
      }
    })
}

function ensureRoutinesStore() {
  mkdirSync(routinesHome(), { recursive: true })
  mkdirSync(routinesLogsDir(), { recursive: true })
  if (existsSync(routinesFile())) return
  const now = new Date().toISOString()
  const seed: Routine[] = [
    {
      id: "daily-open-code-health",
      name: "Daily OpenCode Health",
      description: "Check OpenCode live route, workspace status, and recent routine logs.",
      schedule: "daily 09:00",
      command: "curl -fsS https://code.hustletogether.com/__health",
      enabled: false,
      tags: ["opencode", "health"],
      notify: ["in-app"],
      createdAt: now,
      updatedAt: now,
      lastStatus: "never",
    },
  ]
  writeFileSync(routinesFile(), JSON.stringify({ routines: seed }, null, 2) + "\n")
}

function writeRoutines(routines: Routine[]) {
  ensureRoutinesStore()
  writeFileSync(routinesFile(), JSON.stringify({ routines }, null, 2) + "\n")
}

function routinesHome() {
  return process.env.OPENCODE_ROUTINES_HOME || path.join(process.env.XDG_DATA_HOME || path.join(process.env.HOME || "/home/dev", ".local/share"), "opencode-routines")
}

function routinesFile() {
  return path.join(routinesHome(), "routines.json")
}

function routinesLogsDir() {
  return path.join(routinesHome(), "logs")
}

function routinesMutationsEnabled() {
  if (process.env.OPENCODE_ROUTINES_MUTATIONS !== undefined) return process.env.OPENCODE_ROUTINES_MUTATIONS === "1"
  return process.env.OPENCODE_HOSTNAME === "code.hustletogether.com"
}

function routinesRunEnabled() {
  return routinesMutationsEnabled() && process.env.OPENCODE_ROUTINES_RUN_ENABLED === "1"
}

function safeID(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120)
}

function optionalText(value?: string) {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function sanitizedList(values: readonly string[] | undefined, fallback: readonly string[]) {
  const next = (values ?? [])
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 12)
  return next.length > 0 ? Array.from(new Set(next)) : [...fallback]
}

function cloneList(values: readonly string[] | undefined) {
  return values === undefined ? undefined : [...values]
}

function uniqueRoutineID(name: string, routines: Routine[]) {
  const base = safeID(name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")) || "routine"
  const existing = new Set(routines.map((routine) => routine.id))
  if (!existing.has(base)) return base
  for (let index = 2; index < 1000; index++) {
    const candidate = `${base}-${index}`
    if (!existing.has(candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}
