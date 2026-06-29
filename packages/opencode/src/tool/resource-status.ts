import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./resource-status.txt"
import { execFile } from "node:child_process"
import os from "node:os"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export const Parameters = Schema.Struct({
  target: Schema.optional(Schema.Literals(["server", "mac", "all"])).annotate({
    description: "Resource target to inspect. Defaults to all.",
  }),
})

type ResourceTarget = "server" | "mac" | "all"
type Metadata = {
  target: ResourceTarget
}

export const ResourceStatusTool = Tool.define<typeof Parameters, Metadata, never>(
  "resource_status",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>) =>
        Effect.gen(function* () {
          const target: ResourceTarget = params.target ?? "all"
          const status = yield* Effect.promise(() => collectResourceStatus(target))
          return {
            title: `resource_status ${target}`,
            output: JSON.stringify(status, null, 2),
            metadata: { target },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export type HostResourceStatus = {
  target: "server" | "mac"
  online: boolean
  checkedAt: string
  hostname?: string
  platform?: string
  uptimeSeconds?: number
  cpu?: {
    cores: number
    load1: number
    load5: number
    load15: number
  }
  memory?: {
    totalBytes: number
    freeBytes: number
    usedBytes: number
    usedPercent: number
  }
  storage?: Array<{
    path: string
    filesystem?: string
    totalBytes: number
    usedBytes: number
    freeBytes: number
    usedPercent: number
  }>
  error?: string
}

export type ResourceStatusResponse = {
  ok: true
  checkedAt: string
  server?: HostResourceStatus
  mac?: HostResourceStatus
}

export async function collectResourceStatus(target: ResourceTarget = "all"): Promise<ResourceStatusResponse> {
  const checkedAt = new Date().toISOString()
  const [server, mac] = await Promise.all([
    target === "server" || target === "all" ? readServerStatus() : Promise.resolve(undefined),
    target === "mac" || target === "all" ? readMacStatus() : Promise.resolve(undefined),
  ])
  return {
    ok: true,
    checkedAt,
    ...(server ? { server } : {}),
    ...(mac ? { mac } : {}),
  }
}

async function readServerStatus(): Promise<HostResourceStatus> {
  const checkedAt = new Date().toISOString()
  try {
    const totalBytes = os.totalmem()
    const freeBytes = os.freemem()
    const load = os.loadavg()
    return {
      target: "server",
      online: true,
      checkedAt,
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()}`,
      uptimeSeconds: Math.round(os.uptime()),
      cpu: {
        cores: os.cpus().length,
        load1: load[0] ?? 0,
        load5: load[1] ?? 0,
        load15: load[2] ?? 0,
      },
      memory: memoryPayload(totalBytes, freeBytes),
      storage: await readLocalStorage(),
    }
  } catch (error) {
    return offline("server", checkedAt, error)
  }
}

async function readMacStatus(): Promise<HostResourceStatus> {
  const checkedAt = new Date().toISOString()
  const host = process.env.OPENCODE_MAC_RESOURCE_HOST || "alfonso-mac"
  const nodePath = process.env.OPENCODE_MAC_NODE_PATH || "/opt/homebrew/bin/node"
  const encodedScript = Buffer.from(remoteResourceScript).toString("base64")
  try {
    const { stdout } = await execFileAsync(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=4",
        host,
        `${shellQuote(nodePath)} -e 'eval(Buffer.from("${encodedScript}", "base64").toString())'`,
      ],
      { timeout: 8_000, maxBuffer: 512_000 },
    )
    const parsed = JSON.parse(String(stdout))
    return {
      target: "mac",
      online: true,
      checkedAt,
      hostname: parsed.hostname,
      platform: parsed.platform,
      uptimeSeconds: parsed.uptimeSeconds,
      cpu: parsed.cpu,
      memory: parsed.memory,
      storage: parsed.storage,
    }
  } catch (error) {
    return offline("mac", checkedAt, error)
  }
}

async function readLocalStorage() {
  const configured = process.env.OPENCODE_RESOURCE_DISK_PATHS?.split(":").filter(Boolean)
  const paths = configured?.length ? configured : [process.env.OPENCODE_DEV_ROOT ?? "/home/dev/repos", "/"]
  const unique = [...new Set(paths)]
  const results = await Promise.all(unique.map((item) => readDf(item)))
  const seen = new Set<string>()
  return results.filter((item): item is NonNullable<typeof item> => {
    if (!item) return false
    const key = `${item.filesystem ?? ""}:${item.path}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function readDf(targetPath: string) {
  try {
    const { stdout } = await execFileAsync("df", ["-kP", targetPath], { timeout: 4_000, maxBuffer: 64_000 })
    return parseDf(String(stdout), targetPath)
  } catch {
    return undefined
  }
}

function parseDf(stdout: string, fallbackPath: string) {
  const line = stdout.trim().split("\n")[1]
  if (!line) return undefined
  const parts = line.trim().split(/\s+/)
  if (parts.length < 6) return undefined
  const totalBytes = Number(parts[1]) * 1024
  const usedBytes = Number(parts[2]) * 1024
  const freeBytes = Number(parts[3]) * 1024
  return {
    filesystem: parts[0],
    path: parts.slice(5).join(" ") || fallbackPath,
    totalBytes,
    usedBytes,
    freeBytes,
    usedPercent: percent(usedBytes, totalBytes),
  }
}

function memoryPayload(totalBytes: number, freeBytes: number) {
  const usedBytes = Math.max(0, totalBytes - freeBytes)
  return {
    totalBytes,
    freeBytes,
    usedBytes,
    usedPercent: percent(usedBytes, totalBytes),
  }
}

function percent(used: number, total: number) {
  if (!Number.isFinite(total) || total <= 0) return 0
  return Math.round((used / total) * 1000) / 10
}

function offline(target: "server" | "mac", checkedAt: string, error: unknown): HostResourceStatus {
  return {
    target,
    online: false,
    checkedAt,
    error: cleanError(error),
  }
}

function cleanError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes("Command failed: ssh")) {
    const useful = message
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .find((line) => !line.startsWith("Command failed: ssh"))
    return (useful || "Mac SSH resource check failed").slice(0, 240)
  }
  return message.replace(/\s+/g, " ").slice(0, 240)
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

const remoteResourceScript = String.raw`
const os = require("node:os")
const { execFileSync } = require("node:child_process")
function percent(used, total) {
  return !total ? 0 : Math.round((used / total) * 1000) / 10
}
function memoryPayload(totalBytes, freeBytes) {
  const usedBytes = Math.max(0, totalBytes - freeBytes)
  return { totalBytes, freeBytes, usedBytes, usedPercent: percent(usedBytes, totalBytes) }
}
function parseDf(stdout, fallbackPath) {
  const line = stdout.trim().split("\n")[1]
  if (!line) return undefined
  const parts = line.trim().split(/\s+/)
  if (parts.length < 6) return undefined
  const totalBytes = Number(parts[1]) * 1024
  const usedBytes = Number(parts[2]) * 1024
  const freeBytes = Number(parts[3]) * 1024
  return { filesystem: parts[0], path: parts.slice(5).join(" ") || fallbackPath, totalBytes, usedBytes, freeBytes, usedPercent: percent(usedBytes, totalBytes) }
}
const load = os.loadavg()
const storage = ["/"].flatMap((item) => {
  try {
    const parsed = parseDf(execFileSync("df", ["-kP", item], { encoding: "utf8" }), item)
    return parsed ? [parsed] : []
  } catch {
    return []
  }
})
process.stdout.write(JSON.stringify({
  hostname: os.hostname(),
  platform: os.type() + " " + os.release(),
  uptimeSeconds: Math.round(os.uptime()),
  cpu: { cores: os.cpus().length, load1: load[0] || 0, load5: load[1] || 0, load15: load[2] || 0 },
  memory: memoryPayload(os.totalmem(), os.freemem()),
  storage
}))
`
