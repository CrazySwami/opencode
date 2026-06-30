import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./routines.txt"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

export const Parameters = Schema.Struct({
  action: Schema.optional(Schema.Literals(["status", "list", "get", "logs"])).annotate({
    description: "Routine action to run. Defaults to list.",
  }),
  id: Schema.optional(Schema.String).annotate({
    description: "Routine id for get/logs actions.",
  }),
})

type Metadata = {
  action: "status" | "list" | "get" | "logs"
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
          const result = yield* Effect.promise(() => routinesAction({ action, id: params.id }))
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
    accessBoundaryRequired: "Cloudflare Access GitHub login for code.hustletogether.com",
    scheduler: {
      engine: "opencode-native-json-store",
      externalPlugin: "opencode-scheduler-compatible",
      note: "The tab/tool can wrap opencode-scheduler later; current live public route keeps mutations disabled until Access is verified.",
    },
    counts: {
      total: routines.length,
      enabled: routines.filter((routine) => routine.enabled).length,
      disabled: routines.filter((routine) => !routine.enabled).length,
      errors: routines.filter((routine) => routine.lastStatus === "error").length,
    },
  }
}

export async function routinesAction(input: { action?: "status" | "list" | "get" | "logs"; id?: string }) {
  const action = input.action ?? "list"
  if (action === "status") return routinesStatus()
  if (action === "logs") return routineLogs(input.id)
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
  return process.env.OPENCODE_ROUTINES_MUTATIONS === "1" && process.env.OPENCODE_CLOUDFLARE_ACCESS_AUD && process.env.OPENCODE_CLOUDFLARE_ACCESS_TEAM_DOMAIN
}

function routinesRunEnabled() {
  return routinesMutationsEnabled() && process.env.OPENCODE_ROUTINES_RUN_ENABLED === "1"
}

function safeID(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120)
}
