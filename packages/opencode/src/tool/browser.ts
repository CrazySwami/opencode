import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./browser.txt"
import path from "node:path"
import os from "node:os"
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs"

const actions = [
  "open",
  "goto",
  "snapshot",
  "screenshot",
  "click",
  "dblclick",
  "fill",
  "type",
  "press",
  "hover",
  "select",
  "check",
  "uncheck",
  "eval",
  "run-code",
  "highlight",
  "video-show-actions",
  "video-hide-actions",
  "requests",
  "console",
  "tab-list",
  "tab-new",
  "tab-close",
  "tab-select",
  "go-back",
  "go-forward",
  "reload",
  "resize",
  "show",
  "close",
  "delete-data",
] as const

const engines = ["chrome", "firefox", "webkit", "msedge"] as const

export const Parameters = Schema.Struct({
  action: Schema.Literals(actions).annotate({
    description:
      "Browser action to run. Call open first to create this session's isolated browser, then use snapshot/click/fill/highlight/screenshot/etc.",
  }),
  url: Schema.optional(Schema.String).annotate({
    description: "URL for open, goto, or tab-new.",
  }),
  target: Schema.optional(Schema.String).annotate({
    description: "Element reference, selector, tab id, screenshot target, or other Playwright CLI target argument.",
  }),
  text: Schema.optional(Schema.String).annotate({
    description: "Text, key name, JavaScript code, or option value depending on the action.",
  }),
  width: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
    description: "Viewport width for resize.",
  }),
  height: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
    description: "Viewport height for resize.",
  }),
  engine: Schema.optional(Schema.Literals(engines)).annotate({
    description:
      "Browser engine/channel for open. Defaults to OPENCODE_PLAYWRIGHT_BROWSER or Playwright CLI's default.",
  }),
  json: Schema.optional(Schema.Boolean)
    .annotate({ description: "Request JSON output from Playwright CLI when supported. Defaults to false." })
    .pipe(Schema.withDecodingDefault(Effect.succeed(false))),
})

type Metadata = {
  action: (typeof actions)[number]
  browserSessionID: string
  profileDir: string
  artifactDir: string
  auditPath: string
  command: string[]
  exitCode?: number
  artifactURL?: string
  screenshotPath?: string
  screenshotURL?: string
  screenshotDataURL?: string
}

type CommandResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export type BrowserActionInput = Pick<
  Schema.Schema.Type<typeof Parameters>,
  "action" | "url" | "target" | "text" | "width" | "height" | "engine" | "json"
>

const SENSITIVE_FIELD = /password|passwd|passphrase|secret|token|cookie|authorization|auth/i

export const BrowserTool = Tool.define<typeof Parameters, Metadata, never>(
  "browser",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const paths = sessionPaths(ctx.sessionID)
          mkdirSync(paths.sessionDir, { recursive: true })
          mkdirSync(paths.profileDir, { recursive: true })
          mkdirSync(paths.artifactDir, { recursive: true })

          yield* ctx.ask({
            permission: "browser",
            patterns: [params.action],
            always: ["*"],
            metadata: {
              action: params.action,
              url: params.url,
              target: params.target,
              browserSessionID: paths.browserSessionID,
            },
          })

          const command = commandFor(params, paths)
          const beforeScreenshot = latestPng(paths.artifactDir)
          const result = yield* Effect.promise(() => run(command, paths.artifactDir, ctx.abort))
          const screenshotPath =
            params.action === "screenshot"
              ? (extractPngPath(result.stdout + "\n" + result.stderr, paths.artifactDir) ??
                latestPng(paths.artifactDir, beforeScreenshot))
              : undefined

          audit(paths.auditPath, {
            time: new Date().toISOString(),
            sessionID: ctx.sessionID,
            browserSessionID: paths.browserSessionID,
            action: params.action,
            input: redact(params),
            command: redactCommand(command),
            exitCode: result.exitCode,
            screenshotPath,
          })

          if (result.exitCode !== 0) {
            throw new Error(
              [
                `Playwright CLI failed for browser.${params.action} (exit ${result.exitCode}).`,
                result.stderr.trim(),
                result.stdout.trim(),
              ]
                .filter(Boolean)
                .join("\n"),
            )
          }

          const artifactURL = `/experimental/browser/${encodeURIComponent(ctx.sessionID)}/artifacts`
          const screenshotURL = screenshotPath ? fileViewerURL(screenshotPath) : undefined
          const output = formatOutput(params.action, result, paths, artifactURL, screenshotPath, screenshotURL)
          const attachments =
            screenshotPath && existsSync(screenshotPath) ? [imageAttachment(screenshotPath)] : undefined

          return {
            title: `browser ${params.action}`,
            output,
            metadata: {
              action: params.action,
              browserSessionID: paths.browserSessionID,
              profileDir: paths.profileDir,
              artifactDir: paths.artifactDir,
              auditPath: paths.auditPath,
              command: redactCommand(command),
              exitCode: result.exitCode,
              artifactURL,
              ...(screenshotPath ? { screenshotPath } : {}),
              ...(screenshotURL ? { screenshotURL } : {}),
              ...(screenshotPath && existsSync(screenshotPath)
                ? { screenshotDataURL: imageDataURL(screenshotPath) }
                : {}),
            },
            attachments,
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export function sessionPaths(sessionID: string) {
  const root = process.env.OPENCODE_BROWSER_HOME || path.join(os.homedir(), ".local", "share", "opencode-browser")
  const browserSessionID = `oc_${sessionID.replace(/[^a-zA-Z0-9_.-]/g, "_")}`
  const sessionDir = path.join(root, "sessions", browserSessionID)
  return {
    browserSessionID,
    sessionDir,
    profileDir: path.join(sessionDir, "profile"),
    artifactDir: path.join(sessionDir, "artifacts"),
    auditPath: path.join(sessionDir, "audit.jsonl"),
  }
}

export async function captureBrowserScreenshot(sessionID: string, signal: AbortSignal) {
  const paths = sessionPaths(sessionID)
  mkdirSync(paths.sessionDir, { recursive: true })
  mkdirSync(paths.artifactDir, { recursive: true })

  const beforeScreenshot = latestPng(paths.artifactDir)
  const command = [...cliCommand(), `-s=${paths.browserSessionID}`, "screenshot"]
  const result = await run(command, paths.artifactDir, signal)
  if (result.exitCode !== 0) {
    throw new Error(
      [
        `Playwright CLI failed to capture browser screenshot for ${paths.browserSessionID} (exit ${result.exitCode}).`,
        result.stderr.trim(),
        result.stdout.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    )
  }

  const screenshotPath =
    extractPngPath(result.stdout + "\n" + result.stderr, paths.artifactDir) ??
    latestPng(paths.artifactDir, beforeScreenshot) ??
    latestPng(paths.artifactDir)
  if (!screenshotPath || !existsSync(screenshotPath)) {
    throw new Error(`No screenshot artifact found for ${paths.browserSessionID}. Open the browser first.`)
  }

  return {
    ...paths,
    screenshotPath,
    screenshotURL: fileViewerURL(screenshotPath),
    bytes: readFileSync(screenshotPath),
  }
}

export async function runBrowserAction(sessionID: string, input: BrowserActionInput, signal: AbortSignal) {
  const paths = sessionPaths(sessionID)
  mkdirSync(paths.sessionDir, { recursive: true })
  mkdirSync(paths.profileDir, { recursive: true })
  mkdirSync(paths.artifactDir, { recursive: true })

  const command = commandFor({ json: false, ...input }, paths)
  const result = await run(command, paths.artifactDir, signal)
  audit(paths.auditPath, {
    time: new Date().toISOString(),
    sessionID,
    browserSessionID: paths.browserSessionID,
    source: "ui",
    action: input.action,
    input: redact(input),
    command: redactCommand(command),
    exitCode: result.exitCode,
  })
  if (result.exitCode !== 0) {
    throw new Error(
      [
        `Playwright CLI failed for browser.${input.action} (exit ${result.exitCode}).`,
        result.stderr.trim(),
        result.stdout.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    )
  }

  return {
    ...paths,
    artifactURL: `/experimental/browser/${encodeURIComponent(sessionID)}/artifacts`,
    output: [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n"),
  }
}

function commandFor(params: Schema.Schema.Type<typeof Parameters>, paths: ReturnType<typeof sessionPaths>) {
  const command = [...cliCommand(), `-s=${paths.browserSessionID}`]
  if (params.json) command.push("--json")
  command.push(params.action)

  switch (params.action) {
    case "open":
      if (params.url) command.push(params.url)
      command.push("--persistent", `--profile=${paths.profileDir}`)
      if (params.engine || process.env.OPENCODE_PLAYWRIGHT_BROWSER) {
        command.push(`--browser=${params.engine || process.env.OPENCODE_PLAYWRIGHT_BROWSER}`)
      }
      break
    case "goto":
    case "tab-new":
      requireParam(params.url, "url", params.action)
      command.push(params.url)
      break
    case "click":
    case "dblclick":
    case "hover":
    case "check":
    case "uncheck":
    case "highlight":
    case "tab-close":
    case "tab-select":
    case "screenshot":
      if (params.target) command.push(params.target)
      break
    case "fill":
    case "type":
    case "select":
      requireParam(params.target, "target", params.action)
      requireParam(params.text, "text", params.action)
      command.push(params.target, params.text)
      break
    case "press":
      requireParam(params.text, "text", params.action)
      if (params.target) command.push(params.target)
      command.push(params.text)
      break
    case "eval":
    case "run-code":
      requireParam(params.text, "text", params.action)
      command.push(params.text)
      break
    case "resize":
      if (!params.width || !params.height) throw new Error("browser.resize requires width and height")
      command.push(String(params.width), String(params.height))
      break
  }

  if (params.action !== "resize" && (params.width || params.height)) {
    throw new Error("width and height are only supported for browser.resize")
  }
  return command
}

function cliCommand() {
  const raw = process.env.OPENCODE_PLAYWRIGHT_CLI?.trim()
  if (!raw) return ["npx", "-y", "@playwright/cli"]
  return raw.split(/\s+/).filter(Boolean)
}

function requireParam(value: unknown, name: string, action: string): asserts value is string {
  if (typeof value === "string" && value.length > 0) return
  throw new Error(`browser.${action} requires ${name}`)
}

async function run(command: string[], cwd: string, signal: AbortSignal): Promise<CommandResult> {
  const proc = Bun.spawn(command, {
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    signal,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

function formatOutput(
  action: Schema.Schema.Type<typeof Parameters>["action"],
  result: CommandResult,
  paths: ReturnType<typeof sessionPaths>,
  artifactURL: string,
  screenshotPath: string | undefined,
  screenshotURL: string | undefined,
) {
  const body = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n")
  const lines = [
    `browserSessionID: ${paths.browserSessionID}`,
    `profileDir: ${paths.profileDir}`,
    `artifactDir: ${paths.artifactDir}`,
    `artifactURL: ${artifactURL}`,
    `auditPath: ${paths.auditPath}`,
    screenshotPath ? `screenshotPath: ${screenshotPath}` : undefined,
    screenshotURL ? `screenshotURL: ${screenshotURL}` : undefined,
    "",
    body || `browser.${action} completed`,
  ].filter((line): line is string => line !== undefined)
  return lines.join("\n")
}

function fileViewerURL(file: string) {
  return `/experimental/files/view?path=${encodeURIComponent(file)}`
}

function audit(file: string, value: unknown) {
  appendFileSync(file, JSON.stringify(value) + "\n")
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, SENSITIVE_FIELD.test(key) ? "[redacted]" : redact(item)]),
  )
}

function redactCommand(command: string[]) {
  return command.map((part, index) => {
    const prev = command[index - 1] ?? ""
    if (SENSITIVE_FIELD.test(part) || SENSITIVE_FIELD.test(prev)) return "[redacted]"
    return part
  })
}

function imageAttachment(file: string) {
  return {
    type: "file" as const,
    mime: "image/png",
    url: imageDataURL(file),
  }
}

function imageDataURL(file: string) {
  const bytes = readFileSync(file)
  return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`
}

function extractPngPath(output: string, artifactDir: string) {
  for (const match of output.matchAll(/(?:^|\s)(\/[^\s]+\.png)(?:\s|$)/g)) {
    const candidate = match[1]
    if (candidate && existsSync(candidate)) return candidate
  }
  for (const match of output.matchAll(/(?:^|\s)([^\s]+\.png)(?:\s|$)/g)) {
    const candidate = match[1] ? path.resolve(artifactDir, match[1]) : undefined
    if (candidate && existsSync(candidate)) return candidate
  }
  return undefined
}

function latestPng(dir: string, after?: string) {
  const afterMtime = after ? (statSync(after, { throwIfNoEntry: false })?.mtimeMs ?? 0) : 0
  let latest: { file: string; mtimeMs: number } | undefined
  for (const item of readdirSync(dir)) {
    if (!item.endsWith(".png")) continue
    const file = path.join(dir, item)
    const stat = statSync(file, { throwIfNoEntry: false })
    if (!stat || stat.mtimeMs <= afterMtime) continue
    if (!latest || stat.mtimeMs > latest.mtimeMs) latest = { file, mtimeMs: stat.mtimeMs }
  }
  return latest?.file
}
