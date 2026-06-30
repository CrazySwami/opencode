import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./routines.txt"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

export const Parameters = Schema.Struct({
  action: Schema.optional(Schema.Literals(["status", "list", "get", "logs", "create"])).annotate({
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
})

type Metadata = {
  action: "status" | "list" | "get" | "logs" | "create"
  id?: string
}

export type Routine = {
  id: string
  name: string
  description?: string
  schedule?: string
  command?: string
  enabled: boolean
  tags?: string[]
  notify?: string[]
  createdAt: string
  updatedAt: string
  lastRunAt?: string
  nextRunAt?: string
  lastStatus?: "ok" | "error" | "running" | "never"
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
  action?: "status" | "list" | "get" | "logs" | "create"
  id?: string
  name?: string
  description?: string
  schedule?: string
  command?: string
}) {
  const action = input.action ?? "list"
  if (action === "status") return routinesStatus()
  if (action === "logs") return routineLogs(input.id)
  if (action === "create") return createRoutineDraft(input)
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
    tags: ["draft"],
    notify: ["in-app"],
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
