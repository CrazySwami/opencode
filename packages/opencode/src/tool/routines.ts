import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./routines.txt"
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs"
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
// Per-routine log file rotates once it exceeds this size; we keep one .1 backup.
const ROUTINE_LOG_MAX_BYTES = 512 * 1024
// Bytes of log tail we read back (avoids loading a large jsonl fully into RAM).
const ROUTINE_LOG_READ_TAIL_BYTES = 128 * 1024
// Env vars a routine command is allowed to inherit. Everything else (secrets,
// tokens, provider keys on the server process) is stripped from the spawn env.
const ROUTINE_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "SHELL",
  "SSH_AUTH_SOCK",
  "TZ",
]

// Caller identity for a run request. `tool` = model/agent-initiated (must carry
// an approval token minted by the tool's ctx.ask gate). `http` = the routines
// HTTP surface (operator UI). `internal` = scheduler/self (future).
export type RoutineCaller = "tool" | "http" | "internal"

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
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const action = params.action ?? "list"
          // MUST-FIX #1: routine execution is arbitrary shell (locally OR over
          // ssh to another box), so a model/agent asking to `run` a routine has
          // to pass the SAME approval gate as the shell tool — never auto-run.
          // We prompt with the resolved command + host so the human sees exactly
          // what will execute. Rejection dies the effect before anything runs.
          let approval: string | undefined
          let enableApproval: string | undefined
          if (action === "run") {
            const routine = readRoutines().find((item) => item.id === safeID(params.id ?? ""))
            const command = routine?.command?.trim() ?? ""
            const host = routine?.host && ROUTINE_HOSTS[routine.host] ? routine.host : DEFAULT_HOST
            const hostLabel = ROUTINE_HOSTS[host]?.label ?? host
            if (routine && command) {
              yield* ctx.ask({
                // Dedicated permission key (independent of, and never weaker
                // than, the bash allowlist): defaults to "ask" so a routine run
                // is never silently auto-approved by an unrelated bash rule.
                permission: "routines",
                patterns: [`${host}:: ${command}`],
                always: [`routines run ${host}`],
                metadata: {
                  routineID: routine.id,
                  routineName: routine.name,
                  host,
                  hostLabel,
                  command,
                },
              })
              approval = mintRunApproval(routine.id, { command, host, updatedAt: routine.updatedAt })
            }
          } else if (action === "enable" || (action === "update" && params.enabled === true)) {
            // Anti-bypass: ENABLING a routine authorizes the scheduler to run it
            // autonomously on its schedule (no per-fire ctx.ask). So enabling via
            // the model/tool must itself pass the same human approval gate as a
            // manual run — the human sees the command/host/schedule that will run
            // on a timer. Rejection dies the effect; enabled stays off.
            const routine = readRoutines().find((item) => item.id === safeID(params.id ?? ""))
            if (routine) {
              const command = (action === "update" && params.command !== undefined ? params.command : routine.command)?.trim() ?? ""
              const host = resolveHostInput(
                action === "update" && params.host !== undefined ? params.host : routine.host,
              )
              const schedule = (action === "update" && params.schedule !== undefined ? params.schedule : routine.schedule) || "manual"
              yield* ctx.ask({
                permission: "routines",
                patterns: [`enable ${host}:: ${command} @ ${schedule}`],
                always: [`routines enable ${host}`],
                metadata: {
                  routineID: routine.id,
                  routineName: routine.name,
                  host,
                  command,
                  schedule,
                  intent: "enable-for-schedule",
                },
              })
              // Bind the approval to exactly what the human saw (Codex High):
              // command/host/schedule + the routine version at approval time.
              enableApproval = mintEnableApproval(routine.id, { command, host, schedule, updatedAt: routine.updatedAt })
            }
          }
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
              caller: "tool",
              approval,
              enableApproval,
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
  reconcileStaleRunning()
  const routines = readRoutines()
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    home,
    jobsFile: routinesFile(),
    logsDir: routinesLogsDir(),
    mutationsEnabled: routinesMutationsEnabled(),
    runEnabled: routinesRunEnabled(),
    operatorTokenRequired: !!routinesOperatorToken(),
    hosts: Object.entries(ROUTINE_HOSTS).map(([id, h]) => ({ id, label: h.label, remote: !!h.ssh })),
    accessBoundaryRequired: routinesMutationsEnabled() ? null : "Set OPENCODE_ROUTINES_MUTATIONS=1 to allow disabled draft writes.",
    mutationPolicy: routinesMutationsEnabled() ? "disabled_draft_writes_enabled" : "disabled_draft_writes_disabled",
    scheduler: {
      engine: "opencode-native-json-store",
      active: !!schedulerTimer,
      tickMs: SCHEDULER_TICK_MS,
      fires: routinesRunEnabled(),
      formats: ["manual", "hourly", "daily HH:MM", "weekly <dow> HH:MM", "every N[m|h|s]"],
      note: routinesRunEnabled()
        ? "Scheduler is armed: enabled routines fire on their schedule."
        : "Scheduler tracks nextRunAt but does NOT execute until OPENCODE_ROUTINES_RUN_ENABLED=1.",
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
  caller?: RoutineCaller
  approval?: string
  enableApproval?: string
  operatorToken?: string
}) {
  const action = input.action ?? "list"
  const caller = input.caller ?? "http"
  const authFields = { caller, enableApproval: input.enableApproval, operatorToken: input.operatorToken }
  if (action === "status") return routinesStatus()
  if (action === "logs") return routineLogs(input.id)
  if (action === "create") return createRoutineDraft(input)
  if (action === "update") return updateRoutine(input.id, { ...input, ...authFields })
  if (action === "delete") return deleteRoutine(input.id)
  if (action === "enable") return updateRoutine(input.id, { enabled: true, ...authFields })
  if (action === "disable") return updateRoutine(input.id, { enabled: false, ...authFields })
  if (action === "run")
    return runRoutine(input.id, {
      caller: input.caller ?? "http",
      approval: input.approval,
      operatorToken: input.operatorToken,
    })
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

// Is this caller allowed to move a routine into the enabled (schedule-armed)
// state? tool → only with a fresh ctx.ask approval; http → operator (token when
// one is configured); internal (scheduler) → yes. Anything else → no.
function authorizeEnable(
  input: { caller?: RoutineCaller; enableApproval?: string; operatorToken?: string },
  verify: { routineId: string; nextCommand?: string; nextHost?: string; nextSchedule?: string; currentUpdatedAt?: string },
): boolean {
  switch (input.caller ?? "http") {
    case "internal":
      return true
    case "tool": {
      // Single-use nonce bound to what the human approved. It authorizes enabling
      // ONLY IF the routine still matches that exact snapshot — command, host,
      // schedule, and version (updatedAt) — verified against a fresh read. A
      // concurrent edit (which bumps updatedAt / changes the command) invalidates it.
      if (!input.enableApproval) return false
      const snap = consumeEnableApproval(verify.routineId, input.enableApproval)
      if (!snap) return false
      const norm = (x?: string) => (x || "").trim()
      const sched = (x?: string) => norm(x) || "manual"
      return (
        norm(snap.command) === norm(verify.nextCommand) &&
        snap.host === resolveHostInput(verify.nextHost) &&
        sched(snap.schedule) === sched(verify.nextSchedule) &&
        snap.updatedAt === verify.currentUpdatedAt
      )
    }
    case "http": {
      const token = routinesOperatorToken()
      return !token || input.operatorToken === token
    }
    default:
      return false
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
    caller?: RoutineCaller
    enableApproval?: string
    operatorToken?: string
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
  const nextName = optionalText(input.name) ?? current.name
  const nextDescription = input.description === undefined ? current.description : optionalText(input.description)
  const nextSchedule = input.schedule === undefined ? current.schedule : optionalText(input.schedule) || "manual"
  const nextCommand = input.command === undefined ? current.command : optionalText(input.command)
  const nextHost = input.host === undefined ? current.host : resolveHostInput(input.host)
  const nextIcon = input.icon === undefined ? current.icon : optionalText(input.icon)

  // Anti-bypass gate for scheduled execution (see tool execute): the enabled
  // state may only become/stay true through an authorized action, and editing
  // what runs (command/host/schedule) revokes approval.
  const contentChanged =
    nextCommand !== current.command || nextHost !== current.host || nextSchedule !== current.schedule
  const wantsEnabled = typeof input.enabled === "boolean" ? input.enabled : current.enabled
  let finalEnabled: boolean
  if (!wantsEnabled) {
    finalEnabled = false
  } else if (current.enabled === true && !contentChanged) {
    // already armed and nothing that runs changed → stays enabled
    finalEnabled = true
  } else if (
    authorizeEnable(input, {
      routineId: safe,
      nextCommand,
      nextHost,
      nextSchedule,
      currentUpdatedAt: current.updatedAt,
    })
  ) {
    finalEnabled = true
  } else if (input.enabled === true) {
    // explicit enable request without authorization → reject
    return {
      ok: false,
      error: "Enabling a routine for scheduled execution requires approval.",
      mutationPolicy: "enable_approval_required",
    }
  } else {
    // content edit on an armed routine without re-approval → de-arm it
    finalEnabled = false
  }

  const updated: Routine = {
    ...current,
    name: nextName,
    description: nextDescription,
    schedule: nextSchedule,
    command: nextCommand,
    enabled: finalEnabled,
    host: nextHost,
    icon: nextIcon,
    tags: input.tags === undefined ? cloneList(current.tags) : sanitizedList(input.tags, current.tags ?? []),
    notify: input.notify === undefined ? cloneList(current.notify) : sanitizedList(input.notify, current.notify ?? []),
    // Re-arm the schedule clock when the routine transitions into enabled.
    nextRunAt:
      finalEnabled && !current.enabled ? computeNextRunAt(nextSchedule, new Date()) : finalEnabled ? current.nextRunAt : undefined,
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

// Rotate the per-routine log once it passes the size cap: current → .1 (one
// backup kept), then start fresh. Keeps disk bounded (MUST-FIX #6).
function rotateRoutineLogIfNeeded(routineID: string) {
  const file = routineLogFile(routineID)
  try {
    if (!existsSync(file)) return
    if (statSync(file).size < ROUTINE_LOG_MAX_BYTES) return
    const backup = file + ".1"
    try {
      if (existsSync(backup)) unlinkSync(backup)
    } catch {
      // ignore
    }
    renameSync(file, backup)
  } catch {
    // best-effort rotation; never let it fail a run
  }
}

function appendRoutineLog(routineID: string, level: RoutineLog["level"], message: string) {
  ensureRoutinesStore()
  rotateRoutineLogIfNeeded(routineID)
  const entry: RoutineLog = { time: new Date().toISOString(), routineID, level, message }
  try {
    appendFileSync(routineLogFile(routineID), JSON.stringify(entry) + "\n")
  } catch {
    // best-effort logging; never let a log write fail a run
  }
}

// Patch RUNTIME metadata (lastStatus/lastRunAt/lastExitCode/nextRunAt) only.
// Deliberately does NOT touch updatedAt — that field tracks user EDITS and is
// compared against the run-approval snapshot, so a scheduler tick or a status
// write must not bump it (would falsely invalidate an approval / churn edits).
function patchRoutine(id: string, patch: Partial<Routine>) {
  const routines = readRoutines()
  const idx = routines.findIndex((routine) => routine.id === id)
  if (idx === -1) return
  routines[idx] = { ...routines[idx], ...patch }
  writeRoutines(routines)
}

// Build a minimal environment for a spawned routine command. The server process
// holds provider API keys / tokens in its env; a routine command must NOT
// inherit those (MUST-FIX #7). Only an explicit allowlist is passed through.
function minimalSpawnEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ROUTINE_ENV_ALLOWLIST) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

// Collect secret-looking values from the server env so we can scrub any that
// leak into captured command output (MUST-FIX #7). Values shorter than 6 chars
// are ignored to avoid masking noise.
function secretValues(): string[] {
  const secrets = new Set<string>()
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || value.length < 6) continue
    if (/(TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|SESSION|COOKIE|API)/i.test(key)) secrets.add(value)
  }
  return Array.from(secrets)
}

function redactOutput(output: string, secrets: string[]): string {
  let redacted = output
  for (const secret of secrets) {
    if (!secret) continue
    redacted = redacted.split(secret).join("***REDACTED***")
  }
  return redacted
}

// Execute a routine command on the selected host. ssh=null runs locally via a
// shell; otherwise it runs over `ssh <alias>` (BatchMode so it never blocks on a
// password prompt). The command runs in its own process group so a timeout can
// kill the WHOLE tree (MUST-FIX #5), and remote runs are additionally wrapped in
// a remote-side `timeout` so a dropped ssh connection can't orphan the remote
// process. Output is capped, secret-scrubbed, and the run is time-boxed.
function runCommandOnHost(host: string, command: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const target = ROUTINE_HOSTS[host]!
    const timeoutSecs = Math.ceil(ROUTINE_RUN_TIMEOUT_MS / 1000)
    let cmd: string
    let args: string[]
    if (target.ssh) {
      // base64 the command so no quoting/injection through the remote shell is
      // possible, and self-terminate remotely via `timeout` so a killed ssh
      // client can't leave the remote command running. `setsid` puts it in its
      // own session/group so `timeout` reaps children too.
      const b64 = Buffer.from(command, "utf8").toString("base64")
      const remote = `printf %s ${b64} | base64 -d | setsid timeout -k 5 -s TERM ${timeoutSecs} bash`
      cmd = "ssh"
      args = [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "StrictHostKeyChecking=accept-new",
        target.ssh,
        remote,
      ]
    } else {
      cmd = "/bin/sh"
      args = ["-c", command]
    }
    const secrets = secretValues()
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
      resolve({ code, output: redactOutput(extra ? output + extra : output, secrets) })
    }
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // own process group → group-kill on timeout
      env: minimalSpawnEnv(),
    })
    const killTree = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch {
        try {
          child.kill(signal)
        } catch {
          // process already gone
        }
      }
    }
    const timer = setTimeout(() => {
      killTree("SIGKILL")
      settle(124, "\n…(timed out)")
    }, ROUTINE_RUN_TIMEOUT_MS)
    child.stdout?.on("data", append)
    child.stderr?.on("data", append)
    child.on("error", (err) => settle(127, `\nspawn error: ${err.message}`))
    child.on("close", (code) => settle(code ?? 0))
  })
}

export async function runRoutine(
  id: string | undefined,
  auth: { caller: RoutineCaller; approval?: string; operatorToken?: string } = { caller: "http" },
) {
  const safe = id ? safeID(id) : undefined
  if (!safe) return { ok: false, error: "Routine id is required." }
  reconcileStaleRunning()
  const routine = readRoutines().find((item) => item.id === safe)
  if (!routine) return { ok: false, error: `Routine not found: ${safe}` }

  // Layer 1: global kill-switch. Live box keeps this OFF.
  if (!routinesRunEnabled()) {
    return {
      ok: false,
      routine,
      error: "Routine manual runs are disabled. Set OPENCODE_ROUTINES_RUN_ENABLED=1 to allow routine command execution.",
      mutationPolicy: "manual_runs_disabled",
    }
  }

  // Layer 2: caller authorization (MUST-FIX #1/#2). A model/agent `tool` caller
  // must present a single-use approval token minted by the ctx.ask gate; an
  // `http` operator caller must present the operator token when one is
  // configured. `internal` = the scheduler, which is server-only code
  // unreachable by any model — its authorization is that enabling the routine
  // was already human-approved (see authorizeEnable / force-disable-on-edit).
  let approvedSnapshot: RunApprovalSnapshot | undefined
  if (auth.caller === "tool") {
    approvedSnapshot = auth.approval ? consumeRunApproval(safe, auth.approval) : undefined
    if (!approvedSnapshot) {
      return { ok: false, routine, error: "Routine run was not approved.", mutationPolicy: "approval_required" }
    }
  } else if (auth.caller === "http") {
    const required = routinesOperatorToken()
    if (required && auth.operatorToken !== required) {
      return { ok: false, routine, error: "Operator token required to run routines.", mutationPolicy: "operator_token_required" }
    }
  } else if (auth.caller !== "internal") {
    return { ok: false, routine, error: `Caller '${auth.caller}' cannot run routines.`, mutationPolicy: "caller_not_allowed" }
  }

  // Layer 3: only enabled routines run (MUST-FIX #2). Draft/disabled routines
  // are never executable regardless of who asks.
  if (!routine.enabled) {
    return { ok: false, routine, error: "Routine is disabled. Enable it before running.", mutationPolicy: "routine_disabled" }
  }
  if (!routine.command || !routine.command.trim()) {
    return { ok: false, routine, error: "Routine has no command to run." }
  }

  // Layer 4: fail-closed host (MUST-FIX #3). An unknown host is an error — never
  // silently fall back to executing on `local`.
  if (routine.host !== undefined && !ROUTINE_HOSTS[routine.host]) {
    return { ok: false, routine, error: `Unknown host '${routine.host}'.`, mutationPolicy: "invalid_host" }
  }

  // Layer 5: run-lock (MUST-FIX #4). Atomic lockfile prevents concurrent runs
  // (and the patchRoutine read-modify-write race). Stale locks (crashed run)
  // are recovered by reconcileStaleRunning above + acquireRunLock below.
  const lock = acquireRunLock(safe)
  if (!lock.ok || !lock.owner) {
    return { ok: false, routine, error: "Routine is already running.", mutationPolicy: "already_running" }
  }
  const lockOwner = lock.owner

  try {
    // Re-read under the lock and, for tool callers, confirm the command/host/
    // version still match exactly what the human approved (Codex finding #1).
    // This closes the window where a PATCH between ctx.ask and execution could
    // swap in a different command under the original approval.
    const fresh = readRoutines().find((item) => item.id === safe)
    if (!fresh) return { ok: false, error: `Routine not found: ${safe}` }
    const freshHost = fresh.host ?? DEFAULT_HOST
    if (approvedSnapshot) {
      const commandChanged = (fresh.command ?? "").trim() !== approvedSnapshot.command
      const hostChanged = freshHost !== approvedSnapshot.host
      const versionChanged = fresh.updatedAt !== approvedSnapshot.updatedAt
      if (commandChanged || hostChanged || versionChanged) {
        return {
          ok: false,
          routine: fresh,
          error: "Routine changed since it was approved. Re-run to approve the current command.",
          mutationPolicy: "approval_stale",
        }
      }
    }
    if (freshHost !== undefined && !ROUTINE_HOSTS[freshHost]) {
      return { ok: false, routine: fresh, error: `Unknown host '${freshHost}'.`, mutationPolicy: "invalid_host" }
    }
    if (!fresh.enabled) {
      return { ok: false, routine: fresh, error: "Routine is disabled. Enable it before running.", mutationPolicy: "routine_disabled" }
    }
    if (!fresh.command || !fresh.command.trim()) {
      return { ok: false, routine: fresh, error: "Routine has no command to run." }
    }

    const startedAt = new Date().toISOString()
    patchRoutine(safe, { lastStatus: "running", lastRunAt: startedAt })
    appendRoutineLog(safe, "info", `run started on host=${freshHost} (${ROUTINE_HOSTS[freshHost]!.label})`)

    const { code, output } = await runCommandOnHost(freshHost, fresh.command)
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
      run: { host: freshHost, hostLabel: ROUTINE_HOSTS[freshHost]!.label, exitCode: code, status, output: output.slice(0, 4000) },
    }
  } finally {
    releaseRunLock(safe, lockOwner)
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

// Read back only the tail of the log (MUST-FIX #6): open the file, seek to the
// last ROUTINE_LOG_READ_TAIL_BYTES, and parse whole lines. Never loads a large
// rotated log fully into memory. A partial first line (cut by the seek) is
// dropped by JSON.parse failing.
function readLogTail(file: string): RoutineLog[] {
  if (!existsSync(file)) return []
  let fd: number | undefined
  try {
    const size = statSync(file).size
    const start = size > ROUTINE_LOG_READ_TAIL_BYTES ? size - ROUTINE_LOG_READ_TAIL_BYTES : 0
    const length = size - start
    if (length <= 0) return []
    fd = openSync(file, "r")
    const buf = Buffer.allocUnsafe(length)
    let read = 0
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, start + read)
      if (n <= 0) break
      read += n
    }
    return buf
      .subarray(0, read)
      .toString("utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as RoutineLog]
        } catch {
          return []
        }
      })
  } catch {
    return []
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // ignore
      }
    }
  }
}

function readRoutineLogFile(routineID: string): RoutineLog[] {
  const file = path.join(routinesLogsDir(), `${safeID(routineID)}.jsonl`)
  return readLogTail(file)
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

// Optional operator token gating HTTP `run` requests. When set, the routines UI
// / HTTP surface must present it (MUST-FIX #2/#8). Unset = rely on the outer
// server auth layer only.
function routinesOperatorToken() {
  const token = process.env.OPENCODE_ROUTINES_OPERATOR_TOKEN?.trim()
  return token ? token : undefined
}

function resolveHostInput(host: string | undefined): string {
  return host && ROUTINE_HOSTS[host] ? host : DEFAULT_HOST
}

// --- Scheduler ---------------------------------------------------------------
// A single in-process timer fires enabled routines when their schedule comes
// due. It routes through runRoutine with caller:"internal", so it inherits ALL
// the run gates — most importantly `routinesRunEnabled()`, which is OFF on live,
// so the scheduler is INERT until execution is explicitly enabled. Its authority
// to run without a per-fire prompt comes from the approval-gated enable +
// force-disable-on-edit invariant (see updateRoutine / authorizeEnable).
const SCHEDULER_TICK_MS = 30 * 1000
const DOW: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

function nextDailyAt(from: Date, hour: number, minute: number): Date | undefined {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined
  const next = new Date(from)
  next.setHours(hour, minute, 0, 0)
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1)
  return next
}

function nextWeeklyAt(from: Date, dow: number, hour: number, minute: number): Date | undefined {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined
  const next = new Date(from)
  next.setHours(hour, minute, 0, 0)
  let delta = (dow - next.getDay() + 7) % 7
  if (delta === 0 && next.getTime() <= from.getTime()) delta = 7
  next.setDate(next.getDate() + delta)
  return next
}

// Next fire time strictly after `from`, or undefined for manual/unrecognized
// schedules (which are treated as never-auto-run — fail safe). Supported:
// "manual", "hourly", "daily [HH:MM]", "weekly <dow> HH:MM", "every N[m|h|s]".
function computeNextRunDate(schedule: string | undefined, from: Date): Date | undefined {
  const s = (schedule ?? "").trim().toLowerCase()
  if (!s || s === "manual" || s === "never" || s === "none" || s === "off") return undefined

  const every = s.match(/^every\s+(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/)
  if (every) {
    const n = parseInt(every[1]!, 10)
    if (!n || n < 1) return undefined
    const unit = every[2]![0]
    const ms = unit === "s" ? n * 1000 : unit === "h" ? n * 3_600_000 : n * 60_000
    return new Date(from.getTime() + ms)
  }
  if (s === "hourly") {
    const next = new Date(from)
    next.setMinutes(0, 0, 0)
    next.setHours(next.getHours() + 1)
    return next
  }
  if (s === "daily") return nextDailyAt(from, 9, 0)
  const daily = s.match(/^daily\s+(\d{1,2}):(\d{2})$/)
  if (daily) return nextDailyAt(from, parseInt(daily[1]!, 10), parseInt(daily[2]!, 10))
  const weekly = s.match(/^weekly\s+([a-z]{3,})\s+(\d{1,2}):(\d{2})$/)
  if (weekly) {
    const dow = DOW[weekly[1]!.slice(0, 3)]
    if (dow === undefined) return undefined
    return nextWeeklyAt(from, dow, parseInt(weekly[2]!, 10), parseInt(weekly[3]!, 10))
  }
  return undefined
}

function computeNextRunAt(schedule: string | undefined, from: Date): string | undefined {
  return computeNextRunDate(schedule, from)?.toISOString()
}

let schedulerTimer: ReturnType<typeof setInterval> | undefined
let schedulerTicking = false

// Start the scheduler timer exactly once per process (idempotent). Called from
// the server so it only runs in a serving context.
export function ensureRoutinesScheduler() {
  if (schedulerTimer) return
  schedulerTimer = setInterval(() => {
    void schedulerTick()
  }, SCHEDULER_TICK_MS)
  if (typeof schedulerTimer.unref === "function") schedulerTimer.unref()
}

export async function schedulerTick() {
  if (schedulerTicking) return
  schedulerTicking = true
  try {
    reconcileStaleRunning()
    const fireEnabled = routinesRunEnabled()
    const now = new Date()
    const routines = readRoutines()
    for (const routine of routines) {
      if (!routine.enabled) continue
      const upcoming = computeNextRunDate(routine.schedule, now)
      if (!upcoming) continue // manual / unrecognized → never auto-run
      const scheduled = routine.nextRunAt ? Date.parse(routine.nextRunAt) : NaN
      if (Number.isNaN(scheduled)) {
        patchRoutine(routine.id, { nextRunAt: upcoming.toISOString() })
        continue
      }
      if (scheduled > now.getTime()) continue // not due yet
      // Due. Only actually execute when the global run flag is on; either way,
      // advance nextRunAt so a long-OFF period can't build up a run backlog.
      if (fireEnabled && !RUNNING.has(routine.id)) {
        appendRoutineLog(routine.id, "info", "scheduler fired (due)")
        await runRoutine(routine.id, { caller: "internal" })
      }
      patchRoutine(routine.id, { nextRunAt: computeNextRunDate(routine.schedule, new Date())?.toISOString() })
    }
  } catch {
    // never let a tick error kill the interval
  } finally {
    schedulerTicking = false
  }
}

// --- Single-use approval nonces (MUST-FIX #1) -------------------------------
// The tool's ctx.ask gate mints a token AFTER the human approves; runRoutine
// consumes it exactly once. This guarantees a `tool` caller cannot reach the
// executor without a fresh human approval, even if some other code path tried
// to forge caller:"tool".
// The approval is bound to the exact command/host/version the human saw at
// ctx.ask time (Codex finding #1 — TOCTOU): if the routine is mutated between
// approval and execution, the snapshot no longer matches and the run is
// rejected, so a PATCH can't swap in a different command under an old approval.
type RunApprovalSnapshot = { command: string; host: string; updatedAt?: string }
const RUN_APPROVALS = new Map<string, { token: string; expires: number; snapshot: RunApprovalSnapshot }>()
const RUN_APPROVAL_TTL_MS = 60 * 1000

function randomToken() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}

function mintRunApproval(routineID: string, snapshot: RunApprovalSnapshot): string {
  const token = randomToken()
  RUN_APPROVALS.set(routineID, { token, expires: Date.now() + RUN_APPROVAL_TTL_MS, snapshot })
  return token
}

function consumeRunApproval(routineID: string, token: string): RunApprovalSnapshot | undefined {
  const entry = RUN_APPROVALS.get(routineID)
  RUN_APPROVALS.delete(routineID)
  if (!entry) return undefined
  if (entry.expires <= Date.now()) return undefined
  if (entry.token !== token) return undefined
  return entry.snapshot
}

// Enable-approval nonce (Codex High finding — enable-path TOCTOU): enabling a
// routine authorizes the SCHEDULER to auto-run it, so — exactly like the manual
// run approval — the approval is bound to the {command,host,schedule,updatedAt}
// the human saw at ctx.ask time. A concurrent edit to the (disabled) draft, which
// needs no approval, then can't arm a swapped command under a stale enable OK.
type EnableApprovalSnapshot = { command: string; host: string; schedule: string; updatedAt?: string }
const ENABLE_APPROVALS = new Map<string, { token: string; expires: number; snapshot: EnableApprovalSnapshot }>()

function mintEnableApproval(routineID: string, snapshot: EnableApprovalSnapshot): string {
  const token = randomToken()
  ENABLE_APPROVALS.set(routineID, { token, expires: Date.now() + RUN_APPROVAL_TTL_MS, snapshot })
  return token
}

function consumeEnableApproval(routineID: string, token: string): EnableApprovalSnapshot | undefined {
  const entry = ENABLE_APPROVALS.get(routineID)
  ENABLE_APPROVALS.delete(routineID)
  if (!entry) return undefined
  if (entry.expires <= Date.now()) return undefined
  if (entry.token !== token) return undefined
  return entry.snapshot
}

// --- Run lock (MUST-FIX #4) --------------------------------------------------
function routinesLocksDir() {
  return path.join(routinesHome(), "locks")
}

function routineLockFile(routineID: string) {
  return path.join(routinesLocksDir(), `${safeID(routineID)}.lock`)
}

type RunLock = { pid: number; startedAt: string; owner: string }

// Authoritative concurrency guard. opencode is a SINGLE Bun process, so a
// module-level Set is a fully atomic in-process lock — no filesystem
// check-then-act race is possible (closes Codex finding #3). The on-disk
// lockfile below is now ADVISORY only: it records the active run for
// observability and lets a fresh process detect a run that a PRIOR (crashed)
// process left mid-flight. Correctness never depends on the file.
const RUNNING = new Set<string>()

function readRunLock(routineID: string): RunLock | undefined {
  try {
    return JSON.parse(readFileSync(routineLockFile(routineID), "utf8")) as RunLock
  } catch {
    return undefined
  }
}

// Acquire the per-routine run lock. The in-process Set is the source of truth;
// the file is written best-effort for cross-restart visibility.
function acquireRunLock(routineID: string): { ok: boolean; owner?: string } {
  if (RUNNING.has(routineID)) return { ok: false }
  RUNNING.add(routineID)
  const owner = randomToken()
  try {
    mkdirSync(routinesLocksDir(), { recursive: true })
    writeFileSync(
      routineLockFile(routineID),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), owner } satisfies RunLock),
    )
  } catch {
    // advisory only; run still proceeds under the in-process lock
  }
  return { ok: true, owner }
}

// Release the in-process lock and remove our advisory file. The owner guard
// keeps us from deleting a file we no longer own (belt-and-suspenders).
function releaseRunLock(routineID: string, owner: string) {
  RUNNING.delete(routineID)
  try {
    const current = readRunLock(routineID)
    if (current && current.owner !== owner) return
    unlinkSync(routineLockFile(routineID))
  } catch {
    // already released
  }
}

// Flip any routine stuck in "running" that is NOT actually active in this
// process back to "error" — that state can only be a run a prior (crashed)
// process left behind, since a live run is tracked in RUNNING. Keeps the UI
// from showing a perpetual running state after a restart.
function reconcileStaleRunning() {
  const routines = readRoutines()
  let changed = false
  for (const routine of routines) {
    if (routine.lastStatus !== "running") continue
    if (RUNNING.has(routine.id)) continue
    routine.lastStatus = "error"
    routine.lastExitCode = routine.lastExitCode ?? -1
    changed = true
    try {
      unlinkSync(routineLockFile(routine.id))
    } catch {
      // no leftover lock file to clean
    }
    appendRoutineLog(routine.id, "warn", "run marked failed: not active in this process (crashed/stale)")
  }
  if (changed) writeRoutines(routines)
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

// Test-only surface for security regressions (enable-approval TOCTOU). Gated to
// the test runner (NODE_ENV==="test") so production builds can NOT mint an
// approval nonce outside the ctx.ask path — otherwise this would re-open the very
// bypass the nonce closes (Codex re-review). `undefined` at runtime in prod.
export const __routinesTestHooks =
  process.env.NODE_ENV === "test" ? { mintEnableApproval, consumeEnableApproval } : undefined
