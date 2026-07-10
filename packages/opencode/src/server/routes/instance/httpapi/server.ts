import { Config as EffectConfig, Context, Effect, Layer, Stream } from "effect"
import { HttpApiBuilder, OpenApi } from "effect/unstable/httpapi"
import {
  HttpClient,
  HttpMiddleware,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { execFile, spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { mkdir as mkdirP, readdir as readdirP, readFile as readFileP, stat as statP, writeFile as writeFileP } from "node:fs/promises"
import { createRemoteJWKSet, jwtVerify } from "jose"
import path from "node:path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import * as Observability from "@opencode-ai/core/observability"
import { LangSmith } from "@opencode-ai/core/observability/langsmith"
import { Account } from "@/account/account"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { BackgroundJob } from "@/background/job"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { Workspace } from "@/control-plane/workspace"
import { Env } from "@/env"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "@/format"
import { Git } from "@/git"
import { Installation } from "@/installation"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { McpAuth } from "@/mcp/auth"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { PluginPtyEnvironment } from "@/plugin/pty-environment"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { Vcs } from "@/project/vcs"
import { ProviderAuth } from "@/provider/auth"
import { Provider } from "@/provider/provider"
import { Question } from "@/question"
import * as Secrets from "@/secrets/store"
import { SessionCompaction } from "@/session/compaction"
import { Instruction } from "@/session/instruction"
import { LLM } from "@/session/llm"
import { SessionProcessor } from "@/session/processor"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { SessionShare } from "@/share/session"
import { ShareNext } from "@/share/share-next"
import { Skill } from "@/skill"
import { Discovery } from "@/skill/discovery"
import { Snapshot } from "@/snapshot"
import { Storage } from "@/storage/storage"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Worktree } from "@/worktree"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { Npm } from "@opencode-ai/core/npm"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectCopy } from "@opencode-ai/core/project/copy"
import { PtyTicket } from "@opencode-ai/core/pty/ticket"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV2 } from "@opencode-ai/core/session"
import * as SessionExecutionLocal from "@opencode-ai/core/session/execution/local"
import {
  deleteWorkspaceEnvEntry,
  importDotenvText,
  readWorkspaceEnvRegistryPublic,
  upsertWorkspaceEnvEntry,
  validateDotenvText,
  workspaceEnvPath,
  workspaceEnvPromptSummary,
} from "@opencode-ai/core/workspace-env"
import { lazy } from "@/util/lazy"
import { CorsConfig, isAllowedCorsOrigin, type CorsOptions } from "@opencode-ai/server/cors"
import { serveUIEffect } from "@/server/shared/ui"
import { ServerAuth } from "@/server/auth"
import { InstanceHttpApi, RootHttpApi } from "./api"
import { Api } from "@opencode-ai/server/api"
import { PublicApi } from "./public"
import {
  authorizationLayer,
  authorizationRouterMiddleware,
  ptyConnectAuthorizationLayer,
  serverAuthorizationLayer,
} from "./middleware/authorization"
import { EventApi } from "./groups/event"
import { PtyConnectApi } from "./groups/pty"
import { eventHandlers } from "./handlers/event"
import { configHandlers } from "./handlers/config"
import { controlHandlers } from "./handlers/control"
import { controlPlaneHandlers } from "./handlers/control-plane"
import { experimentalHandlers } from "./handlers/experimental"
import { fileHandlers } from "./handlers/file"
import { globalHandlers } from "./handlers/global"
import { instanceHandlers } from "./handlers/instance"
import { mcpHandlers } from "./handlers/mcp"
import { permissionHandlers } from "./handlers/permission"
import { projectHandlers } from "./handlers/project"
import { projectCopyHandlers } from "./handlers/project-copy"
import { providerHandlers } from "./handlers/provider"
import { ptyConnectHandlers, ptyHandlers } from "./handlers/pty"
import { questionHandlers } from "./handlers/question"
import { sessionHandlers } from "./handlers/session"
import { syncHandlers } from "./handlers/sync"
import { tuiHandlers } from "./handlers/tui"
import { handlers } from "@opencode-ai/server/handlers"
import { locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { layer as locationLayer } from "@opencode-ai/server/location"
import { sessionLocationLayer } from "@opencode-ai/server/middleware/session-location"
import { PtyEnvironment } from "@opencode-ai/server/pty-environment"
import { schemaErrorLayer as v2SchemaErrorLayer } from "@opencode-ai/server/middleware/schema-error"
import { workspaceHandlers } from "./handlers/workspace"
import { instanceContextLayer } from "./middleware/instance-context"
import { workspaceRoutingLayer } from "./middleware/workspace-routing"
import { HttpApiProxy } from "./middleware/proxy"
import { disposeMiddleware } from "./lifecycle"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { compressionLayer } from "./middleware/compression"
import { corsVaryFix } from "./middleware/cors-vary"
import { errorLayer } from "./middleware/error"
import { fenceLayer } from "./middleware/fence"
import { schemaErrorLayer } from "./middleware/schema-error"
import { captureBrowserScreenshot, runBrowserAction, sessionPaths, type BrowserActionInput } from "@/tool/browser"
import { readPreviewSurfaceState, runPreviewAction, writePreviewSurfaceState } from "@/tool/preview"
import { collectResourceStatus } from "@/tool/resource-status"
import { collectCliResourcesStatus, runCliResourceAction } from "@/tool/cli-resources"
import { createRoutineDraft, ensureRoutinesScheduler, routineLogs, routinesAction, routinesStatus } from "@/tool/routines"
import { publishAppleBridgeEvent } from "@/tool/ios-bridge-events"
import { generateImage, imageProviderStatus, isImageProviderID } from "@/tool/image-gen"

// Routines HTTP guards (MUST-FIX #8): reject oversized bodies and throttle run
// requests. The runner itself also enforces run-enabled/approval/lock, so this
// is defense-in-depth on the HTTP surface.
const ROUTINES_MAX_BODY_BYTES = 16 * 1024
const ROUTINES_RUN_MIN_INTERVAL_MS = 1000
let routinesLastRunAt = 0
function routinesRunRateOk() {
  const now = Date.now()
  if (now - routinesLastRunAt < ROUTINES_RUN_MIN_INTERVAL_MS) return false
  routinesLastRunAt = now
  return true
}

// MCP Registry tab: a curated catalog of installable MCP servers. This is the
// server-side data source for the panel://mcp-registry tab. Static for now;
// TODO: fetch + cache the official registry (registry.modelcontextprotocol.io)
// and community catalogs (mcp.so) instead of the hardcoded seed below.
type McpCatalogEntry = { name: string; title: string; description: string; transport: "local" | "remote"; homepage: string; install?: string }
const MCP_REGISTRY_CATALOG: McpCatalogEntry[] = [
  { name: "github", title: "GitHub", description: "Repos, PRs, issues, code search.", transport: "remote", homepage: "https://github.com/github/github-mcp-server" },
  { name: "context7", title: "Context7", description: "Up-to-date library/framework docs.", transport: "remote", homepage: "https://github.com/upstash/context7" },
  { name: "supabase", title: "Supabase", description: "Projects, SQL, migrations, edge functions.", transport: "local", homepage: "https://github.com/supabase-community/supabase-mcp", install: "npx -y @supabase/mcp-server-supabase@latest" },
  { name: "playwright", title: "Playwright", description: "Browser automation + accessibility snapshots.", transport: "local", homepage: "https://github.com/microsoft/playwright-mcp", install: "npx -y @playwright/mcp@latest" },
  { name: "filesystem", title: "Filesystem", description: "Read/write files under allowlisted roots.", transport: "local", homepage: "https://github.com/modelcontextprotocol/servers", install: "npx -y @modelcontextprotocol/server-filesystem" },
  { name: "fetch", title: "Fetch", description: "Fetch + convert web pages to markdown.", transport: "local", homepage: "https://github.com/modelcontextprotocol/servers", install: "npx -y @modelcontextprotocol/server-fetch" },
]
// Skills Library: scan known skill roots, parse each SKILL.md frontmatter for
// name + description. All async FS (no request-path sync IO).
type SkillEntry = { name: string; description: string; source: string; path: string }
async function listSkills(): Promise<{ ok: boolean; generatedAt: string; roots: string[]; skills: SkillEntry[] }> {
  // Prefer OpenDesign's skills (the integration backend) when its daemon is up;
  // fall back to a local SKILL.md scan if OD is offline.
  try {
    const res = await fetch(`${odDaemonUrl()}/api/skills`, { signal: AbortSignal.timeout(3000) })
    const data = (await res.json()) as { skills?: any[] }
    if (Array.isArray(data.skills)) {
      const skills: SkillEntry[] = data.skills.map((s) => ({
        name: s.name ?? s.id,
        description: String(s.description ?? "").slice(0, 300),
        source: `opendesign:${s.source ?? "?"}`,
        path: s.id ?? "",
      }))
      return { ok: true, generatedAt: new Date().toISOString(), roots: [`${odDaemonUrl()}/api/skills`], skills }
    }
  } catch {
    // OD offline → local scan below
  }
  const fsp = await import("node:fs/promises")
  const path = await import("node:path")
  const home = process.env.HOME || "/home/dev"
  const roots: { dir: string; source: string }[] = [
    { dir: path.join(home, ".claude", "skills"), source: "claude" },
    { dir: path.join(home, ".codex", "skills"), source: "codex" },
    { dir: path.join(home, ".config", "opencode", "skills"), source: "opencode" },
    { dir: path.join(process.cwd(), ".claude", "skills"), source: "project" },
  ]
  const parseFrontmatter = (text: string) => {
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    const block = m?.[1] ?? ""
    const name = block.match(/^name:\s*(.+)$/m)?.[1]?.trim()
    const description = block.match(/^description:\s*(.+)$/m)?.[1]?.trim()
    return { name, description }
  }
  const seen = new Set<string>()
  const skills: SkillEntry[] = []
  for (const { dir, source } of roots) {
    let entries: import("node:fs").Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const skillFile = path.join(dir, entry.name, "SKILL.md")
      let front: { name?: string; description?: string } = {}
      try {
        front = parseFrontmatter(await fsp.readFile(skillFile, "utf8"))
      } catch {
        continue // no SKILL.md → not a skill dir
      }
      const name = front.name || entry.name
      const key = `${source}:${name}`
      if (seen.has(key)) continue
      seen.add(key)
      skills.push({
        name,
        description: (front.description || "").slice(0, 300),
        source,
        path: path.join(dir, entry.name),
      })
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name))
  return { ok: true, generatedAt: new Date().toISOString(), roots: roots.map((r) => r.dir), skills }
}

function odDaemonUrl() {
  return process.env.OPENCODE_OD_URL || "http://127.0.0.1:7456"
}
// MCP registry is sourced from OpenDesign (the integration backend) when its
// daemon is up: OD's /api/mcp/servers gives configured servers + a rich template
// catalog. Falls back to the local seed if OD is offline.
async function mcpRegistryCatalog() {
  try {
    const res = await fetch(`${odDaemonUrl()}/api/mcp/servers`, { signal: AbortSignal.timeout(3000) })
    const data = (await res.json()) as { servers?: unknown[]; templates?: any[] }
    const servers = (data.templates ?? []).map((t) => ({
      name: t.id,
      title: t.label ?? t.id,
      description: String(t.description ?? "").slice(0, 300),
      transport: t.transport === "stdio" ? "local" : "remote",
      homepage: t.homepage ?? "",
      install: t.url ?? undefined,
    }))
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      source: "opendesign",
      note: "Sourced from OpenDesign daemon (/api/mcp/servers). Configured servers + template catalog.",
      registries: [`${odDaemonUrl()}/api/mcp/servers`],
      configured: data.servers ?? [],
      servers: servers.length ? servers : MCP_REGISTRY_CATALOG,
    }
  } catch {
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      source: "seed",
      note: "OpenDesign daemon offline — showing local seed. Start OD (:7456) for the full catalog.",
      registries: ["https://registry.modelcontextprotocol.io", "https://mcp.so"],
      configured: [],
      servers: MCP_REGISTRY_CATALOG,
    }
  }
}
// Reject an oversized body BEFORE buffering it (Codex finding #2): check the
// declared Content-Length first, then verify the actual byte length (not char
// count, so multi-byte UTF-8 can't slip past the cap).
function routinesBodyTooLargeByHeader(headers: Record<string, string | undefined>) {
  const declared = Number(headers["content-length"])
  return Number.isFinite(declared) && declared > ROUTINES_MAX_BODY_BYTES
}
function routinesBodyTooLarge(raw: string) {
  return Buffer.byteLength(raw, "utf8") > ROUTINES_MAX_BODY_BYTES
}
import {
  ackWorkspaceTabsAction,
  updateWorkspaceTabsClientState,
  workspaceTabsAction,
  workspaceTabsPendingActions,
  workspaceTabsStatus,
} from "@/tool/workspace-tabs"

export const context = Context.makeUnsafe<unknown>(new Map())

const cors = (corsOptions?: CorsOptions) =>
  HttpRouter.middleware(
    HttpMiddleware.cors({
      allowedOrigins: (origin) => isAllowedCorsOrigin(origin, corsOptions),
      maxAge: 86_400,
    }),
    { global: true },
  )

// Route tree:
// - rootApiRoutes: typed /global/* and control routes; auth is declared by RootHttpApi.
// - eventApiRoutes: typed SSE route with instance routing context and its existing API contract.
// - ptyConnectApiRoutes: typed WebSocket upgrade route with ticket-aware auth.
// - instanceApiRoutes: remaining typed instance routes.
// - uiRoute: raw catch-all fallback; auth is router middleware so public static assets can bypass it.
const authOnlyRouterLayer = authorizationRouterMiddleware.layer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))
const httpApiAuthLayer = authorizationLayer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))
const ptyConnectHttpApiAuthLayer = ptyConnectAuthorizationLayer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))
const serverHttpApiAuthLayer = serverAuthorizationLayer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))
const workspaceRoutingLive = workspaceRoutingLayer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal))
const rootApiRoutes = HttpApiBuilder.layer(RootHttpApi).pipe(
  Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers]),
  Layer.provide(schemaErrorLayer),
  Layer.provide(httpApiAuthLayer),
)
const eventApiRoutes = HttpApiBuilder.layer(EventApi).pipe(
  Layer.provide(eventHandlers),
  Layer.provide([httpApiAuthLayer, workspaceRoutingLive, instanceContextLayer]),
)
const ptyConnectApiRoutes = HttpApiBuilder.layer(PtyConnectApi).pipe(
  Layer.provide(ptyConnectHandlers),
  Layer.provide([ptyConnectHttpApiAuthLayer, workspaceRoutingLive, instanceContextLayer]),
)
const instanceApiRoutes = HttpApiBuilder.layer(InstanceHttpApi).pipe(
  Layer.provide([
    configHandlers,
    experimentalHandlers,
    fileHandlers,
    instanceHandlers,
    mcpHandlers,
    projectHandlers,
    projectCopyHandlers,
    ptyHandlers,
    questionHandlers,
    permissionHandlers,
    providerHandlers,
    sessionHandlers,
    syncHandlers,
    tuiHandlers,
    workspaceHandlers,
  ]),
)

const instanceRoutes = instanceApiRoutes.pipe(
  Layer.provide([httpApiAuthLayer, workspaceRoutingLive, instanceContextLayer, schemaErrorLayer]),
)
const serverRoutes = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(handlers),
  Layer.provide(PluginPtyEnvironment.layer),
  Layer.provide([serverHttpApiAuthLayer, v2SchemaErrorLayer]),
)

// `OpenApi.fromApi` is non-trivial; defer until /doc is actually hit so
// processes that never serve it (CLI, scripts) don't pay at module load.
// `HttpServerResponse.jsonUnsafe` runs JSON.stringify eagerly, so caching
// the response also caches the serialized body — every /doc request reuses
// the same Uint8Array instead of re-stringifying the spec.
const docResponse = lazy(() => HttpServerResponse.jsonUnsafe(OpenApi.fromApi(PublicApi)))

const docRoute = HttpRouter.use((router) => router.add("GET", "/doc", () => Effect.succeed(docResponse()))).pipe(
  Layer.provide(authOnlyRouterLayer),
)

function normalizePreviewAction(body: any) {
  if (!body || typeof body !== "object") return null
  const rawAction = typeof body.action === "string" ? body.action : ""
  const action =
    rawAction === "goto" || rawAction === "open"
      ? "navigate"
      : rawAction === "click" && typeof body.x === "number" && typeof body.y === "number"
        ? "click-point"
        : rawAction === "key"
          ? "key"
          : rawAction
  const supported = new Set([
    "navigate",
    "snapshot",
    "screenshot",
    "accessibility",
    "dom",
    "inspect",
    "click",
    "click-point",
    "fill",
    "submit",
    "scroll",
    "type",
    "key",
    "reload",
    "attach",
  ])
  if (!supported.has(action)) return null
  return {
    action,
    url: typeof body.url === "string" ? body.url : undefined,
    selector:
      typeof body.selector === "string" ? body.selector : typeof body.target === "string" ? body.target : undefined,
    x: typeof body.x === "number" ? body.x : undefined,
    y: typeof body.y === "number" ? body.y : undefined,
    text: typeof body.text === "string" ? body.text : undefined,
    key: typeof body.key === "string" ? body.key : typeof body.text === "string" ? body.text : undefined,
    deltaX: typeof body.deltaX === "number" ? body.deltaX : undefined,
    deltaY: typeof body.deltaY === "number" ? body.deltaY : undefined,
    json: typeof body.json === "boolean" ? body.json : undefined,
  }
}

const browserPreviewRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add("GET", "/experimental/preview/:sessionID/state", (request) =>
      Effect.gen(function* () {
        const sessionID = decodeParam(request.url, /^\/experimental\/preview\/([^/]+)\/state$/)
        if (!sessionID) return HttpServerResponse.text("Missing session ID", { status: 400 })
        return HttpServerResponse.jsonUnsafe(readPreviewSurfaceState(sessionID))
      }),
    )

    yield* router.add("POST", "/experimental/preview/:sessionID/state", (request) =>
      Effect.gen(function* () {
        const sessionID = decodeParam(request.url, /^\/experimental\/preview\/([^/]+)\/state$/)
        if (!sessionID) return HttpServerResponse.text("Missing session ID", { status: 400 })

        const raw = yield* Effect.orDie(request.text)
        let body: {
          url?: string
          action?: string
          source?: string
          renderMode?: string
          embedKind?: string
          embedNote?: string
        }
        try {
          body = JSON.parse(raw || "{}") as typeof body
        } catch {
          return HttpServerResponse.text("Invalid JSON body", { status: 400 })
        }

        const boundedText = (value: unknown, max = 300) =>
          typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined
        const state = writePreviewSurfaceState(sessionID, {
          url: typeof body.url === "string" ? body.url : undefined,
          action: body.action === "navigate" ? "navigate" : undefined,
          source: body.source === "client" ? "client" : "unknown",
          // Embed-mode metadata from the visible Preview so the preview tool /
          // workspace_tabs state can explain how a URL is rendered and why.
          renderMode: boundedText(body.renderMode, 40),
          embedKind: boundedText(body.embedKind, 20),
          embedNote: boundedText(body.embedNote),
        })
        return HttpServerResponse.jsonUnsafe(state)
      }),
    )

    yield* router.add("POST", "/experimental/preview/:sessionID/action", (request) =>
      Effect.gen(function* () {
        const sessionID = decodeParam(request.url, /^\/experimental\/preview\/([^/]+)\/action$/)
        if (!sessionID) return HttpServerResponse.text("Missing session ID", { status: 400 })

        const raw = yield* Effect.orDie(request.text)
        let body: any
        try {
          body = JSON.parse(raw || "{}")
        } catch {
          return HttpServerResponse.text("Invalid JSON body", { status: 400 })
        }

        const action = normalizePreviewAction(body)
        if (!action) return HttpServerResponse.text("Unsupported preview action", { status: 400 })

        const result = yield* Effect.tryPromise({
          try: () => runPreviewAction(sessionID, action, AbortSignal.timeout(30_000), "client"),
          catch: (error) => (error instanceof Error ? error.message : String(error)),
        }).pipe(
          Effect.match({
            onFailure: (error) => ({ ok: false, error }),
            onSuccess: (value) => value,
          }),
        )
        const status = result && typeof result === "object" && "ok" in result && result.ok === false ? 500 : 200
        return HttpServerResponse.jsonUnsafe(result, { status })
      }),
    )

    yield* router.add("GET", "/experimental/browser/:sessionID/screenshot", (request) =>
      Effect.promise(async () => {
        const url = new URL(request.url, "http://localhost")
        const match = url.pathname.match(/^\/experimental\/browser\/([^/]+)\/screenshot$/)
        const sessionID = match?.[1] ? decodeURIComponent(match[1]) : ""
        if (!sessionID) return HttpServerResponse.text("Missing session ID", { status: 400 })
        const controller = new AbortController()
        const image = await captureBrowserScreenshot(sessionID, controller.signal)
        return HttpServerResponse.setHeader(
          HttpServerResponse.setHeader(
            HttpServerResponse.uint8Array(new Uint8Array(image.bytes), { contentType: "image/png" }),
            "cache-control",
            "no-store",
          ),
          "x-opencode-browser-session",
          image.browserSessionID,
        )
      }).pipe(
        Effect.catch((error: unknown) =>
          Effect.succeed(
            HttpServerResponse.text(error instanceof Error ? error.message : String(error), {
              status: 404,
            }),
          ),
        ),
      ),
    )

    yield* router.add("POST", "/experimental/browser/:sessionID/action", (request) =>
      Effect.gen(function* () {
        const sessionID = decodeParam(request.url, /^\/experimental\/browser\/([^/]+)\/action$/)
        if (!sessionID) return HttpServerResponse.text("Missing session ID", { status: 400 })

        const raw = yield* Effect.orDie(request.text)
        let body: Partial<BrowserActionInput>
        try {
          body = JSON.parse(raw || "{}") as Partial<BrowserActionInput>
        } catch {
          return HttpServerResponse.text("Invalid JSON body", { status: 400 })
        }
        const action = body.action
        if (!action) return HttpServerResponse.text("Missing browser action", { status: 400 })

        const controller = new AbortController()
        const result = yield* Effect.promise(() =>
          runBrowserAction(sessionID, { ...body, action } as BrowserActionInput, controller.signal),
        ).pipe(
          Effect.catch((error: unknown) =>
            Effect.succeed({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
        )

        if ("ok" in result && result.ok === false) {
          return HttpServerResponse.jsonUnsafe(result, { status: 500 })
        }

        return HttpServerResponse.jsonUnsafe({
          ok: true,
          ...result,
        })
      }),
    )

    yield* router.add("GET", "/experimental/browser/novnc/*", (request) =>
      Effect.gen(function* () {
        const access = yield* Effect.promise(() => liveBrowserExposureAccess(request))
        if (!access.ok) return liveBrowserExposureBlockedResponse("text", access)
        if (new URL(request.url, "http://localhost").pathname.endsWith("/opencode-lite.html")) {
          return liveBrowserNoVNCLiteResponse(request.url)
        }
        const target = liveBrowserNoVNCProxyURL(request.url)
        if (request.headers["upgrade"]?.toLowerCase() === "websocket") {
          return yield* HttpApiProxy.websocket(request, target)
        }
        return yield* Effect.promise(() => liveBrowserNoVNCProxyResponse(target))
      }),
    )

    yield* router.add("GET", "/experimental/browser/optimized/*", (request) =>
      Effect.gen(function* () {
        const access = yield* Effect.promise(() => liveBrowserExposureAccess(request))
        if (!access.ok) return liveBrowserExposureBlockedResponse("text", access)
        const url = new URL(request.url, "http://localhost")
        const pathPart = url.pathname.replace(/^\/experimental\/browser\/optimized\/?/, "")
        const target = new URL(optimizedBrowserViewerURL() + "/" + pathPart)
        target.search = url.search
        return yield* Effect.promise(() => optimizedBrowserViewerProxyResponse({ method: "GET", target }))
      }),
    )

    yield* router.add("POST", "/experimental/browser/optimized/*", (request) =>
      Effect.gen(function* () {
        const access = yield* Effect.promise(() => liveBrowserExposureAccess(request))
        if (!access.ok) return liveBrowserExposureBlockedResponse("json", access)
        const url = new URL(request.url, "http://localhost")
        const pathPart = url.pathname.replace(/^\/experimental\/browser\/optimized\/?/, "")
        const target = new URL(optimizedBrowserViewerURL() + "/" + pathPart)
        target.search = url.search
        const raw = yield* Effect.orDie(request.text)
        return yield* Effect.promise(() =>
          optimizedBrowserViewerProxyResponse({
            method: "POST",
            target,
            body: raw || "{}",
            contentType: request.headers["content-type"] || "application/json",
          }),
        )
      }),
    )

    yield* router.add("GET", "/experimental/browser/live/status", (request) =>
      Effect.promise(async () => {
        const access = await liveBrowserExposureAccess(request)
        if (!access.ok) return liveBrowserExposureBlockedResponse("json", access)
        return HttpServerResponse.jsonUnsafe(await liveBrowserStatus(access))
      }),
    )

    yield* router.add("GET", "/experimental/browser/profile/status", () =>
      Effect.promise(async () => HttpServerResponse.jsonUnsafe(liveBrowserProfilePolicy())),
    )

    yield* router.add("GET", "/experimental/browser/live/stream", (request) =>
      Effect.promise(async () => liveBrowserExposureAccess(request)).pipe(
        Effect.flatMap((access) =>
          access.ok
            ? Effect.succeed(
                HttpServerResponse.setHeader(
                  HttpServerResponse.stream(liveBrowserStream(), {
                    contentType: `multipart/x-mixed-replace; boundary=${liveBrowserStreamBoundary}`,
                  }),
                  "cache-control",
                  "no-store",
                ),
              )
            : Effect.succeed(liveBrowserExposureBlockedResponse("text", access)),
        ),
      ),
    )

    yield* router.add("GET", "/experimental/browser/live/snapshot", (request) =>
      Effect.promise(async () => liveBrowserExposureAccess(request)).pipe(
        Effect.flatMap((access) =>
          access.ok
            ? Effect.promise(async () => {
                await ensureLiveBrowser()
                const image = await captureLiveBrowserImage()
                return HttpServerResponse.setHeader(
                  HttpServerResponse.uint8Array(new Uint8Array(image), { contentType: "image/png" }),
                  "cache-control",
                  "no-store",
                )
              }).pipe(
                Effect.catch((error: unknown) =>
                  Effect.succeed(
                    HttpServerResponse.text(error instanceof Error ? error.message : String(error), {
                      status: 502,
                    }),
                  ),
                ),
              )
            : Effect.succeed(liveBrowserExposureBlockedResponse("text", access)),
        ),
      ),
    )

    yield* router.add("POST", "/experimental/browser/live/input", (request) =>
      Effect.gen(function* () {
        const access = yield* Effect.promise(() => liveBrowserExposureAccess(request))
        if (!access.ok) return liveBrowserExposureBlockedResponse("json", access)
        const raw = yield* Effect.orDie(request.text)
        let body: LiveBrowserInput
        try {
          body = JSON.parse(raw || "{}") as LiveBrowserInput
        } catch {
          return HttpServerResponse.text("Invalid JSON body", { status: 400 })
        }

        const result = yield* Effect.promise(() => runLiveBrowserInput(body)).pipe(
          Effect.catch((error: unknown) =>
            Effect.succeed({ ok: false, error: error instanceof Error ? error.message : String(error) }),
          ),
        )
        publishAppleBridgeEvent("browser", "browser.live.input", summarizeLiveBrowserEvent(body, result))
        return HttpServerResponse.jsonUnsafe(result, { status: result.ok ? 200 : 500 })
      }),
    )

    yield* router.add("POST", "/experimental/browser/live/selector", (request) =>
      Effect.gen(function* () {
        const access = yield* Effect.promise(() => liveBrowserExposureAccess(request))
        if (!access.ok) return liveBrowserExposureBlockedResponse("json", access)
        const raw = yield* Effect.orDie(request.text)
        let body: { selector?: string }
        try {
          body = JSON.parse(raw || "{}") as { selector?: string }
        } catch {
          return HttpServerResponse.text("Invalid JSON body", { status: 400 })
        }
        if (!body.selector?.trim()) return HttpServerResponse.text("Missing selector", { status: 400 })

        const result = yield* Effect.promise(() => highlightLiveBrowserSelector(body.selector!.trim())).pipe(
          Effect.catch((error: unknown) =>
            Effect.succeed({ ok: false, error: error instanceof Error ? error.message : String(error) }),
          ),
        )
        return HttpServerResponse.jsonUnsafe(result, { status: result.ok ? 200 : 500 })
      }),
    )

    yield* router.add("POST", "/experimental/browser/:sessionID/live/screenshot", (request) =>
      Effect.gen(function* () {
        const access = yield* Effect.promise(() => liveBrowserExposureAccess(request))
        if (!access.ok) return liveBrowserExposureBlockedResponse("json", access)
        const sessionID = decodeParam(request.url, /^\/experimental\/browser\/([^/]+)\/live\/screenshot$/)
        if (!sessionID) return HttpServerResponse.text("Missing session ID", { status: 400 })

        const raw = yield* Effect.orDie(request.text)
        let body: { annotationDataURL?: string; note?: string; selector?: string }
        try {
          body = JSON.parse(raw || "{}") as { annotationDataURL?: string; note?: string; selector?: string }
        } catch {
          return HttpServerResponse.text("Invalid JSON body", { status: 400 })
        }

        const result = yield* Effect.promise(() => saveLiveBrowserScreenshot(sessionID, body)).pipe(
          Effect.catch((error: unknown) =>
            Effect.succeed({ ok: false, error: error instanceof Error ? error.message : String(error) }),
          ),
        )
        return HttpServerResponse.jsonUnsafe(result, { status: result.ok ? 200 : 500 })
      }),
    )

    yield* router.add("GET", "/experimental/browser-use/status", () =>
      Effect.promise(async () => HttpServerResponse.jsonUnsafe(await browserUseBridgeStatus())),
    )
  }),
).pipe(Layer.provide([authOnlyRouterLayer, Socket.layerWebSocketConstructorGlobal]))

const workspaceIndexRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const projects = yield* Project.Service
    const sessions = yield* Session.Service

    yield* router.add("GET", "/__workspace-index", () =>
      Effect.gen(function* () {
        const index = yield* buildWorkspaceIndex(projects, sessions)
        return HttpServerResponse.jsonUnsafe(index)
      }),
    )
  }),
).pipe(Layer.provide(authOnlyRouterLayer))

function buildWorkspaceIndex(projects: any, sessions: any) {
  return Effect.gen(function* () {
    const projectList = yield* projects.list()
    const sessionList = yield* sessions.listGlobal({ roots: true, limit: 500 })
    const sessionCounts = new Map<string, number>()

    for (const session of sessionList) {
      const projectID = session.project?.id
      if (!projectID) continue
      sessionCounts.set(projectID, (sessionCounts.get(projectID) ?? 0) + 1)
    }

    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      roots: fileViewerRoots(),
      projects: projectList.map((project: any) => ({
        id: project.id,
        name: project.name,
        worktree: project.worktree,
        updatedAt: project.time.updated,
        activeSessions: sessionCounts.get(project.id) ?? 0,
      })),
      sessions: sessionList.slice(0, 100).map((session: any) => ({
        id: session.id,
        title: session.title,
        directory: session.directory,
        updatedAt: session.time.updated,
        project: session.project,
      })),
    }
  })
}

function workspaceIndexSummaryFallback() {
  return {
    route: "/__workspace-index",
    ok: false,
    projectCount: null,
    sessionCount: null,
    roots: fileViewerRoots(),
    projects: [],
    sessions: [],
    note: "Full project and session details are available from /__workspace-index.",
  }
}

async function buildWorkspaceIndexSummary(projects: any, sessions: any) {
  return statusWithTimeout("Workspace index summary", 800, workspaceIndexSummaryFallback(), async () => {
    const index = await Effect.runPromise(
      buildWorkspaceIndex(projects, sessions).pipe(Effect.orDie) as Effect.Effect<any, never, never>,
    )
    return {
      route: "/__workspace-index",
      ok: index.ok === true,
      generatedAt: index.generatedAt,
      projectCount: index.projects.length,
      sessionCount: index.sessions.length,
      roots: index.roots,
      projects: index.projects.slice(0, 8),
      sessions: index.sessions.slice(0, 8),
      note: "Full project and session details are available from /__workspace-index.",
    }
  })
}

const fileViewerRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add("GET", "/experimental/files/browse", (request) =>
      Effect.promise(async () => {
        const url = new URL(request.url, "http://localhost")
        const requested = url.searchParams.get("path")
        const directory = path.resolve(requested || fileBrowserDefaultPath())
        if (!fileViewerAllowed(directory))
          return HttpServerResponse.text("Directory is outside allowed roots", { status: 403 })

        const stat = await safeStatAsync(directory)
        if (!stat?.isDirectory()) return HttpServerResponse.text("Directory not found", { status: 404 })

        const skipped: Array<{ name: string; reason: string }> = []
        const rawEntries = await readdirP(directory, { withFileTypes: true })
        const mapped = await Promise.all(
          rawEntries.map(async (entry) => {
            if (entry.name === "." || entry.name === "..") return null
            const file = path.join(directory, entry.name)
            const fileStat = await safeStatAsync(file)
            if (!fileStat) {
              skipped.push({ name: entry.name, reason: "unreadable" })
              return null
            }
            const isDirectory = entry.isDirectory()
            const contentType = isDirectory ? null : contentTypeForFile(file)
            return {
              name: entry.name,
              path: file,
              kind: isDirectory ? "directory" : fileKind(contentType ?? ""),
              contentType,
              size: isDirectory ? null : fileStat.size,
              mtime: fileStat.mtime.toISOString(),
              browseURL: isDirectory ? `/experimental/files/browse?path=${encodeURIComponent(file)}` : null,
              url: isDirectory ? null : `/experimental/files/view?path=${encodeURIComponent(file)}`,
            }
          }),
        )
        const entries = mapped
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
          .sort((a, b) => {
            if (a.kind === "directory" && b.kind !== "directory") return -1
            if (a.kind !== "directory" && b.kind === "directory") return 1
            return a.name.localeCompare(b.name)
          })

        return HttpServerResponse.jsonUnsafe({
          ok: true,
          path: directory,
          parent: parentDirectory(directory),
          roots: fileViewerRoots(),
          entries,
          skipped,
        })
      }),
    )

    yield* router.add("GET", "/experimental/files/view", (request) =>
      Effect.promise(async () => {
        const url = new URL(request.url, "http://localhost")
        const rawPath = url.searchParams.get("path")
        if (!rawPath) return HttpServerResponse.text("Missing file path", { status: 400 })
        if (!path.isAbsolute(rawPath)) return HttpServerResponse.text("File path must be absolute", { status: 400 })

        const file = path.resolve(rawPath)
        if (!fileViewerAllowed(file))
          return HttpServerResponse.text("File is outside allowed viewer roots", { status: 403 })

        const stat = safeStat(file)
        if (!stat?.isFile()) return HttpServerResponse.text("File not found", { status: 404 })

        return HttpServerResponse.setHeader(
          HttpServerResponse.uint8Array(new Uint8Array(await readFileP(file)), { contentType: contentTypeForFile(file) }),
          "cache-control",
          "private, no-store",
        )
      }),
    )

    yield* router.add("GET", "/experimental/files/search", (request) =>
      Effect.promise(async () => {
        const url = new URL(request.url, "http://localhost")
        const query = (url.searchParams.get("query") || "").trim().toLowerCase()
        if (!query) return HttpServerResponse.jsonUnsafe({ ok: false, error: "search requires a query" }, { status: 400 })
        const requested = path.resolve(url.searchParams.get("path") || fileBrowserDefaultPath())
        if (!fileViewerAllowed(requested))
          return HttpServerResponse.text("Directory is outside allowed roots", { status: 403 })
        const rootStat = await safeStatAsync(requested)
        const root = rootStat?.isDirectory() ? requested : parentDirectory(requested) || requested
        const cap = Math.min(Math.max(1, Number(url.searchParams.get("limit")) || 200), 500)
        const skip = new Set(["node_modules", ".git", ".next", "dist", "build", ".cache", ".turbo", ".venv"])
        const results: Array<Record<string, unknown>> = []
        const walk = async (dir: string, depth: number): Promise<void> => {
          if (results.length >= cap || depth > 6) return
          let entries: import("node:fs").Dirent[]
          try {
            entries = await readdirP(dir, { withFileTypes: true })
          } catch {
            return
          }
          for (const entry of entries) {
            if (results.length >= cap) return
            if (skip.has(entry.name)) continue
            const entryPath = path.join(dir, entry.name)
            const isDirectory = entry.isDirectory()
            if (entry.name.toLowerCase().includes(query)) {
              const stat = await safeStatAsync(entryPath)
              const contentType = isDirectory ? null : contentTypeForFile(entryPath)
              results.push({
                name: entry.name,
                path: entryPath,
                kind: isDirectory ? "directory" : fileKind(contentType ?? ""),
                contentType,
                size: isDirectory ? null : stat?.size ?? null,
                mtime: stat ? stat.mtime.toISOString() : null,
                browseURL: isDirectory ? `/experimental/files/browse?path=${encodeURIComponent(entryPath)}` : null,
                url: isDirectory ? null : `/experimental/files/view?path=${encodeURIComponent(entryPath)}`,
              })
            }
            if (isDirectory) await walk(entryPath, depth + 1)
          }
        }
        await walk(root, 0)
        return HttpServerResponse.jsonUnsafe({
          ok: true,
          root,
          query,
          truncated: results.length >= cap,
          count: results.length,
          roots: fileViewerRoots(),
          entries: results,
        })
      }),
    )

    yield* router.add("GET", "/experimental/project-metadata", (request) =>
      Effect.promise(async () => HttpServerResponse.jsonUnsafe(await resolveProjectMetadata(new URL(request.url, "http://localhost").searchParams.get("path")))),
    )

    yield* router.add("GET", "/experimental/project-metadata/for-routine", (request) =>
      Effect.promise(async () =>
        HttpServerResponse.jsonUnsafe(
          await projectsReferencingRoutine(new URL(request.url, "http://localhost").searchParams.get("id")),
        ),
      ),
    )
  }),
).pipe(Layer.provide(authOnlyRouterLayer))

// LangSmith tracing status: env-gated, read-only. Never returns the API key
// value -- only whether it's present -- see
// packages/core/src/observability/langsmith.ts for the presence-check rules.
const tracingStatusRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add("GET", "/experimental/tracing/status", () =>
      Effect.sync(() => {
        const tracing = LangSmith.tracingConfig()
        return HttpServerResponse.jsonUnsafe({
          ok: true,
          enabled: tracing.enabled,
          project: tracing.project,
          hasKey: tracing.hasKey,
        })
      }),
    )
  }),
).pipe(Layer.provide(authOnlyRouterLayer))

// Image generation: provider-agnostic (local FLUX hub, Recraft, Gemini).
// /providers only ever reports presence/reachability booleans -- never key
// values -- and /generate never logs a key either (see tool/image-gen.ts).
const imageGenRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add("GET", "/experimental/image/providers", () =>
      Effect.promise(async () => HttpServerResponse.jsonUnsafe(await imageProviderStatus())),
    )

    yield* router.add("POST", "/experimental/image/generate", (request) =>
      Effect.gen(function* () {
        const raw = yield* Effect.orDie(request.text)
        let body: { prompt?: unknown; provider?: unknown; size?: unknown }
        try {
          body = JSON.parse(raw || "{}")
        } catch {
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "Invalid JSON body" }, { status: 400 })
        }

        const prompt = typeof body.prompt === "string" ? body.prompt.trim() : ""
        if (!prompt) return HttpServerResponse.jsonUnsafe({ ok: false, error: "prompt is required" }, { status: 400 })

        const provider = isImageProviderID(body.provider) ? body.provider : undefined
        const size = typeof body.size === "string" ? body.size : undefined

        const result = yield* Effect.promise(() => generateImage({ prompt, provider, size }))
        return HttpServerResponse.jsonUnsafe(result, { status: result.ok ? 200 : 502 })
      }),
    )
  }),
).pipe(Layer.provide(authOnlyRouterLayer))

// SECURITY-CRITICAL: server-side encrypted env/secrets store.
//   - GET  /experimental/env/secrets        -> metadata list ONLY (no values).
//   - POST /experimental/env/secrets        -> set {name,value,scope?}; the
//                                              value is encrypted + never echoed.
//   - DELETE /experimental/env/secrets/:name -> delete (scope via ?scope=).
// Mutations (POST/DELETE) are gated behind OPENCODE_SECRETS_ENABLED. There is
// deliberately NO route that returns a decrypted value — the only consumer of
// plaintext is the internal Secrets.secretsEnvFor() used to build a spawned
// child's env, which is never routed. See src/secrets/store.ts.
const secretsRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add("GET", "/experimental/env/secrets", (request) =>
      Effect.promise(async () => {
        const url = new URL(request.url, "http://localhost")
        const scope = url.searchParams.get("scope") ?? undefined
        const secrets = await Secrets.listSecrets(scope)
        // Metadata only — never a value.
        return HttpServerResponse.jsonUnsafe({ enabled: Secrets.secretsEnabled(), secrets })
      }),
    )

    yield* router.add("POST", "/experimental/env/secrets", (request) =>
      Effect.gen(function* () {
        if (!Secrets.secretsEnabled()) {
          return HttpServerResponse.jsonUnsafe(
            { ok: false, error: "secrets are disabled (set OPENCODE_SECRETS_ENABLED=1)" },
            { status: 403 },
          )
        }
        // Reject oversized bodies by declared Content-Length BEFORE buffering, so
        // a caller can't force us to read/parse an arbitrarily large payload.
        // Cap = 64KiB value + name/scope + JSON overhead.
        const SECRETS_MAX_BODY_BYTES = 128 * 1024
        const declaredLen = Number((request.headers as Record<string, string | undefined>)["content-length"])
        if (Number.isFinite(declaredLen) && declaredLen > SECRETS_MAX_BODY_BYTES) {
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "request body too large" }, { status: 413 })
        }
        const raw = yield* Effect.orDie(request.text)
        if (Buffer.byteLength(raw, "utf8") > SECRETS_MAX_BODY_BYTES) {
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "request body too large" }, { status: 413 })
        }
        let body: { name?: unknown; value?: unknown; scope?: unknown }
        try {
          body = JSON.parse(raw || "{}")
        } catch {
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "invalid JSON body" }, { status: 400 })
        }
        const name = typeof body.name === "string" ? body.name : ""
        const value = typeof body.value === "string" ? body.value : ""
        const scope = typeof body.scope === "string" ? body.scope : undefined
        const result = yield* Effect.promise(async () => {
          try {
            const meta = await Secrets.setSecret({ name, value, scope })
            // Response echoes metadata ONLY — never the value the caller sent.
            return { status: 201 as const, body: { ok: true as const, secret: meta } }
          } catch (err: unknown) {
            // Scrub any secret material out of the error before returning it.
            const message = String((Secrets.redact as any)(err instanceof Error ? err.message : String(err), [value]))
            return { status: 400 as const, body: { ok: false as const, error: message } }
          }
        })
        return HttpServerResponse.jsonUnsafe(result.body, { status: result.status })
      }),
    )

    yield* router.add("DELETE", "/experimental/env/secrets/:name", (request) =>
      Effect.promise(async () => {
        if (!Secrets.secretsEnabled()) {
          return HttpServerResponse.jsonUnsafe(
            { ok: false, error: "secrets are disabled (set OPENCODE_SECRETS_ENABLED=1)" },
            { status: 403 },
          )
        }
        const name = decodeParam(request.url, /^\/experimental\/env\/secrets\/([^/]+)$/)
        if (!name) return HttpServerResponse.jsonUnsafe({ ok: false, error: "missing secret name" }, { status: 400 })
        const url = new URL(request.url, "http://localhost")
        const scope = url.searchParams.get("scope") ?? undefined
        const deleted = await Secrets.deleteSecret(name, scope)
        return HttpServerResponse.jsonUnsafe({ ok: true, deleted }, { status: deleted ? 200 : 404 })
      }),
    )
  }),
).pipe(Layer.provide(authOnlyRouterLayer))

// Home Chat (milestone-1): front OpenDesign's chat backend from the dashboard
// home view instead of rebuilding chat/artifacts. OD daemon URL is env-
// configurable (OPENCODE_OD_URL, default http://127.0.0.1:7456). All routes
// return a graceful offline shape when OD is down; message contents and secrets
// are never logged.
//
// OD contract (verified live against the daemon 2026-07-09):
//   POST /api/chat  body {message, agentId, projectId?} -> an SSE stream. The
//     first frame is `event: start` with data {runId, agentId, projectId, cwd,
//     ...}. The run is tracked + buffered server-side, so its events survive the
//     POST client disconnecting and can be replayed by id.
//   GET  /api/runs/:id/events -> SSE replay of a run's full event log. Named
//     events seen: start | stderr | stdout | agent | end | error. `agent` data
//     carries {type,label,...} status/text frames; `end` carries {status,...}.
//   GET  /api/runs/:id -> run status JSON {id, projectId, status, error, ...}.
//   GET  /api/projects -> {projects:[{id, name, metadata:{baseDir}, ...}]}.
//   GET  /api/agents -> {agents:[{id, name, available, ...}]} (executor list).
const homeChatDefaultAgent = () => process.env.OPENCODE_OD_AGENT || "codex"

type HomeChatStartResult =
  | { ok: true; runId: string; agentId: string; projectId?: string }
  | { ok: false; error: string }

// Start an OD chat run and return its run id. We read only enough of the chat
// SSE stream to capture the `start` frame's runId, then release the connection;
// OD keeps the run alive and buffers its events for /api/runs/:id/events to
// replay, so the client subscribes there rather than holding this POST open.
async function odStartChatRun(input: {
  message: string
  projectId?: string
  agentId?: string
}): Promise<HomeChatStartResult> {
  const od = odDaemonUrl()
  const agentId = input.agentId || homeChatDefaultAgent()
  const controller = new AbortController()
  try {
    const res = await fetch(`${od}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        message: input.message,
        agentId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
      }),
      signal: controller.signal,
    })
    if (!res.ok || !res.body) {
      controller.abort()
      return { ok: false, error: "OpenDesign offline" }
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffered = ""
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffered += decoder.decode(chunk.value, { stream: true })
        const runMatch = buffered.match(/"runId"\s*:\s*"([^"]+)"/)
        if (runMatch?.[1]) {
          return { ok: true, runId: runMatch[1], agentId, projectId: input.projectId }
        }
        // Safety cap: never buffer an unbounded stream while hunting for runId.
        if (buffered.length > 64 * 1024) break
      }
      // Stream ended before a `start`/runId frame: surface OD's error text if any.
      const errMatch = buffered.match(/"message"\s*:\s*"([^"]+)"/)
      return { ok: false, error: errMatch?.[1] || "OpenDesign did not return a run id" }
    } finally {
      await reader.cancel().catch(() => undefined)
      controller.abort()
    }
  } catch {
    controller.abort()
    return { ok: false, error: "OpenDesign offline" }
  }
}

// Build a text/event-stream response that emits a single error frame then ends.
// Used when OD is offline or the run id is unknown, so the browser's SSE reader
// sees a structured error instead of a dead socket.
function homeChatSseError(message: string) {
  return HttpServerResponse.setHeader(
    HttpServerResponse.stream(
      Stream.make(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`).pipe(Stream.encodeText),
      { contentType: "text/event-stream" },
    ),
    "cache-control",
    "no-store",
  )
}

// Relay OD's run-events SSE to the client. On client disconnect the effect
// interrupts the stream fiber, which runs the generator's finally block to abort
// the upstream fetch and cancel the reader (no leaked OD connection).
async function odRunEventsResponse(runId: string) {
  const od = odDaemonUrl()
  const controller = new AbortController()
  let res: Response
  try {
    res = await fetch(`${od}/api/runs/${encodeURIComponent(runId)}/events`, {
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    })
  } catch {
    controller.abort()
    return homeChatSseError("OpenDesign offline")
  }
  if (!res.ok || !res.body) {
    controller.abort()
    return homeChatSseError(`run not found (${res.status})`)
  }
  const reader = res.body.getReader()
  return HttpServerResponse.setHeader(
    HttpServerResponse.stream(
      Stream.fromAsyncIterable(
        (async function* () {
          try {
            while (true) {
              const chunk = await reader.read()
              if (chunk.done) return
              yield chunk.value
            }
          } finally {
            controller.abort()
            await reader.cancel().catch(() => undefined)
          }
        })(),
        (cause) => new Error(`home-chat events stream error: ${String(cause)}`),
      ),
      { contentType: "text/event-stream" },
    ),
    "cache-control",
    "no-store",
  )
}

// Relay the fleet daemon's "continue" SSE (a resumed cross-CLI session's live
// StreamEvents) to the client. Same disconnect-safety as odRunEventsResponse:
// client disconnect interrupts the fiber → finally aborts the upstream fetch.
// The daemon itself gates spawning behind FLEET_DRIVE_ENABLED=1 (403 when off).
async function fleetContinueResponse(cli: string, id: string, bodyJson: string) {
  const base = process.env.OPENCODE_FLEET_URL || "http://127.0.0.1:8788"
  const controller = new AbortController()
  let res: Response
  try {
    res = await fetch(`${base}/sessions/${encodeURIComponent(cli)}/${encodeURIComponent(id)}/continue`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: bodyJson,
      signal: controller.signal,
    })
  } catch {
    controller.abort()
    return homeChatSseError("fleet service offline")
  }
  if (!res.ok || !res.body) {
    controller.abort()
    return homeChatSseError(res.status === 403 ? "fleet drive disabled (set FLEET_DRIVE_ENABLED=1)" : `continue failed (${res.status})`)
  }
  const reader = res.body.getReader()
  return HttpServerResponse.setHeader(
    HttpServerResponse.stream(
      Stream.fromAsyncIterable(
        (async function* () {
          try {
            while (true) {
              const chunk = await reader.read()
              if (chunk.done) return
              yield chunk.value
            }
          } finally {
            controller.abort()
            await reader.cancel().catch(() => undefined)
          }
        })(),
        (cause) => new Error(`fleet continue stream error: ${String(cause)}`),
      ),
      { contentType: "text/event-stream" },
    ),
    "cache-control",
    "no-store",
  )
}

// List OD projects for the home-chat project picker: id + name + baseDir only.
async function odHomeChatProjects() {
  const od = odDaemonUrl()
  try {
    const res = await fetch(`${od}/api/projects`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return { ok: false as const, error: "OpenDesign offline", projects: [] }
    const data = (await res.json()) as { projects?: Array<Record<string, any>> }
    const projects = (data.projects ?? []).map((p) => ({
      id: String(p?.id ?? ""),
      name: String(p?.name ?? "Untitled"),
      baseDir: typeof p?.metadata?.baseDir === "string" ? p.metadata.baseDir : null,
    }))
    return { ok: true as const, daemon: od, generatedAt: new Date().toISOString(), projects }
  } catch {
    return { ok: false as const, error: "OpenDesign offline", projects: [] }
  }
}

const homeChatRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add("POST", "/experimental/home-chat/send", (request) =>
      Effect.gen(function* () {
        const raw = yield* Effect.orDie(request.text)
        let body: { message?: unknown; projectId?: unknown; agentId?: unknown }
        try {
          body = JSON.parse(raw || "{}")
        } catch {
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "Invalid JSON body" }, { status: 400 })
        }
        const message = typeof body.message === "string" ? body.message.trim() : ""
        if (!message) return HttpServerResponse.jsonUnsafe({ ok: false, error: "message is required" }, { status: 400 })
        const projectId = typeof body.projectId === "string" && body.projectId ? body.projectId : undefined
        const agentId = typeof body.agentId === "string" && body.agentId ? body.agentId : undefined
        const result = yield* Effect.promise(() => odStartChatRun({ message, projectId, agentId }))
        return HttpServerResponse.jsonUnsafe(result, { status: result.ok ? 200 : 502 })
      }),
    )

    yield* router.add("GET", "/experimental/home-chat/events/:runId", (request) =>
      Effect.gen(function* () {
        const runId = decodeParam(request.url, /^\/experimental\/home-chat\/events\/([^/]+)$/)
        if (!runId) return HttpServerResponse.text("Missing run id", { status: 400 })
        return yield* Effect.promise(() => odRunEventsResponse(runId))
      }),
    )

    yield* router.add("GET", "/experimental/home-chat/projects", () =>
      Effect.promise(async () => HttpServerResponse.jsonUnsafe(await odHomeChatProjects())),
    )
  }),
).pipe(Layer.provide(authOnlyRouterLayer))

const codexMultiAuthScript = () =>
  process.env.OPENCODE_CODEX_MULTI_AUTH_SCRIPT ||
  "/home/dev/repos/LLM-Experiments/scripts/opencode-codex-multi-auth-profile.mjs"

const CODEX_MULTI_AUTH_SEND_BLOCK_REASON = "Server-side multi-auth runtime adapter is not verified."
const CODEX_MULTI_AUTH_NO_ACCOUNT_BLOCK_REASON = "No isolated Codex multi-auth account is configured."
const CODEX_MULTI_AUTH_PROMPT_ADAPTER_READY_ROUTING = "multi-auth-sidecar-prompt-adapter"

type CodexMultiAuthCommandResult = {
  ok: boolean
  configured: boolean
  command?: string
  output?: string
  error?: string
}

type CodexMultiAuthStatusResult = Record<string, unknown>

type CodexMultiAuthRuntimeProof = {
  ok: boolean
  state?: "running" | "success" | "failed" | "disabled"
  providerID: "codex-multi-auth"
  fallbackUsed: false
  accountAlias: string | null
  modelID: string | null
  cwd: string
  promptPreview: string
  outputPreview?: string
  text?: string
  error?: string
  exitCode?: number | null
  durationMs: number
  startedAt?: string
  verifiedAt: string
  pid?: number | null
  sessionID?: string | null
  profileSource: "isolated-profile-plugin"
}

let codexMultiAuthStatusInFlight: Promise<CodexMultiAuthStatusResult> | null = null
let codexMultiAuthStatusCache: {
  expiresAt: number
  value: CodexMultiAuthStatusResult
} | null = null
let codexMultiAuthRuntimeProofInFlight = false
const CODEX_MULTI_AUTH_RUNTIME_PROOF_RUNNING_TTL_MS = 2 * 60 * 1000

function clearCodexMultiAuthStatusCache() {
  codexMultiAuthStatusCache = null
}

async function runCodexMultiAuthCommand(command: string, timeout = 8000): Promise<CodexMultiAuthCommandResult> {
  const script = codexMultiAuthScript()
  if (!existsSync(script))
    return {
      ok: false,
      configured: false,
      command: script + " " + command,
      error: "Codex multi-auth status script not found",
    }
  return new Promise<CodexMultiAuthCommandResult>((resolve) => {
    execFile(
      "node",
      [script, command],
      {
        cwd: path.dirname(path.dirname(script)),
        timeout,
        maxBuffer: 256_000,
        env: { ...process.env, NPM_CONFIG_LOGLEVEL: "error", npm_config_loglevel: "error" },
      },
      (error, stdout, stderr) => {
        const output = [stdout?.toString(), stderr?.toString()].filter(Boolean).join("\n").trim()
        if (error) {
          resolve({
            ok: false,
            configured: true,
            command: script + " " + command,
            error: cleanStatusOutput(output || error.message),
          })
          return
        }
        resolve({ ok: true, configured: true, command: script + " " + command, output: cleanStatusOutput(output) })
      },
    )
  })
}

function parseCodexAccountCount(...values: Array<string | undefined>) {
  const text = values.filter(Boolean).join("\n")
  const explicit = text.match(/Accounts:\s*(\d+)/i)
  if (explicit) return Number(explicit[1])
  const listed = text.match(/Account\s+#?\d+/gi)
  return listed?.length ?? 0
}

function parseCodexActiveAccount(...values: Array<string | undefined>) {
  const text = values.filter(Boolean).join("\n")
  const explicit = text.match(/Active:\s*([^\n]+)/i)?.[1]?.trim()
  if (explicit && !/^(none|null|n\/a|not\s+set)$/i.test(explicit)) return explicit
  const listed = text.match(/^\s*([A-Za-z0-9._-]+)\s+\(active\)/m)?.[1]?.trim()
  return listed || null
}

function parseCodexRotationStrategy(...values: Array<string | undefined>) {
  const text = values.filter(Boolean).join("\n")
  const strategy = text.match(/Strategy:\s*([^\n]+)/i)?.[1]?.trim()
  return strategy || null
}

function parseCodexUsageSummary(value: string | undefined) {
  if (!value) return null
  const lines = value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /remaining|weekly|limit|reset|usage/i.test(line))
  return lines.slice(0, 3).join(" · ") || null
}

function codexAccountSummaryFromGuard(alias: string, value: unknown, activeAlias: string | null) {
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  return {
    alias,
    email: typeof record.email === "string" ? record.email : null,
    accountId: typeof record.accountId === "string" ? record.accountId : null,
    enabled: record.enabled !== false,
    active: alias === activeAlias,
    source: typeof record.source === "string" ? record.source : "opencode-multi-auth",
    planType: typeof record.planType === "string" ? record.planType : null,
    usageCount: typeof record.usageCount === "number" ? record.usageCount : null,
    lastUsed: typeof record.lastUsed === "number" ? record.lastUsed : null,
    lastSeenAt: typeof record.lastSeenAt === "number" ? record.lastSeenAt : null,
    expiresAt: typeof record.expiresAt === "number" ? record.expiresAt : null,
    reauthNeeded: record.reauthNeeded === true,
    disabledReason: typeof record.disabledReason === "string" ? record.disabledReason : null,
  }
}

function codexAccountSummaryFromLegacy(value: unknown, index: number, activeIndex: number) {
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  const email = typeof record.email === "string" ? record.email : null
  return {
    alias: email ? email.split("@")[0] : `account-${index + 1}`,
    email,
    accountId: typeof record.accountId === "string" ? record.accountId : null,
    label: typeof record.accountLabel === "string" ? record.accountLabel : null,
    enabled: true,
    active: index === activeIndex,
    reauthNeeded: false,
    disabledReason: null,
    source: "legacy-oc-codex-multi-auth",
    planType: null,
    usageCount: null,
    lastUsed: typeof record.lastUsed === "number" ? record.lastUsed : null,
    lastSeenAt: typeof record.addedAt === "number" ? record.addedAt : null,
    expiresAt: typeof record.expiresAt === "number" ? record.expiresAt : null,
  }
}

function codexMultiAuthLoginAttemptPath() {
  const home = process.env.HOME || "/home/dev"
  return path.join(home, ".local", "share", "opencode-codex-multi-auth", "login-status.json")
}

function codexMultiAuthRuntimeProofPath() {
  const home = process.env.HOME || "/home/dev"
  return path.join(home, ".local", "share", "opencode-codex-multi-auth", "runtime-proof.json")
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

function codexMultiAuthRuntimeProofPidAlive(pid: unknown) {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function codexMultiAuthRuntimeProofStaleReason(value: Record<string, unknown>) {
  if (value.state !== "running") return null
  const startedAtMs = typeof value.startedAt === "string" ? Date.parse(value.startedAt) : Number.NaN
  if (!Number.isFinite(startedAtMs)) return "Runtime proof process is stale because it has no valid start time."
  if (Date.now() - startedAtMs > CODEX_MULTI_AUTH_RUNTIME_PROOF_RUNNING_TTL_MS)
    return "Runtime proof process is stale because it exceeded the running proof timeout."
  if (!codexMultiAuthRuntimeProofPidAlive(value.pid))
    return "Runtime proof process is stale because the recorded process is no longer running."
  return null
}

function sanitizeCodexMultiAuthRuntimeProof(value: Record<string, unknown> | null): CodexMultiAuthRuntimeProof | null {
  if (!value) return null
  const staleReason = codexMultiAuthRuntimeProofStaleReason(value)
  const ok = staleReason ? false : value.ok === true
  const cwd = typeof value.cwd === "string" ? value.cwd : "/home/dev/repos/opencode"
  const verifiedAt = typeof value.verifiedAt === "string" ? value.verifiedAt : null
  if (!verifiedAt) return null
  const startedAtMs = typeof value.startedAt === "string" ? Date.parse(value.startedAt) : Number.NaN
  return {
    ok,
    state:
      staleReason
        ? "failed"
        : value.state === "running" || value.state === "success" || value.state === "failed" || value.state === "disabled"
        ? value.state
        : ok
          ? "success"
          : typeof value.error === "string"
            ? "failed"
            : undefined,
    providerID: "codex-multi-auth",
    fallbackUsed: false,
    accountAlias: typeof value.accountAlias === "string" ? value.accountAlias : null,
    modelID: typeof value.modelID === "string" ? value.modelID : null,
    cwd,
    promptPreview: typeof value.promptPreview === "string" ? value.promptPreview.slice(0, 200) : "",
    outputPreview: typeof value.outputPreview === "string" ? value.outputPreview.slice(0, 500) : undefined,
    text: typeof value.text === "string" ? value.text.slice(0, 1000) : undefined,
    error: staleReason ?? (typeof value.error === "string" ? cleanStatusOutput(value.error).slice(0, 1000) : undefined),
    exitCode: typeof value.exitCode === "number" ? value.exitCode : null,
    durationMs:
      staleReason && Number.isFinite(startedAtMs)
        ? Math.max(0, Date.now() - startedAtMs)
        : typeof value.durationMs === "number"
          ? value.durationMs
          : 0,
    startedAt: typeof value.startedAt === "string" ? value.startedAt : undefined,
    verifiedAt: staleReason ? new Date().toISOString() : verifiedAt,
    pid: typeof value.pid === "number" ? value.pid : null,
    sessionID: typeof value.sessionID === "string" ? value.sessionID : null,
    profileSource: "isolated-profile-plugin",
  }
}

function readCodexMultiAuthRuntimeProof() {
  const file = codexMultiAuthRuntimeProofPath()
  const raw = readJsonObject(file)
  const proof = sanitizeCodexMultiAuthRuntimeProof(raw)
  if (raw?.state === "running" && proof?.state === "failed" && proof.error) {
    try {
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(proof, null, 2))
    } catch {}
  }
  return proof
}

function writeCodexMultiAuthRuntimeProof(value: CodexMultiAuthRuntimeProof) {
  const file = codexMultiAuthRuntimeProofPath()
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(sanitizeCodexMultiAuthRuntimeProof(value) ?? value, null, 2))
}

function codexMultiAuthRuntimeReady() {
  return readCodexMultiAuthRuntimeProof()?.ok === true
}

function codexMultiAuthPromptAdapterReady(accountsConfigured: boolean) {
  return accountsConfigured && codexMultiAuthRuntimeReady()
}

function codexMultiAuthSendBlocked(accountsConfigured: boolean) {
  return !codexMultiAuthPromptAdapterReady(accountsConfigured)
}

function codexMultiAuthSendBlockReason(accountsConfigured: boolean) {
  if (!accountsConfigured) return CODEX_MULTI_AUTH_NO_ACCOUNT_BLOCK_REASON
  return codexMultiAuthRuntimeReady() ? null : CODEX_MULTI_AUTH_SEND_BLOCK_REASON
}

function codexMultiAuthSendRouting(accountsConfigured: boolean) {
  if (!accountsConfigured) return "blocked-no-isolated-account"
  return codexMultiAuthRuntimeReady()
    ? CODEX_MULTI_AUTH_PROMPT_ADAPTER_READY_ROUTING
    : "multi-auth-profile-pending-runner-verification"
}

function codexMultiAuthBaseProviderVisibility(accountsConfigured: boolean) {
  const showBaseOpenAI = process.env.OPENCODE_SHOW_BASE_OPENAI_WITH_MULTI_AUTH === "1"
  const disableHide = process.env.OPENCODE_HIDE_BASE_OPENAI_WITH_MULTI_AUTH === "0"
  const hidden = accountsConfigured && !showBaseOpenAI && !disableHide
  return {
    hidden,
    providerID: "openai",
    replacementProviderID: "codex-multi-auth",
    reason: hidden
      ? "hidden-while-multi-auth-ready"
      : accountsConfigured
        ? "visible-by-env-override"
        : "visible-until-multi-auth-account-exists",
    restoreEnv: "OPENCODE_SHOW_BASE_OPENAI_WITH_MULTI_AUTH=1",
  }
}

function codexMultiAuthGuardStorePath() {
  const home = process.env.HOME || "/home/dev"
  const profileName = process.env.OPENCODE_MULTI_AUTH_PROFILE || "guard22-codex-multi-auth"
  return path.join(
    home,
    ".opencode-profiles",
    profileName,
    "home",
    ".config",
    "opencode-multi-auth",
    "accounts.json",
  )
}

function codexMultiAuthLegacyStorePath() {
  const home = process.env.HOME || "/home/dev"
  return path.join(
    home,
    ".opencode-profiles",
    "codex-multi-auth",
    "home",
    ".opencode",
    "oc-codex-multi-auth-accounts.json",
  )
}

function readCodexMultiAuthFastAccountStatus(): CodexMultiAuthStatusResult | null {
  const guardStore = codexMultiAuthGuardStorePath()
  const legacyStore = codexMultiAuthLegacyStorePath()

  const guard = readJsonObject(guardStore)
  const guardAccounts = guard?.accounts
  if (guardAccounts && typeof guardAccounts === "object" && !Array.isArray(guardAccounts)) {
    const aliases = Object.keys(guardAccounts)
    const activeAlias =
      typeof guard.activeAlias === "string" && guard.activeAlias.trim()
        ? guard.activeAlias.trim()
        : (aliases[0] ?? null)
    const forcedAlias = typeof guard.forcedAlias === "string" && guard.forcedAlias.trim() ? guard.forcedAlias.trim() : null
    const forcedUntil = typeof guard.forcedUntil === "number" && Number.isFinite(guard.forcedUntil) ? guard.forcedUntil : null
    const forceActive = Boolean(forcedAlias && (!forcedUntil || forcedUntil > Date.now()))
    const accounts = aliases.map((alias) => codexAccountSummaryFromGuard(alias, (guardAccounts as Record<string, unknown>)[alias], activeAlias))
    const rotationStrategy =
      typeof guard.rotationStrategy === "string"
        ? guard.rotationStrategy
        : typeof (guard.settings as Record<string, unknown> | undefined)?.rotationStrategy === "string"
          ? ((guard.settings as Record<string, unknown>).rotationStrategy as string)
          : null
    return {
      ok: aliases.length > 0,
      configured: true,
      providerID: "codex-multi-auth",
      baseProviderID: "openai",
      baseProviderVisibility: codexMultiAuthBaseProviderVisibility(aliases.length > 0),
      runtimeReady: codexMultiAuthRuntimeReady(),
      sendBlocked: codexMultiAuthSendBlocked(aliases.length > 0),
      sendBlockReason: codexMultiAuthSendBlockReason(aliases.length > 0),
      runtimeProof: readCodexMultiAuthRuntimeProof(),
      accountCount: aliases.length,
      accountsConfigured: aliases.length > 0,
      accounts,
      accountStore: { type: "guard22", path: guardStore },
      activeAccount: activeAlias,
      forcedAccount: forceActive ? forcedAlias : null,
      forcedUntil: forceActive ? forcedUntil : null,
      rotationStrategy,
      sendRouting: codexMultiAuthSendRouting(aliases.length > 0),
      statusPhase: aliases.length > 0 ? "account_written" : "needs_plugin_account",
      usageSummary: null,
      warning:
        aliases.length > 0
          ? codexMultiAuthRuntimeReady()
            ? "Codex multi-auth runtime and prompt adapter are ready. Prompts route through the isolated sidecar profile."
            : "Codex multi-auth accounts are configured. Runtime proof is still required before account rotation is available."
          : "No Codex multi-auth plugin accounts are configured yet.",
      source: "fast-account-store",
    }
  }

  const legacy = readJsonObject(legacyStore)
  const legacyAccounts = legacy?.accounts
  if (legacy && Array.isArray(legacyAccounts)) {
    const accountCount = legacyAccounts.length
    const activeIndex = typeof legacy.activeIndex === "number" ? legacy.activeIndex : 0
    const accounts = legacyAccounts.map((account, index) => codexAccountSummaryFromLegacy(account, index, activeIndex))
    return {
      ok: accountCount > 0,
      configured: true,
      providerID: "codex-multi-auth",
      baseProviderID: "openai",
      baseProviderVisibility: codexMultiAuthBaseProviderVisibility(accountCount > 0),
      runtimeReady: codexMultiAuthRuntimeReady(),
      sendBlocked: codexMultiAuthSendBlocked(accountCount > 0),
      sendBlockReason: codexMultiAuthSendBlockReason(accountCount > 0),
      runtimeProof: readCodexMultiAuthRuntimeProof(),
      accountCount,
      accountsConfigured: accountCount > 0,
      accounts,
      accountStore: { type: "legacy", path: legacyStore },
      activeAccount: accounts[activeIndex]?.alias ?? (accountCount > 0 ? `account-${activeIndex + 1}` : null),
      rotationStrategy: "round-robin",
      sendRouting: codexMultiAuthSendRouting(accountCount > 0),
      statusPhase: accountCount > 0 ? "account_written" : "needs_plugin_account",
      usageSummary: null,
      warning:
        accountCount > 0
          ? codexMultiAuthRuntimeReady()
            ? "Codex multi-auth legacy profile is runtime proofed and prompt adapter ready. Prompts route through the isolated sidecar profile."
            : "Codex multi-auth accounts are configured in the legacy profile. Runtime proof is still required before account rotation is available."
          : "No Codex multi-auth plugin accounts are configured yet.",
      source: "fast-legacy-account-store",
    }
  }

  return null
}

function codexMultiAuthAccountAction(body: Record<string, unknown>) {
  const action = typeof body.action === "string" ? body.action : ""
  const alias = typeof body.alias === "string" ? body.alias.trim() : ""
  const store = codexMultiAuthGuardStorePath()
  const data = readJsonObject(store)
  const accounts = data?.accounts
  if (!data || !accounts || typeof accounts !== "object" || Array.isArray(accounts)) {
    return { ok: false, error: "Guard22 Codex multi-auth account store is not available.", store }
  }
  const aliases = Object.keys(accounts)
  if (action === "set-active") {
    if (!alias || !aliases.includes(alias)) return { ok: false, error: `Unknown Codex account alias: ${alias || "empty"}`, aliases }
    const next = {
      ...data,
      activeAlias: alias,
      lastManualSwitchAt: Date.now(),
      forcedAlias: null,
      forcedUntil: null,
    }
    writeFileSync(store, JSON.stringify(next, null, 2))
    clearCodexMultiAuthStatusCache()
    return { ok: true, action, alias, status: readCodexMultiAuthFastAccountStatus() }
  }
  if (action === "set-rotation") {
    const strategy = typeof body.strategy === "string" ? body.strategy.trim() : ""
    const allowed = new Set(["round-robin", "least-used", "random", "weighted-round-robin"])
    if (!allowed.has(strategy)) return { ok: false, error: `Unsupported rotation strategy: ${strategy}`, allowed: Array.from(allowed) }
    const settings = data.settings && typeof data.settings === "object" && !Array.isArray(data.settings) ? (data.settings as Record<string, unknown>) : {}
    const next = {
      ...data,
      rotationStrategy: strategy,
      settings: {
        ...settings,
        rotationStrategy: strategy,
      },
    }
    writeFileSync(store, JSON.stringify(next, null, 2))
    clearCodexMultiAuthStatusCache()
    return { ok: true, action, strategy, status: readCodexMultiAuthFastAccountStatus() }
  }
  if (action === "force-account") {
    if (!alias || !aliases.includes(alias)) return { ok: false, error: `Unknown Codex account alias: ${alias || "empty"}`, aliases }
    const durationMinutes =
      typeof body.durationMinutes === "number" && Number.isFinite(body.durationMinutes) ? body.durationMinutes : 120
    const forcedUntil = Date.now() + Math.max(5, Math.min(durationMinutes, 24 * 60)) * 60_000
    const next = {
      ...data,
      activeAlias: alias,
      forcedAlias: alias,
      forcedUntil,
      forcedBy: "opencode-accounts-panel",
      lastManualSwitchAt: Date.now(),
      lastForceAt: Date.now(),
    }
    writeFileSync(store, JSON.stringify(next, null, 2))
    clearCodexMultiAuthStatusCache()
    return { ok: true, action, alias, forcedUntil, status: readCodexMultiAuthFastAccountStatus() }
  }
  if (action === "clear-force") {
    const next = {
      ...data,
      forcedAlias: null,
      forcedUntil: null,
      forcedBy: null,
      lastForceClearedAt: Date.now(),
    }
    writeFileSync(store, JSON.stringify(next, null, 2))
    clearCodexMultiAuthStatusCache()
    return { ok: true, action, status: readCodexMultiAuthFastAccountStatus() }
  }
  if (action === "remove-account") {
    if (!alias || !aliases.includes(alias)) return { ok: false, error: `Unknown Codex account alias: ${alias || "empty"}`, aliases }
    const nextAccounts = { ...(accounts as Record<string, unknown>) }
    delete nextAccounts[alias]
    const remainingAliases = Object.keys(nextAccounts)
    const nextActive =
      data.activeAlias === alias
        ? (remainingAliases[0] ?? null)
        : typeof data.activeAlias === "string"
          ? data.activeAlias
          : (remainingAliases[0] ?? null)
    const next = {
      ...data,
      accounts: nextAccounts,
      activeAlias: nextActive,
      forcedAlias: data.forcedAlias === alias ? null : data.forcedAlias,
      forcedUntil: data.forcedAlias === alias ? null : data.forcedUntil,
      forcedBy: data.forcedAlias === alias ? null : data.forcedBy,
      lastAccountRemovedAt: Date.now(),
    }
    writeFileSync(store, JSON.stringify(next, null, 2))
    clearCodexMultiAuthStatusCache()
    return { ok: true, action, alias, status: readCodexMultiAuthFastAccountStatus() }
  }
  if (action === "set-enabled") {
    if (!alias || !aliases.includes(alias)) return { ok: false, error: `Unknown Codex account alias: ${alias || "empty"}`, aliases }
    const enabled = body.enabled !== false
    const current = (accounts as Record<string, unknown>)[alias]
    const currentRecord =
      current && typeof current === "object" && !Array.isArray(current) ? (current as Record<string, unknown>) : {}
    const next = {
      ...data,
      accounts: {
        ...(accounts as Record<string, unknown>),
        [alias]: {
          ...currentRecord,
          enabled,
        },
      },
      lastAccountEnabledAt: Date.now(),
    }
    writeFileSync(store, JSON.stringify(next, null, 2))
    clearCodexMultiAuthStatusCache()
    return { ok: true, action, alias, enabled, status: readCodexMultiAuthFastAccountStatus() }
  }
  return {
    ok: false,
    error: `Unsupported Codex account action: ${action}`,
    supported: ["set-active", "set-rotation", "force-account", "clear-force", "remove-account", "set-enabled"],
  }
}

function readCodexMultiAuthLoginAttempt() {
  const file = codexMultiAuthLoginAttemptPath()
  try {
    const raw = readFileSync(file, "utf8")
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return null
    return sanitizeCodexMultiAuthLoginAttempt(parsed as Record<string, unknown>)
  } catch {
    return null
  }
}

function writeCodexMultiAuthLoginAttempt(value: Record<string, unknown>) {
  const file = codexMultiAuthLoginAttemptPath()
  try {
    const sanitized = sanitizeCodexMultiAuthLoginAttempt(value)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(
      file,
      JSON.stringify(
        {
          ...sanitized,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    )
  } catch {}
}

function sanitizeCodexMultiAuthLoginAttempt(value: Record<string, unknown>) {
  const sanitized: Record<string, unknown> = { ...value }
  const output = typeof value.output === "string" ? value.output : undefined
  const error = typeof value.error === "string" ? value.error : undefined
  const parsed = parseCodexAuthStart(output)
  const phase = typeof value.phase === "string" ? value.phase : ""
  const userCode = typeof value.userCode === "string" ? value.userCode.trim() : parsed.code
  if (!sanitized.authMode && parsed.mode) sanitized.authMode = parsed.mode
  if (phase === "waiting_for_device_approval" && userCode) sanitized.userCode = userCode
  else delete sanitized.userCode
  if (output !== undefined) sanitized.output = redactCodexAuthOutput(output)
  if (error !== undefined) sanitized.error = redactCodexAuthOutput(error)
  if (phase === "waiting_for_device_approval" && userCode) sanitized.hasUserCode = true
  else delete sanitized.hasUserCode
  return sanitized
}

function processIsRunning(pid: unknown) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function normalizeCodexMultiAuthLoginAttempt(attempt: Record<string, unknown> | null) {
  if (
    attempt &&
    attempt.phase === "account_written_or_already_authorized" &&
    parseCodexAuthFailure([attempt.output, attempt.error, attempt.authorizationURL].filter(Boolean).join("\n"))
  ) {
    const next = sanitizeCodexMultiAuthLoginAttempt({
      ...attempt,
      ok: false,
      background: false,
      authorizationURL: undefined,
      phase: "failed_before_device_code",
      error: parseCodexAuthFailure(
        [attempt.output, attempt.error, attempt.authorizationURL].filter(Boolean).join("\n"),
      ),
      note: "Start a fresh Authenticate Codex account flow after the rate limit or challenge clears.",
    })
    writeCodexMultiAuthLoginAttempt(next)
    return next
  }
  const waiting = attempt?.phase === "waiting_for_device_approval" || attempt?.phase === "waiting_for_browser_approval"
  if (!waiting || processIsRunning(attempt.pid)) return attempt
  const next = sanitizeCodexMultiAuthLoginAttempt({
    ...attempt,
    ok: false,
    background: false,
    phase: "failed_after_device_code",
    error: "Login process is no longer running before the Codex account was confirmed.",
    note: "Start a fresh Authenticate Codex account flow and approve the newest auth URL.",
  })
  writeCodexMultiAuthLoginAttempt(next)
  return next
}

function redactCodexAuthOutput(value: string | undefined) {
  if (!value) return ""
  return cleanStatusOutput(value)
    .replace(/(Enter code:\s*)([A-Z0-9-]+)/gi, "$1[redacted-code]")
    .replace(/(Enter this one-time code:\s*)([A-Z0-9-]+)/gi, "$1[redacted-code]")
    .replace(/(user[_ -]?code[:\s]+)([A-Z0-9-]+)/gi, "$1[redacted-code]")
    .replace(/\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/g, "[redacted-code]")
}

async function buildCodexMultiAuthStatus(): Promise<CodexMultiAuthStatusResult> {
  const rawLoginAttempt = normalizeCodexMultiAuthLoginAttempt(readCodexMultiAuthLoginAttempt())
  const fast = readCodexMultiAuthFastAccountStatus()
  const rawLoginPhase = typeof rawLoginAttempt?.phase === "string" ? rawLoginAttempt.phase : null
  const loginAttempt =
    fast?.accountsConfigured === true &&
    rawLoginPhase &&
    (rawLoginPhase.startsWith("failed") ||
      rawLoginPhase === "account_written" ||
      rawLoginPhase === "account_written_or_already_authorized")
      ? {
          ok: true,
          configured: true,
          background: false,
          phase: "account_written",
          note: "A Codex multi-auth account is already configured. Older login attempts are hidden from the live Accounts panel.",
          updatedAt: new Date().toISOString(),
        }
      : rawLoginAttempt
  const base = {
    commands: ["login", "login-headless", "list", "status", "limits", "health", "run"],
    loginRoute: "/experimental/codex-multi-auth/login",
    authFlow: "opencode-multi-auth add <alias>",
    loginAttempt,
  }
  if (fast?.accountsConfigured === true) {
    return {
      ...fast,
      ...base,
      ok: true,
      configured: true,
      runtimeReady: codexMultiAuthRuntimeReady(),
      sendBlocked: codexMultiAuthSendBlocked(true),
      sendBlockReason: codexMultiAuthSendBlockReason(true),
      runtimeProof: readCodexMultiAuthRuntimeProof(),
      statusPhase: "account_written",
      sendRouting: codexMultiAuthSendRouting(true),
      warning: codexMultiAuthRuntimeReady()
        ? "Codex multi-auth accounts are configured from the isolated local profile. Prompts route through the sidecar prompt adapter."
        : "Codex multi-auth accounts are configured from the isolated local profile. Runtime proof is still required before prompts can route through multi-auth.",
      listOutput: `Accounts: ${fast.accountCount}`,
      limitsOutput: "Usage and weekly limits are not reported by this multi-auth wrapper yet.",
      healthOutput: "Codex multi-auth account store is reachable.",
    }
  }

  const status = await runCodexMultiAuthCommand("status", 12_000)
  if (!status.configured || !status.ok)
    return {
      ...status,
      ...base,
      accountCount: 0,
      accountsConfigured: false,
      runtimeReady: codexMultiAuthRuntimeReady(),
      sendBlocked: true,
      sendBlockReason: CODEX_MULTI_AUTH_NO_ACCOUNT_BLOCK_REASON,
      sendRouting: "blocked-no-isolated-account",
      runtimeProof: readCodexMultiAuthRuntimeProof(),
      warning: status.error ?? "Codex multi-auth status is unavailable.",
    }
  const statusAccountCount = parseCodexAccountCount(status.output)
  const detailResults: CodexMultiAuthCommandResult[] =
    statusAccountCount > 0
      ? await Promise.all([
          runCodexMultiAuthCommand("list", 12_000),
          Promise.resolve({
            ok: true,
            configured: true,
            output: "Usage and weekly limits are not reported by this multi-auth wrapper yet.",
          }),
          Promise.resolve({
            ok: true,
            configured: true,
            output: "Codex multi-auth profile is reachable.",
          }),
        ])
      : [
          { ok: true, configured: true, output: status.output },
          { ok: true, configured: true, output: "" },
          { ok: true, configured: true, output: "" },
        ]
  const [list, limits, health] = detailResults
  const accountCount = parseCodexAccountCount(status.output, list.output, limits.output, health.output)
  const accountsConfigured = accountCount > 0
  const activeAccount = parseCodexActiveAccount(status.output, list.output)
  const rotationStrategy = parseCodexRotationStrategy(status.output, list.output) ?? "round-robin"
  const loginAttemptPhase = typeof loginAttempt?.phase === "string" ? loginAttempt.phase : null
  const loginAuthMode = typeof loginAttempt?.authMode === "string" ? loginAttempt.authMode : null
  const failedAuthStartWarning =
    loginAuthMode === "browser-callback"
      ? "The last Codex login printed an OAuth callback URL but timed out before the localhost callback returned to CT100. Start a fresh Authenticate Codex account flow and open the new link in the server Agent Browser."
      : "The last Codex login printed a device code but failed before writing an account. Start a fresh Authenticate Codex account flow."
  return {
    ...status,
    ...base,
    providerID: "codex-multi-auth",
    baseProviderID: "openai",
    baseProviderVisibility: codexMultiAuthBaseProviderVisibility(accountsConfigured),
    runtimeReady: codexMultiAuthRuntimeReady(),
    sendBlocked: codexMultiAuthSendBlocked(accountsConfigured),
    sendBlockReason: codexMultiAuthSendBlockReason(accountsConfigured),
    runtimeProof: readCodexMultiAuthRuntimeProof(),
    accountCount,
    accountsConfigured,
    activeAccount,
    rotationStrategy,
    sendRouting: codexMultiAuthSendRouting(accountsConfigured),
    warning: accountsConfigured
      ? codexMultiAuthRuntimeReady()
        ? "Codex multi-auth accounts are configured. Prompts route through the isolated sidecar prompt adapter."
        : "Codex multi-auth accounts are configured. Runtime proof is still required before account rotation is available."
      : loginAttemptPhase === "account_written_or_already_authorized"
        ? "The last Codex login process exited successfully, but no multi-auth account is visible yet. Refresh status once; if accountCount remains 0, rerun Authenticate Codex account."
        : loginAttemptPhase === "failed_after_device_code"
          ? failedAuthStartWarning
          : "No Codex multi-auth plugin accounts are configured yet. Normal OpenAI OAuth may exist, but Codex Multi-Auth model selections are blocked until an isolated account and runtime adapter are available.",
    statusPhase: accountsConfigured ? "account_written" : (loginAttemptPhase ?? "needs_plugin_account"),
    usageSummary: parseCodexUsageSummary(limits.output),
    listOutput: list.ok ? list.output : status.output,
    limitsOutput: limits.output ?? limits.error,
    healthOutput: health.output ?? health.error,
  }
}

async function codexMultiAuthStatus(): Promise<CodexMultiAuthStatusResult> {
  const now = Date.now()
  if (codexMultiAuthStatusCache && codexMultiAuthStatusCache.expiresAt > now) {
    return {
      ...codexMultiAuthStatusCache.value,
      cache: {
        hit: true,
        expiresInMs: codexMultiAuthStatusCache.expiresAt - now,
      },
    }
  }
  if (codexMultiAuthStatusInFlight) return codexMultiAuthStatusInFlight
  codexMultiAuthStatusInFlight = buildCodexMultiAuthStatus()
    .then((value) => {
      codexMultiAuthStatusCache = {
        value,
        expiresAt: Date.now() + 15_000,
      }
      return value
    })
    .finally(() => {
      codexMultiAuthStatusInFlight = null
    })
  return codexMultiAuthStatusInFlight
}

function summarizeCodexMultiAuthWorkspaceStatus(status: CodexMultiAuthStatusResult) {
  const loginAttempt = status.loginAttempt as Record<string, unknown> | null | undefined
  const runtimeProof = sanitizeCodexMultiAuthRuntimeProof(
    status.runtimeProof && typeof status.runtimeProof === "object" && !Array.isArray(status.runtimeProof)
      ? (status.runtimeProof as Record<string, unknown>)
      : null,
  )
  return {
    ok: status.ok === true,
    configured: status.configured === true,
    providerID: typeof status.providerID === "string" ? status.providerID : "codex-multi-auth",
    baseProviderID: typeof status.baseProviderID === "string" ? status.baseProviderID : "openai",
    baseProviderVisibility:
      status.baseProviderVisibility && typeof status.baseProviderVisibility === "object" && !Array.isArray(status.baseProviderVisibility)
        ? status.baseProviderVisibility
        : codexMultiAuthBaseProviderVisibility(status.accountsConfigured === true),
    runtimeReady: status.runtimeReady === true,
    sendBlocked: status.sendBlocked !== false,
    sendBlockReason: typeof status.sendBlockReason === "string" ? status.sendBlockReason : null,
    accountCount: typeof status.accountCount === "number" ? status.accountCount : 0,
    accountsConfigured: status.accountsConfigured === true,
    accounts: Array.isArray(status.accounts) ? status.accounts : [],
    accountStore:
      status.accountStore && typeof status.accountStore === "object" && !Array.isArray(status.accountStore)
        ? status.accountStore
        : null,
    activeAccount: typeof status.activeAccount === "string" ? status.activeAccount : null,
    forcedAccount: typeof status.forcedAccount === "string" ? status.forcedAccount : null,
    forcedUntil: typeof status.forcedUntil === "number" ? status.forcedUntil : null,
    rotationStrategy: typeof status.rotationStrategy === "string" ? status.rotationStrategy : null,
    sendRouting: typeof status.sendRouting === "string" ? status.sendRouting : null,
    statusPhase: typeof status.statusPhase === "string" ? status.statusPhase : null,
    usageSummary: typeof status.usageSummary === "string" ? status.usageSummary : null,
    runtimeProof,
    warning: typeof status.warning === "string" ? status.warning : null,
    error: typeof status.error === "string" ? status.error : null,
    cache: status.cache ?? null,
    loginAttempt: loginAttempt
      ? {
          phase: typeof loginAttempt.phase === "string" ? loginAttempt.phase : null,
          authMode: typeof loginAttempt.authMode === "string" ? loginAttempt.authMode : null,
          background: loginAttempt.background === true,
          startedAt: typeof loginAttempt.startedAt === "string" ? loginAttempt.startedAt : null,
          updatedAt: typeof loginAttempt.updatedAt === "string" ? loginAttempt.updatedAt : null,
          hasAuthorizationURL: typeof loginAttempt.authorizationURL === "string",
          hasUserCode: Boolean(loginAttempt.userCode || loginAttempt.hasUserCode),
          error: typeof loginAttempt.error === "string" ? redactCodexAuthOutput(loginAttempt.error) : null,
          note: typeof loginAttempt.note === "string" ? loginAttempt.note : null,
        }
      : null,
  }
}

async function codexMultiAuthWorkspaceStatus() {
  const fallback = readCodexMultiAuthFastAccountStatus() ?? {
    ok: false,
    configured: true,
    runtimeReady: codexMultiAuthRuntimeReady(),
    sendBlocked: true,
    sendBlockReason: codexMultiAuthSendBlockReason(false),
    runtimeProof: readCodexMultiAuthRuntimeProof(),
    accountCount: 0,
    accountsConfigured: false,
    sendRouting: "blocked-no-isolated-account",
    warning: "Codex multi-auth summary is deferred. Open the Codex tab for direct status.",
  }
  const result = await statusWithTimeout<any>("Codex multi-auth status", 600, fallback, codexMultiAuthStatus)
  if (result?.timedOut && fallback.accountsConfigured === true) {
    return {
      ...fallback,
      timedOut: true,
      error: null,
      warning:
        "Codex multi-auth account summary came from the local profile store. Full plugin status is deferred to the Codex tab.",
    }
  }
  return result
}

function safeCodexMultiAuthProofCwd(value: unknown) {
  const fallback = "/home/dev/repos/opencode"
  if (typeof value !== "string" || !value.trim()) return fallback
  const resolved = path.resolve(value)
  const allowed = ["/home/dev/repos", "/home/dev/shared", "/tmp"]
  if (!allowed.some((root) => resolved === root || resolved.startsWith(root + path.sep))) return fallback
  return resolved
}

function parseCodexRunJsonLines(output: string) {
  const events: Array<Record<string, unknown>> = []
  const text: string[] = []
  let sessionID: string | null = null
  for (const line of output.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("{")) continue
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>
      events.push(event)
      if (typeof event.sessionID === "string") sessionID = event.sessionID
      const part = event.part as Record<string, unknown> | undefined
      if (event.type === "text" && typeof part?.text === "string") text.push(part.text)
      if (event.type === "error") {
        const error = event.error as Record<string, unknown> | undefined
        const data = error?.data as Record<string, unknown> | undefined
        const message =
          typeof data?.message === "string"
            ? data.message
            : typeof error?.message === "string"
              ? error.message
              : undefined
        if (message) text.push(`[error] ${message}`)
      }
    } catch {}
  }
  return { events, text: text.join("\n").trim(), sessionID }
}

async function codexMultiAuthRunProof(input: Record<string, unknown>) {
  clearCodexMultiAuthStatusCache()
  const startedAt = Date.now()
  const status = await codexMultiAuthStatus()
  if (status.accountsConfigured !== true) {
    return {
      ok: false,
      providerID: "codex-multi-auth",
      fallbackUsed: false,
      runtimeReady: false,
      sendBlocked: true,
      sendBlockReason: CODEX_MULTI_AUTH_NO_ACCOUNT_BLOCK_REASON,
      status: summarizeCodexMultiAuthWorkspaceStatus(status),
    }
  }

  const prompt =
    typeof input.prompt === "string" && input.prompt.trim()
      ? input.prompt.trim().slice(0, 2000)
      : "Reply with exactly: MULTI_AUTH_RUNTIME_OK"
  const modelID = typeof input.modelID === "string" && input.modelID.trim() ? input.modelID.trim() : null
  const cwd = safeCodexMultiAuthProofCwd(input.cwd)
  const manualProofCommand =
    'cd /home/dev/repos/LLM-Experiments && env -u OPENAI_API_KEY -u OPENAI_API_BASE -u OPENAI_BASE_URL -u OPENAI_ORG_ID OPENCODE_MULTI_AUTH_REQUIRE_ACCOUNT=1 NO_COLOR=1 timeout 180 node scripts/opencode-codex-multi-auth-profile.mjs run --format json --dir /home/dev/repos/opencode "Reply with exactly: MULTI_AUTH_RUNTIME_OK"'
  if (process.env.OPENCODE_CODEX_MULTI_AUTH_DISABLE_SERVICE_PROOF === "1") {
    const proof: CodexMultiAuthRuntimeProof = {
      ok: false,
      state: "disabled",
      providerID: "codex-multi-auth",
      fallbackUsed: false,
      accountAlias: typeof status.activeAccount === "string" ? status.activeAccount : null,
      modelID,
      cwd,
      promptPreview: prompt.slice(0, 200),
      outputPreview: "",
      text: "",
      error:
        "Web-service runtime proof execution is disabled by OPENCODE_CODEX_MULTI_AUTH_DISABLE_SERVICE_PROOF=1. Run the external shell proof command instead.",
      exitCode: null,
      durationMs: Date.now() - startedAt,
      verifiedAt: new Date().toISOString(),
      sessionID: null,
      profileSource: "isolated-profile-plugin",
    }
    writeCodexMultiAuthRuntimeProof(proof)
    clearCodexMultiAuthStatusCache()
    return {
      ...proof,
      runtimeReady: false,
      sendBlocked: true,
      sendBlockReason: CODEX_MULTI_AUTH_SEND_BLOCK_REASON,
      manualProofCommand,
      status: summarizeCodexMultiAuthWorkspaceStatus(await codexMultiAuthStatus()),
    }
  }

  const args = ["run", "--format", "json", "--dir", cwd]
  if (modelID) args.push("--model", modelID)
  args.push(prompt)

  const realHome = process.env.OPENCODE_MULTI_AUTH_REAL_HOME || process.env.HOME || "/home/dev"
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: realHome,
    USER: process.env.USER || "dev",
    LOGNAME: process.env.LOGNAME || "dev",
    SHELL: process.env.SHELL || "/bin/bash",
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    XDG_CONFIG_HOME: path.join(realHome, ".config"),
    XDG_DATA_HOME: path.join(realHome, ".local", "share"),
    XDG_CACHE_HOME: path.join(realHome, ".cache"),
  }
  delete env.OPENAI_API_KEY
  delete env.OPENAI_API_BASE
  delete env.OPENAI_BASE_URL
  delete env.OPENAI_ORG_ID
  env.NPM_CONFIG_LOGLEVEL = "error"
  env.npm_config_loglevel = "error"
  env.NO_COLOR = "1"
  env.OPENCODE_MULTI_AUTH_REQUIRE_ACCOUNT = "1"
  env.OPENCODE_MULTI_AUTH_PROFILE = process.env.OPENCODE_MULTI_AUTH_PROFILE || "guard22-codex-multi-auth"

  if (codexMultiAuthRuntimeProofInFlight) {
    const current = readCodexMultiAuthRuntimeProof()
    return {
      ...(current ?? {
        ok: false,
        state: "running",
        providerID: "codex-multi-auth",
        fallbackUsed: false,
        accountAlias: typeof status.activeAccount === "string" ? status.activeAccount : null,
        modelID,
        cwd,
        promptPreview: prompt.slice(0, 200),
        durationMs: Date.now() - startedAt,
        verifiedAt: new Date().toISOString(),
        profileSource: "isolated-profile-plugin",
      }),
      runtimeReady: false,
      sendBlocked: true,
      sendBlockReason: CODEX_MULTI_AUTH_SEND_BLOCK_REASON,
      status: summarizeCodexMultiAuthWorkspaceStatus(await codexMultiAuthStatus()),
    }
  }

  const script = codexMultiAuthScript()
  const child = spawn("node", [script, ...args], {
    cwd: path.dirname(path.dirname(script)),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  codexMultiAuthRuntimeProofInFlight = true
  let stdout = ""
  let stderr = ""
  child.stdout?.setEncoding("utf8")
  child.stderr?.setEncoding("utf8")
  child.stdout?.on("data", (chunk) => {
    stdout += chunk
    if (stdout.length > 1_000_000) stdout = stdout.slice(-1_000_000)
  })
  child.stderr?.on("data", (chunk) => {
    stderr += chunk
    if (stderr.length > 1_000_000) stderr = stderr.slice(-1_000_000)
  })

  const runningProof: CodexMultiAuthRuntimeProof = {
    ok: false,
    state: "running",
    providerID: "codex-multi-auth",
    fallbackUsed: false,
    accountAlias: typeof status.activeAccount === "string" ? status.activeAccount : null,
    modelID,
    cwd,
    promptPreview: prompt.slice(0, 200),
    outputPreview: "",
    text: "",
    durationMs: Date.now() - startedAt,
    startedAt: new Date(startedAt).toISOString(),
    verifiedAt: new Date().toISOString(),
    pid: child.pid ?? null,
    sessionID: null,
    profileSource: "isolated-profile-plugin",
  }
  writeCodexMultiAuthRuntimeProof(runningProof)
  clearCodexMultiAuthStatusCache()

  let timedOut = false
  const killTimer = setTimeout(() => {
    timedOut = true
    child.kill("SIGTERM")
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL")
    }, 2_000).unref()
  }, 60_000)
  killTimer.unref()

  child.on("close", (code, signal) => {
    clearTimeout(killTimer)
    const output = [stdout, stderr].filter(Boolean).join("\n")
    const parsed = parseCodexRunJsonLines(output)
    const text = parsed.text.replace(/\[error\]\s*/g, "").trim()
    const ok = !timedOut && code === 0 && Boolean(text)
    const finishedProof: CodexMultiAuthRuntimeProof = {
      ok,
      state: ok ? "success" : "failed",
      providerID: "codex-multi-auth",
      fallbackUsed: false,
      accountAlias: typeof status.activeAccount === "string" ? status.activeAccount : null,
      modelID,
      cwd,
      promptPreview: prompt.slice(0, 200),
      outputPreview: cleanStatusOutput(output).slice(0, 500),
      text: text.slice(0, 1000),
      error: ok
        ? undefined
        : cleanStatusOutput(
            output ||
              (timedOut
                ? "Codex multi-auth runtime proof timed out after 60000ms."
                : `Codex multi-auth runtime proof exited with code ${code ?? "null"}${signal ? ` and signal ${signal}` : ""}.`),
          ).slice(0, 1000),
      exitCode: typeof code === "number" ? code : null,
      durationMs: Date.now() - startedAt,
      startedAt: new Date(startedAt).toISOString(),
      verifiedAt: new Date().toISOString(),
      pid: child.pid ?? null,
      sessionID: parsed.sessionID,
      profileSource: "isolated-profile-plugin",
    }
    writeCodexMultiAuthRuntimeProof(finishedProof)
    codexMultiAuthRuntimeProofInFlight = false
    clearCodexMultiAuthStatusCache()
  })
  child.on("error", (error) => {
    clearTimeout(killTimer)
    writeCodexMultiAuthRuntimeProof({
      ...runningProof,
      state: "failed",
      error: cleanStatusOutput(error.message).slice(0, 1000),
      durationMs: Date.now() - startedAt,
      verifiedAt: new Date().toISOString(),
    })
    codexMultiAuthRuntimeProofInFlight = false
    clearCodexMultiAuthStatusCache()
  })

  return {
    ...runningProof,
    runtimeReady: false,
    sendBlocked: true,
    sendBlockReason: CODEX_MULTI_AUTH_SEND_BLOCK_REASON,
    status: summarizeCodexMultiAuthWorkspaceStatus(await codexMultiAuthStatus()),
  }
}

async function statusWithTimeout<T>(label: string, timeoutMs: number, fallback: T, fn: () => Promise<T>) {
  let timedOut = false
  try {
    const result = await Promise.race([
      fn(),
      delay(timeoutMs).then(() => {
        timedOut = true
        return fallback
      }),
    ])
    if (timedOut && result && typeof result === "object") {
      return {
        ...(result as Record<string, unknown>),
        ok: false,
        timedOut: true,
        error: `${label} timed out after ${timeoutMs}ms`,
      } as T
    }
    return result
  } catch (error) {
    return {
      ...(fallback as Record<string, unknown>),
      ok: false,
      error: errorMessage(error),
    } as T
  }
}

function parseCodexAuthStart(value: string | undefined) {
  const text = value ?? ""
  const deviceURL = text.match(/https:\/\/auth\.openai\.com\/codex\/device[^\s)]*/i)?.[0] ?? null
  const browserCallbackURL = text.match(/https:\/\/auth\.openai\.com\/oauth\/authorize[^\s)]*/i)?.[0] ?? null
  const url = deviceURL ?? browserCallbackURL ?? null
  const code =
    text.match(/Enter code:\s*([A-Z0-9-]+)/i)?.[1] ??
    text.match(/Enter this one-time code:\s*([A-Z0-9-]+)/i)?.[1] ??
    text.match(/user[_ -]?code[:\s]+([A-Z0-9-]+)/i)?.[1] ??
    text.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b/)?.[1] ??
    null
  return { url, code, mode: browserCallbackURL ? "browser-callback" : deviceURL ? "device-code" : null }
}

function parseCodexAuthFailure(value: string | undefined) {
  const text = value ?? ""
  if (/Device code login could not be started/i.test(text)) return "Device-code login could not be started."
  if (/\b429\b/.test(text)) return "OpenAI device-code login was rate limited or challenged."
  if (/challenges\.cloudflare\.com/i.test(text) || /Just a moment/i.test(text)) {
    return "OpenAI device-code login returned a Cloudflare challenge instead of a device code."
  }
  if (/failed to initiate device authorization/i.test(text)) return "Failed to initiate device authorization."
  return null
}

async function codexMultiAuthLoginStart() {
  clearCodexMultiAuthStatusCache()
  const script = codexMultiAuthScript()
  const command =
    "cd /home/dev/repos/LLM-Experiments && node scripts/opencode-codex-multi-auth-profile.mjs login-headless"
  const existing = normalizeCodexMultiAuthLoginAttempt(readCodexMultiAuthLoginAttempt())
  const existingWaiting =
    existing?.phase === "waiting_for_device_approval" || existing?.phase === "waiting_for_browser_approval"
  if (existingWaiting && existing.authorizationURL && processIsRunning(existing.pid)) {
    return {
      ...existing,
      ok: true,
      configured: true,
      background: true,
      reused: true,
      note: "A Codex OAuth login is already waiting for approval. Open this URL in the server Agent Browser, then refresh Accounts.",
    }
  }
  if (!existsSync(script)) {
    return {
      ok: false,
      configured: false,
      terminalCommand: command,
      error: "Codex multi-auth status script not found",
      note: "The login wrapper is missing on this server.",
    }
  }

  return new Promise((resolve) => {
    const child = spawn("node", [script, "login-headless"], {
      cwd: path.dirname(path.dirname(script)),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NPM_CONFIG_LOGLEVEL: "error",
        npm_config_loglevel: "error",
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        TERM: "dumb",
      },
    })
    let settled = false
    let output = ""
    const startedAt = new Date().toISOString()
    let startupTimer: ReturnType<typeof setTimeout> | undefined
    let hardStop: ReturnType<typeof setTimeout> | undefined
    writeCodexMultiAuthLoginAttempt({
      ok: null,
      configured: true,
      background: true,
      pid: child.pid,
      startedAt,
      command: script + " login-headless",
      terminalCommand: command,
      phase: "started",
      output: "",
    })
    const killTree = () => {
      if (!child.pid) return
      try {
        process.kill(-child.pid, "SIGTERM")
      } catch {
        try {
          child.kill("SIGTERM")
        } catch {}
      }
    }
    const finish = (body: Record<string, unknown>, kill = false) => {
      if (settled) return
      settled = true
      if (startupTimer) clearTimeout(startupTimer)
      if (kill) killTree()
      resolve(body)
    }
    const append = (chunk: Buffer) => {
      output += chunk.toString()
      if (output.length > 16_000) output = output.slice(-16_000)
      const parsed = parseCodexAuthStart(output)
      if (parsed.url && (parsed.code || parsed.mode === "browser-callback")) {
        const cleaned = cleanStatusOutput(output)
        const userCodeExpiresAt = new Date(Date.now() + 15 * 60_000).toISOString()
        const redacted = redactCodexAuthOutput(cleaned)
        const phase = parsed.code ? "waiting_for_device_approval" : "waiting_for_browser_approval"
        writeCodexMultiAuthLoginAttempt({
          ok: null,
          configured: true,
          background: true,
          pid: child.pid,
          startedAt,
          command: script + " login-headless",
          terminalCommand: command,
          authorizationURL: parsed.url,
          userCode: parsed.code,
          userCodeExpiresAt,
          hasUserCode: !!parsed.code,
          phase,
          output: redacted,
          note: parsed.code
            ? "Device-code login is waiting for browser approval."
            : "Browser-callback login is waiting for approval. Open this URL in the server Agent Browser so localhost callback returns to CT100.",
        })
        clearCodexMultiAuthStatusCache()
        finish({
          ok: true,
          configured: true,
          background: true,
          pid: child.pid,
          startedAt,
          command: script + " login-headless",
          terminalCommand: command,
          authorizationURL: parsed.url,
          userCode: parsed.code,
          userCodeExpiresAt,
          hasUserCode: !!parsed.code,
          phase,
          output: redacted,
          note: parsed.code
            ? "Open the link, paste the code, approve the Codex OAuth account, then refresh Accounts. Repeat once per Codex account."
            : "Open the link in the server Agent Browser, approve the Codex OAuth account, then refresh Accounts. Repeat once per Codex account.",
        })
      }
    }
    startupTimer = setTimeout(() => {
      const cleaned = cleanStatusOutput(output)
      const redacted = redactCodexAuthOutput(cleaned)
      writeCodexMultiAuthLoginAttempt({
        ok: false,
        configured: true,
        background: false,
        startedAt,
        command: script + " login-headless",
        terminalCommand: command,
        phase: "failed_before_device_code",
        error: redacted || "Timed out before the login command printed a device-code URL.",
        output: redacted,
      })
      clearCodexMultiAuthStatusCache()
      finish(
        {
          ok: false,
          configured: true,
          background: false,
          startedAt,
          command: script + " login-headless",
          terminalCommand: command,
          phase: "failed_before_device_code",
          error: redacted || "Timed out before the login command printed a device-code URL.",
          note: "The plugin login command did not print a device-code URL. Check the command output below.",
        },
        true,
      )
    }, 75_000)
    hardStop = setTimeout(killTree, 16 * 60_000)
    child.stdout?.on("data", append)
    child.stderr?.on("data", append)
    child.on("error", (error) => {
      if (hardStop) clearTimeout(hardStop)
      writeCodexMultiAuthLoginAttempt({
        ok: false,
        configured: true,
        background: false,
        startedAt,
        command: script + " login-headless",
        terminalCommand: command,
        phase: "failed_before_device_code",
        error: error.message,
      })
      clearCodexMultiAuthStatusCache()
      finish(
        {
          ok: false,
          configured: true,
          background: false,
          startedAt,
          command: script + " login-headless",
          terminalCommand: command,
          phase: "failed_before_device_code",
          error: error.message,
          note: "The plugin login command failed before it could print a device-code URL.",
        },
        true,
      )
    })
    child.on("exit", (code, signal) => {
      if (hardStop) clearTimeout(hardStop)
      const parsed = parseCodexAuthStart(output)
      const cleaned = cleanStatusOutput(output)
      const authFailure = parseCodexAuthFailure(cleaned)
      const redacted = redactCodexAuthOutput(cleaned)
      const phase = authFailure
        ? "failed_before_device_code"
        : code === 0
          ? "account_written_or_already_authorized"
          : parsed.url || parsed.code
            ? "failed_after_device_code"
            : "failed_before_device_code"
      const body = {
        ok: code === 0,
        configured: true,
        background: false,
        startedAt,
        command: script + " login-headless",
        terminalCommand: command,
        authorizationURL: parsed.url,
        authMode: parsed.mode,
        hasUserCode: !!parsed.code,
        phase,
        output: redacted,
        error: authFailure ?? (code === 0 ? undefined : `Login command exited with ${signal ?? code}`),
        note:
          phase === "failed_after_device_code"
            ? "The OAuth process failed after printing an approval URL. Start a fresh Authenticate Codex account flow before approving another URL."
            : phase === "account_written_or_already_authorized"
              ? "The Codex OAuth login process exited successfully. Refresh Accounts to verify accountCount."
              : "The plugin login command exited before printing an approval URL.",
      }
      writeCodexMultiAuthLoginAttempt(body)
      clearCodexMultiAuthStatusCache()
      if (settled) return
      finish({ ...body, userCode: parsed.code })
    })
  })
}

function cleanStatusOutput(value: string) {
  return value
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B[@-_][0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((line) => !line.startsWith("npm error config prefix cannot be changed"))
    .filter((line) => !line.startsWith("npm warn"))
    .filter((line) => !line.match(/^\s*(package|required|current):/))
    .filter((line) => !line.match(/Waiting for authorization/i))
    .filter((line) => !line.match(/^\s*[◒◐◓◑■]\s*/))
    .filter((line) => line.trim() !== "}")
    .filter((line) => line.trim() !== "Canceled")
    .join("\n")
    .replace(/([A-Za-z0-9_-]{24,})/g, "[redacted]")
    .slice(0, 2000)
}

const conversationStateExportScript = () =>
  process.env.OPENCODE_CONVERSATION_EXPORT_SCRIPT ||
  "/home/dev/repos/LLM-Experiments/experiments/OpenCode/25-conversation-terminal-state-json/scripts/export-opencode-conversations.mjs"

const conversationStateExportLatestPath = () =>
  path.join(
    process.env.OPENCODE_STATE_EXPORT_DIR || "/home/dev/.local/share/opencode-workspace-state/conversations",
    "latest.json",
  )

function readConversationStateLatest() {
  const latest = readJsonObject(conversationStateExportLatestPath())
  if (!latest) {
    return {
      ok: false,
      error: "Conversation state export has not run yet.",
      latestPath: conversationStateExportLatestPath(),
      exportRoute: "/experimental/conversations/export",
    }
  }
  return latest
}

async function runConversationStateExport() {
  const script = conversationStateExportScript()
  if (!existsSync(script)) {
    return { ok: false, error: "Conversation export script not found", script }
  }
  return new Promise<Record<string, unknown>>((resolve) => {
    execFile(
      "bun",
      [script],
      {
        cwd: path.dirname(path.dirname(script)),
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      },
      (error, stdout, stderr) => {
        const output = [stdout?.toString(), stderr?.toString()].filter(Boolean).join("\n").trim()
        if (error) {
          resolve({ ok: false, error: cleanStatusOutput(output || error.message), script })
          return
        }
        try {
          const parsed = JSON.parse(stdout.toString()) as Record<string, unknown>
          resolve({ ...parsed, script })
        } catch {
          resolve({ ok: true, output: cleanStatusOutput(output), script, latest: readConversationStateLatest() })
        }
      },
    )
  })
}

function summarizeCodexAuthEvent(result: any) {
  return {
    ok: result?.ok === true,
    configured: result?.configured === true,
    background: result?.background === true,
    phase: typeof result?.phase === "string" ? result.phase : null,
    startedAt: typeof result?.startedAt === "string" ? result.startedAt : null,
    authorizationURL: typeof result?.authorizationURL === "string" ? result.authorizationURL : null,
    hasUserCode: Boolean(result?.userCode || result?.hasUserCode),
    error: typeof result?.error === "string" ? redactCodexAuthOutput(result.error) : null,
    note: typeof result?.note === "string" ? result.note : null,
  }
}

function summarizeRoutineEvent(action: string, result: any, id?: string | null) {
  const routine = result?.routine ?? result?.job ?? result?.created ?? result?.updated ?? null
  return {
    action,
    ok: result?.ok === true,
    id: id ?? routine?.id ?? result?.id ?? null,
    name: typeof routine?.name === "string" ? routine.name : null,
    enabled: typeof routine?.enabled === "boolean" ? routine.enabled : null,
    lastStatus: typeof routine?.lastStatus === "string" ? routine.lastStatus : null,
    nextRunAt: typeof routine?.nextRunAt === "string" ? routine.nextRunAt : null,
    error: typeof result?.error === "string" ? result.error.slice(0, 500) : null,
    totals: {
      total: result?.status?.counts?.total ?? result?.status?.summary?.total ?? null,
      enabled: result?.status?.counts?.enabled ?? result?.status?.summary?.enabled ?? null,
      disabled: result?.status?.counts?.disabled ?? result?.status?.summary?.disabled ?? null,
    },
  }
}

function summarizeLiveBrowserEvent(input: LiveBrowserInput, result: any) {
  return {
    action: input.action,
    ok: result?.ok !== false,
    currentURL:
      typeof result?.currentURL === "string" ? result.currentURL : typeof result?.url === "string" ? result.url : null,
    title: typeof result?.title === "string" ? result.title : null,
    selector: "selector" in input && typeof input.selector === "string" ? input.selector : null,
    hasText: "text" in input && typeof input.text === "string" && input.text.length > 0,
    point:
      "x" in input || "y" in input
        ? {
            x: typeof input.x === "number" ? input.x : null,
            y: typeof input.y === "number" ? input.y : null,
          }
        : null,
    error: typeof result?.error === "string" ? result.error.slice(0, 500) : null,
  }
}

function summarizeOpenDesignStatusEvent(result: any) {
  return {
    configured: result?.configured === true,
    publicURL: typeof result?.publicURL === "string" ? result.publicURL : null,
    proxyReady: result?.proxyReady === true,
    routeReady: result?.routeReady === true,
    health: {
      ok: result?.health?.ok === true,
      status: typeof result?.health?.status === "number" ? result.health.status : null,
      error: typeof result?.health?.error === "string" ? result.health.error.slice(0, 500) : null,
    },
    projects: {
      ok: result?.projects?.ok === true,
      status: typeof result?.projects?.status === "number" ? result.projects.status : null,
      count: typeof result?.projects?.count === "number" ? result.projects.count : null,
    },
  }
}

const workspaceSuiteRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const projects = yield* Project.Service
    const sessions = yield* Session.Service

    yield* router.add("GET", "/experimental/codex-multi-auth/status", () =>
      Effect.promise(async () => HttpServerResponse.jsonUnsafe(await codexMultiAuthStatus())),
    )

    yield* router.add("POST", "/experimental/codex-multi-auth/login", () =>
      Effect.promise(async () => {
        const result = await codexMultiAuthLoginStart()
        publishAppleBridgeEvent("codex_auth", "codex.auth.login.started", summarizeCodexAuthEvent(result))
        return HttpServerResponse.jsonUnsafe(result)
      }),
    )

    yield* router.add("POST", "/experimental/codex-multi-auth/account", (request) =>
      Effect.gen(function* () {
        const raw = yield* Effect.orDie(request.text)
        let body: Record<string, unknown>
        try {
          body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
        } catch {
          return HttpServerResponse.text("Invalid JSON body", { status: 400 })
        }
        const result = codexMultiAuthAccountAction(body)
        publishAppleBridgeEvent("codex_auth", "codex.auth.account.updated", {
          ok: result.ok === true,
          action: typeof body.action === "string" ? body.action : null,
          alias: typeof body.alias === "string" ? body.alias : null,
          error: typeof result.error === "string" ? result.error.slice(0, 500) : null,
        })
        return HttpServerResponse.jsonUnsafe(result, { status: result.ok ? 200 : 400 })
      }),
    )

    yield* router.add("POST", "/experimental/codex-multi-auth/run-proof", (request) =>
      Effect.gen(function* () {
        const raw = yield* Effect.orDie(request.text)
        let body: Record<string, unknown>
        try {
          body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
        } catch {
          return HttpServerResponse.text("Invalid JSON body", { status: 400 })
        }
        const result = yield* Effect.promise(() => codexMultiAuthRunProof(body))
        const resultRecord = result as Record<string, unknown>
        publishAppleBridgeEvent("codex_auth", "codex.auth.runtime.proof", {
          ok: result.ok === true,
          accountAlias: typeof resultRecord.accountAlias === "string" ? resultRecord.accountAlias : null,
          modelID: typeof resultRecord.modelID === "string" ? resultRecord.modelID : null,
          durationMs: typeof resultRecord.durationMs === "number" ? resultRecord.durationMs : null,
          sendBlocked: result.sendBlocked === true,
          error: typeof resultRecord.error === "string" ? resultRecord.error.slice(0, 500) : null,
        })
        const status = result.ok ? 200 : (resultRecord.state === "running" ? 202 : 500)
        return HttpServerResponse.jsonUnsafe(result, { status })
      }),
    )

    yield* router.add("GET", "/experimental/workspace-suite/status", () =>
      Effect.promise(async () => {
        const [openDesign, macView, routines, codexAccounts, workspaceIndex] = await Promise.all([
          statusWithTimeout<any>(
            "Open Design status",
            1000,
            {
              configured: false,
              proxyReady: true,
              proxyURL: "/experimental/open-design/proxy/",
              publicURL: "https://design.hustletogether.com",
            },
            openDesignStatus,
          ),
          statusWithTimeout<any>("Mac View status", 1500, { configured: false, mode: "read-only" }, macViewStatus),
          statusWithTimeout<any>("Routines status", 1000, { ok: false, routines: [] }, routinesStatus),
          codexMultiAuthWorkspaceStatus(),
          buildWorkspaceIndexSummary(projects, sessions),
        ])
        return HttpServerResponse.jsonUnsafe({
          ok: true,
          generatedAt: new Date().toISOString(),
          hostname: process.env.OPENCODE_HOSTNAME ?? null,
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
          workspaceTabs: workspaceTabsStatus(),
          openDesign,
          macView,
          routines,
          resources: {
            route: "/experimental/resources/status",
            macHost: process.env.OPENCODE_MAC_RESOURCE_HOST || "alfonso-mac",
          },
          codexAccounts: summarizeCodexMultiAuthWorkspaceStatus(codexAccounts),
          conversationState: readConversationStateLatest(),
          terminalState: readConversationStateLatest().terminalState ?? {
            currentBehavior: "workspace-scoped terminal tab metadata plus in-memory PTY processes",
            processPersistence: false,
            restartSafeShells: false,
          },
          artifactRootConfigured: !!process.env.OPENCODE_BROWSER_HOME,
          agentChrome: liveBrowserGateStatus(),
          workspaceIndex,
        })
      }),
    )

    yield* router.add("GET", "/experimental/workspace-suite/environments", () =>
      Effect.promise(async () => HttpServerResponse.jsonUnsafe(await liveOnlyEnvironmentStatus())),
    )

    yield* router.add("GET", "/experimental/conversations/state", () =>
      Effect.promise(async () =>
        HttpServerResponse.setHeader(
          HttpServerResponse.jsonUnsafe(readConversationStateLatest()),
          "cache-control",
          "private, no-store",
        ),
      ),
    )

    yield* router.add("POST", "/experimental/conversations/export", () =>
      Effect.promise(async () =>
        HttpServerResponse.setHeader(
          HttpServerResponse.jsonUnsafe(await runConversationStateExport()),
          "cache-control",
          "private, no-store",
        ),
      ),
    )

    yield* router.add("GET", "/experimental/workspace-env", () =>
      Effect.promise(async () => HttpServerResponse.jsonUnsafe(workspaceEnvStatus())),
    )

    yield* router.add("POST", "/experimental/workspace-env", (request) =>
      Effect.gen(function* () {
        const raw = yield* Effect.orDie(request.text)
        const body = raw ? JSON.parse(raw) : {}
        return yield* Effect.promise(async () => HttpServerResponse.jsonUnsafe(workspaceEnvAction(body as any)))
      }),
    )

    yield* router.add("GET", "/experimental/workspace-tabs/status", (request) =>
      Effect.promise(async () => {
        const url = new URL(request.url, "http://localhost")
        return HttpServerResponse.jsonUnsafe(workspaceTabsStatus(url.searchParams.get("sessionID") || undefined))
      }),
    )

    yield* router.add("POST", "/experimental/workspace-tabs/action", (request) =>
      Effect.gen(function* () {
        const raw = yield* Effect.orDie(request.text)
        const body = raw ? JSON.parse(raw) : {}
        return yield* Effect.promise(async () => HttpServerResponse.jsonUnsafe(workspaceTabsAction(body as any)))
      }),
    )

    yield* router.add("POST", "/experimental/workspace-tabs/client-state", (request) =>
      Effect.gen(function* () {
        const raw = yield* Effect.orDie(request.text)
        const body = raw ? JSON.parse(raw) : {}
        return yield* Effect.promise(async () =>
          HttpServerResponse.jsonUnsafe(updateWorkspaceTabsClientState(body as any)),
        )
      }),
    )

    yield* router.add("GET", "/experimental/workspace-tabs/pending", (request) =>
      Effect.promise(async () => {
        const url = new URL(request.url, "http://localhost")
        return HttpServerResponse.jsonUnsafe(
          workspaceTabsPendingActions(
            url.searchParams.get("sessionID") || undefined,
            url.searchParams.get("clientID") || undefined,
          ),
        )
      }),
    )

    yield* router.add("POST", "/experimental/workspace-tabs/ack", (request) =>
      Effect.gen(function* () {
        const raw = yield* Effect.orDie(request.text)
        const body = raw ? JSON.parse(raw) : {}
        return yield* Effect.promise(async () => HttpServerResponse.jsonUnsafe(ackWorkspaceTabsAction(body as any)))
      }),
    )

    yield* router.add("GET", "/experimental/resources/status", (request) =>
      Effect.promise(async () => {
        const url = new URL(request.url, "http://localhost")
        const target = url.searchParams.get("target")
        const safeTarget = target === "server" || target === "mac" || target === "all" ? target : "all"
        return HttpServerResponse.jsonUnsafe(await collectResourceStatus(safeTarget))
      }),
    )

    yield* router.add("GET", "/experimental/cli-resources/status", (request) =>
      Effect.promise(async () => {
        const url = new URL(request.url, "http://localhost")
        const force = url.searchParams.get("force") === "1"
        return HttpServerResponse.setHeader(
          HttpServerResponse.jsonUnsafe(await collectCliResourcesStatus(force)),
          "cache-control",
          "private, no-store",
        )
      }),
    )

    yield* router.add("POST", "/experimental/cli-resources/run", (request) =>
      Effect.gen(function* () {
        const raw = yield* Effect.orDie(request.text)
        const body = raw ? JSON.parse(raw) : {}
        const probe = typeof body?.probe === "string" ? body.probe : ""
        return yield* Effect.promise(async () =>
          HttpServerResponse.setHeader(
            HttpServerResponse.jsonUnsafe(await runCliResourceAction(probe)),
            "cache-control",
            "private, no-store",
          ),
        )
      }),
    )

    yield* router.add("GET", "/experimental/routines/status", () =>
      Effect.promise(async () => {
        ensureRoutinesScheduler()
        return HttpServerResponse.jsonUnsafe(await routinesStatus())
      }),
    )

    yield* router.add("GET", "/experimental/mcp/registry", () =>
      Effect.promise(async () => HttpServerResponse.jsonUnsafe(await mcpRegistryCatalog())),
    )

    // Skills Library tab: enumerate skills across known roots. Async FS only
    // (sync FS on the request path can wedge the event loop under disk pressure
    // per CT100 stability notes). Reads each SKILL.md's frontmatter name/desc.
    yield* router.add("GET", "/experimental/skills", () =>
      Effect.promise(async () => HttpServerResponse.jsonUnsafe(await listSkills())),
    )

    // Token-maxing tab: proxy the local token-maxing daemon's /usage. Daemon URL
    // is env-configurable; if it's offline we return a graceful marked shape so
    // the tab renders "daemon offline" instead of erroring.
    yield* router.add("GET", "/experimental/token-maxing/usage", () =>
      Effect.promise(async () => {
        const base = process.env.OPENCODE_TOKEN_MAXING_URL || "http://127.0.0.1:8787"
        try {
          const res = await fetch(`${base}/usage`, { signal: AbortSignal.timeout(3000) })
          if (!res.ok) {
            return HttpServerResponse.jsonUnsafe({
              ok: false,
              daemon: base,
              error: `token-maxing daemon error (${res.status})`,
              generatedAt: new Date().toISOString(),
              snapshots: [],
            })
          }
          const data = (await res.json()) as Record<string, unknown>
          return HttpServerResponse.jsonUnsafe({ ok: true, daemon: base, generatedAt: new Date().toISOString(), ...data })
        } catch {
          return HttpServerResponse.jsonUnsafe({
            ok: false,
            daemon: base,
            error: "token-maxing daemon offline",
            generatedAt: new Date().toISOString(),
            snapshots: [],
          })
        }
      }),
    )

    // Token-maxing switch: operator-token-gated failover trigger. The token is a
    // SERVER-side secret (OPENCODE_TOKEN_MAXING_TOKEN) forwarded to the daemon so
    // it never reaches the browser; without it configured, switching is refused.
    yield* router.add("POST", "/experimental/token-maxing/switch", (request) =>
      Effect.gen(function* () {
        const base = process.env.OPENCODE_TOKEN_MAXING_URL || "http://127.0.0.1:8787"
        const token = process.env.OPENCODE_TOKEN_MAXING_TOKEN?.trim()
        if (!token) {
          return HttpServerResponse.jsonUnsafe(
            { ok: false, daemon: base, error: "switching not configured (set OPENCODE_TOKEN_MAXING_TOKEN)" },
            { status: 403 },
          )
        }
        const raw = yield* Effect.orDie(request.text)
        let body: Record<string, unknown> = {}
        try {
          body = JSON.parse(raw || "{}")
        } catch {
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "invalid JSON body" }, { status: 400 })
        }
        return yield* Effect.promise(async () => {
          try {
            const res = await fetch(`${base}/switch`, {
              method: "POST",
              headers: { "content-type": "application/json", "x-operator-token": token },
              body: JSON.stringify({ adapterId: body.adapterId }),
              signal: AbortSignal.timeout(5000),
            })
            const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
            // Never echo the token back; pass through the daemon's ok/decision only.
            return HttpServerResponse.jsonUnsafe({ ok: res.ok, daemon: base, ...data }, { status: res.ok ? 200 : res.status })
          } catch {
            return HttpServerResponse.jsonUnsafe(
              { ok: false, daemon: base, error: "token-maxing daemon offline" },
              { status: 502 },
            )
          }
        })
      }),
    )

    // Agent Fleet tab: proxy the local fleet-service daemon's /sessions. Daemon
    // URL is env-configurable; if it's offline we return a graceful marked shape
    // so the tab renders "daemon offline" instead of erroring.
    yield* router.add("GET", "/experimental/fleet/sessions", () =>
      Effect.promise(async () => {
        const fleet = process.env.OPENCODE_FLEET_URL || "http://127.0.0.1:8788"
        try {
          const res = await fetch(`${fleet}/sessions?limit=200`, { signal: AbortSignal.timeout(3000) })
          // A reachable-but-erroring daemon (5xx/4xx) must not be reported as ok:true.
          if (!res.ok) {
            return HttpServerResponse.jsonUnsafe({
              ok: false,
              fleet,
              error: `fleet service error (${res.status})`,
              generatedAt: new Date().toISOString(),
              sessions: [],
              count: 0,
            })
          }
          const data = (await res.json()) as Record<string, unknown>
          return HttpServerResponse.jsonUnsafe({ ok: true, fleet, generatedAt: new Date().toISOString(), ...data })
        } catch {
          return HttpServerResponse.jsonUnsafe({
            ok: false,
            fleet,
            error: "fleet service offline",
            generatedAt: new Date().toISOString(),
            sessions: [],
            count: 0,
          })
        }
      }),
    )

    // Auto-improve tab: proxy the (standalone, default-OFF) auto-improve daemon's
    // /status — designated projects + per-project gate/run state. Graceful offline.
    yield* router.add("GET", "/experimental/auto-improve/status", () =>
      Effect.promise(async () => {
        const base = process.env.OPENCODE_AUTO_IMPROVE_URL || "http://127.0.0.1:8789"
        try {
          const res = await fetch(`${base}/status`, { signal: AbortSignal.timeout(3000) })
          if (!res.ok) {
            return HttpServerResponse.jsonUnsafe({
              ok: false,
              daemon: base,
              error: `auto-improve daemon error (${res.status})`,
              generatedAt: new Date().toISOString(),
              projects: [],
            })
          }
          const data = (await res.json()) as Record<string, unknown>
          return HttpServerResponse.jsonUnsafe({ ok: true, daemon: base, generatedAt: new Date().toISOString(), ...data })
        } catch {
          return HttpServerResponse.jsonUnsafe({
            ok: false,
            daemon: base,
            error: "auto-improve daemon offline",
            generatedAt: new Date().toISOString(),
            projects: [],
          })
        }
      }),
    )

    // Cross-CLI continue: resume a session on its native CLI via the fleet daemon
    // and relay the live StreamEvent SSE. Spawning is gated at the daemon
    // (FLEET_DRIVE_ENABLED); this proxy just streams whatever it returns.
    yield* router.add("POST", "/experimental/fleet/continue/:cli/:id", (request) =>
      Effect.gen(function* () {
        const m = request.url.match(/^\/experimental\/fleet\/continue\/([^/]+)\/([^/]+)/)
        if (!m) return HttpServerResponse.text("Missing cli/id", { status: 400 })
        let cli: string
        let id: string
        try {
          cli = decodeURIComponent(m[1]!)
          id = decodeURIComponent(m[2]!)
        } catch {
          return HttpServerResponse.text("Malformed cli/id", { status: 400 })
        }
        const raw = yield* Effect.orDie(request.text)
        // Pass the client's body through as-is (prompt etc.); default to {}.
        const bodyJson = (() => {
          try {
            return JSON.stringify(JSON.parse(raw || "{}"))
          } catch {
            return "{}"
          }
        })()
        return yield* Effect.promise(() => fleetContinueResponse(cli, id, bodyJson))
      }),
    )

    yield* router.add("GET", "/experimental/routines/jobs", () =>
      Effect.promise(async () => HttpServerResponse.jsonUnsafe(await routinesAction({ action: "list" }))),
    )

    yield* router.add("POST", "/experimental/routines/jobs", (request) =>
      Effect.gen(function* () {
        if (routinesBodyTooLargeByHeader(request.headers)) return HttpServerResponse.text("Body too large", { status: 413 })
        const raw = yield* Effect.orDie(request.text)
        if (routinesBodyTooLarge(raw)) return HttpServerResponse.text("Body too large", { status: 413 })
        type RoutineCreateBody = {
          name?: string
          description?: string
          schedule?: string
          command?: string
          host?: string
          icon?: string
          tags?: string[]
          notify?: string[]
        }
        let body: RoutineCreateBody
        try {
          body = JSON.parse(raw || "{}") as RoutineCreateBody
        } catch {
          return HttpServerResponse.text("Invalid JSON body", { status: 400 })
        }
        const result = yield* Effect.promise(() => createRoutineDraft(body))
        publishAppleBridgeEvent("routines", "routine.created", summarizeRoutineEvent("create", result))
        const error = result.ok ? undefined : (result as { error?: string }).error
        return HttpServerResponse.jsonUnsafe(result, {
          status: result.ok ? 200 : error?.includes("not enabled") ? 403 : 400,
        })
      }),
    )

    yield* router.add("PATCH", "/experimental/routines/jobs/:id", (request) =>
      Effect.gen(function* () {
        const id = decodeParam(request.url, /^\/experimental\/routines\/jobs\/([^/]+)$/)
        if (routinesBodyTooLargeByHeader(request.headers)) return HttpServerResponse.text("Body too large", { status: 413 })
        const raw = yield* Effect.orDie(request.text)
        if (routinesBodyTooLarge(raw)) return HttpServerResponse.text("Body too large", { status: 413 })
        type RoutineUpdateBody = {
          name?: string
          description?: string
          schedule?: string
          command?: string
          enabled?: boolean
          host?: string
          icon?: string
          tags?: string[]
          notify?: string[]
        }
        let body: RoutineUpdateBody
        try {
          body = JSON.parse(raw || "{}") as RoutineUpdateBody
        } catch {
          return HttpServerResponse.text("Invalid JSON body", { status: 400 })
        }
        const operatorToken =
          request.headers["x-opencode-routines-token"] ?? request.headers["x-opencode-routines-operator-token"]
        const result = yield* Effect.promise(() =>
          routinesAction({
            action: "update",
            id,
            ...body,
            caller: "http",
            operatorToken: typeof operatorToken === "string" ? operatorToken : undefined,
          }),
        )
        publishAppleBridgeEvent("routines", "routine.updated", summarizeRoutineEvent("update", result, id))
        const error = result.ok ? undefined : (result as { error?: string }).error
        return HttpServerResponse.jsonUnsafe(result, {
          status: result.ok ? 200 : error?.includes("not enabled") ? 403 : 400,
        })
      }),
    )

    yield* router.add("POST", "/experimental/routines/jobs/:id/run", (request) =>
      Effect.promise(async () => {
        const id = decodeParam(request.url, /^\/experimental\/routines\/jobs\/([^/]+)\/run$/)
        // Rate-limit run requests (MUST-FIX #8): a minimum interval between any
        // two run attempts on this server, cheap in-memory guard on top of the
        // per-routine run-lock in the runner.
        if (!routinesRunRateOk()) {
          return HttpServerResponse.jsonUnsafe(
            { ok: false, error: "Too many run requests; slow down.", mutationPolicy: "rate_limited" },
            { status: 429 },
          )
        }
        const operatorToken =
          request.headers["x-opencode-routines-token"] ?? request.headers["x-opencode-routines-operator-token"]
        const result = await routinesAction({
          action: "run",
          id,
          caller: "http",
          operatorToken: typeof operatorToken === "string" ? operatorToken : undefined,
        })
        publishAppleBridgeEvent("routines", "routine.run_requested", summarizeRoutineEvent("run", result, id))
        return HttpServerResponse.jsonUnsafe(result, { status: result.ok ? 200 : 403 })
      }),
    )

    yield* router.add("DELETE", "/experimental/routines/jobs/:id", (request) =>
      Effect.promise(async () => {
        const id = decodeParam(request.url, /^\/experimental\/routines\/jobs\/([^/]+)$/)
        const result = await routinesAction({ action: "delete", id })
        publishAppleBridgeEvent("routines", "routine.deleted", summarizeRoutineEvent("delete", result, id))
        const error = result.ok ? undefined : (result as { error?: string }).error
        return HttpServerResponse.jsonUnsafe(result, {
          status: result.ok ? 200 : error?.includes("not enabled") ? 403 : 400,
        })
      }),
    )

    yield* router.add("GET", "/experimental/routines/jobs/:id/logs", (request) =>
      Effect.promise(async () => {
        const id = decodeParam(request.url, /^\/experimental\/routines\/jobs\/([^/]+)\/logs$/)
        return HttpServerResponse.jsonUnsafe(await routineLogs(id))
      }),
    )

    yield* router.add("GET", "/experimental/open-design/status", () =>
      Effect.promise(async () => {
        const result = await openDesignStatus()
        publishAppleBridgeEvent("open_design", "open_design.status.checked", summarizeOpenDesignStatusEvent(result))
        return HttpServerResponse.jsonUnsafe(result)
      }),
    )

    const openDesignProxyHandler = (request: HttpServerRequest.HttpServerRequest) =>
      Effect.gen(function* () {
        const raw =
          request.method === "GET" || request.method === "HEAD" ? undefined : yield* Effect.orDie(request.text)
        return yield* Effect.promise(async () =>
          openDesignProxyResponse(request.url, request.method, request.headers, raw),
        )
      })

    yield* router.add("GET", "/experimental/open-design/proxy/*", openDesignProxyHandler)
    yield* router.add("POST", "/experimental/open-design/proxy/*", openDesignProxyHandler)
    yield* router.add("PUT", "/experimental/open-design/proxy/*", openDesignProxyHandler)
    yield* router.add("PATCH", "/experimental/open-design/proxy/*", openDesignProxyHandler)
    yield* router.add("DELETE", "/experimental/open-design/proxy/*", openDesignProxyHandler)
    yield* router.add("OPTIONS", "/experimental/open-design/proxy/*", openDesignProxyHandler)

    yield* router.add("GET", "/_next/*", openDesignProxyHandler)
    yield* router.add("GET", "/app-icon.png", openDesignProxyHandler)

    yield* router.add("GET", "/experimental/mac-view/status", () =>
      Effect.promise(async () => HttpServerResponse.jsonUnsafe(await macViewStatus())),
    )

    yield* router.add("GET", "/experimental/mac-view/settings", () =>
      Effect.promise(async () => HttpServerResponse.jsonUnsafe({ ok: true, settings: macViewSettings() })),
    )

    yield* router.add("POST", "/experimental/mac-view/settings", (request) =>
      Effect.gen(function* () {
        const raw = yield* Effect.orDie(request.text)
        let body: Partial<MacViewSettings>
        try {
          body = JSON.parse(raw || "{}") as Partial<MacViewSettings>
        } catch {
          return HttpServerResponse.text("Invalid JSON body", { status: 400 })
        }
        return yield* Effect.promise(async () => {
          const settings = writeMacViewSettings(body)
          const result = {
            ok: true,
            settings,
            restartRequired:
              body.transport === "webrtc" ||
              body.bitrate !== undefined ||
              body.width !== undefined ||
              body.fps !== undefined,
            note: "Settings are persisted for the OpenCode Mac View tab. The WebRTC publisher reads these values on the next stream restart; the UI reconnects immediately.",
          }
          publishAppleBridgeEvent("mac_view", "mac_view.settings.updated", {
            ok: true,
            settings,
            restartRequired: result.restartRequired,
          })
          return HttpServerResponse.jsonUnsafe(result)
        })
      }),
    )

    yield* router.add("GET", "/experimental/mac-view/snapshot", () =>
      Effect.promise(async () => {
        const feedURL = process.env.OPENCODE_MAC_VIEW_URL?.replace(/\/+$/, "")
        if (!feedURL) return HttpServerResponse.text("Mac View is not configured", { status: 404 })
        const response = await fetch(`${feedURL}/snapshot`).catch(() => undefined)
        if (!response?.ok) return HttpServerResponse.text("Mac View snapshot unavailable", { status: 502 })
        const bytes = new Uint8Array(await response.arrayBuffer())
        return HttpServerResponse.setHeader(
          HttpServerResponse.uint8Array(bytes, { contentType: response.headers.get("content-type") ?? "image/jpeg" }),
          "cache-control",
          "no-store",
        )
      }),
    )

    yield* router.add("GET", "/experimental/mac-view/sck/status", () =>
      Effect.promise(async () => macViewSCKStatusResponse()),
    )

    yield* router.add("GET", "/experimental/mac-view/stream", (request) =>
      Effect.promise(async () => macViewStreamResponse(request.url)),
    )

    yield* router.add("GET", "/experimental/mac-view/video", (request) =>
      Effect.promise(async () => macViewVideoResponse(request.url)),
    )

    const macViewWebRTCHandler = (request: HttpServerRequest.HttpServerRequest) =>
      Effect.gen(function* () {
        const raw =
          request.method === "GET" || request.method === "HEAD" ? undefined : yield* Effect.orDie(request.text)
        return yield* Effect.promise(async () =>
          macViewWebRTCResponse(request.url, request.method, request.headers, raw),
        )
      })

    yield* router.add("GET", "/experimental/mac-view/webrtc/*", macViewWebRTCHandler)
    yield* router.add("POST", "/experimental/mac-view/webrtc/*", macViewWebRTCHandler)
    yield* router.add("PATCH", "/experimental/mac-view/webrtc/*", macViewWebRTCHandler)
    yield* router.add("DELETE", "/experimental/mac-view/webrtc/*", macViewWebRTCHandler)
    yield* router.add("OPTIONS", "/experimental/mac-view/webrtc/*", macViewWebRTCHandler)

    yield* router.add("GET", "/experimental/browser/:sessionID/artifacts", (request) =>
      Effect.promise(async () => {
        const sessionID = decodeParam(request.url, /^\/experimental\/browser\/([^/]+)\/artifacts$/)
        if (!sessionID) return HttpServerResponse.text("Missing session ID", { status: 400 })
        const paths = sessionPaths(sessionID)
        return HttpServerResponse.jsonUnsafe({
          browserSessionID: paths.browserSessionID,
          artifactDir: paths.artifactDir,
          files: (await listArtifactFiles(paths.artifactDir)).map((file) => ({
            ...file,
            url: `/experimental/browser/${encodeURIComponent(sessionID)}/artifacts/${encodeURIComponent(file.name)}`,
          })),
        })
      }),
    )

    yield* router.add("GET", "/experimental/browser/:sessionID/artifacts/:name", (request) =>
      Effect.promise(async () => {
        const url = new URL(request.url, "http://localhost")
        const match = url.pathname.match(/^\/experimental\/browser\/([^/]+)\/artifacts\/([^/]+)$/)
        const sessionID = match?.[1] ? decodeURIComponent(match[1]) : ""
        const name = match?.[2] ? decodeURIComponent(match[2]) : ""
        if (!sessionID || !name) return HttpServerResponse.text("Missing artifact", { status: 400 })
        const file = resolveArtifactFile(sessionPaths(sessionID).artifactDir, name)
        if (!file) return HttpServerResponse.text("Invalid artifact", { status: 400 })
        const stat = await safeStatAsync(file)
        if (!stat?.isFile()) return HttpServerResponse.text("Artifact not found", { status: 404 })
        return HttpServerResponse.setHeader(
          HttpServerResponse.uint8Array(new Uint8Array(await readFileP(file)), { contentType: contentTypeForFile(name) }),
          "cache-control",
          "no-store",
        )
      }),
    )
  }),
).pipe(Layer.provide(authOnlyRouterLayer))

function decodeParam(rawURL: string, pattern: RegExp) {
  const url = new URL(rawURL, "http://localhost")
  const match = url.pathname.match(pattern)
  return match?.[1] ? decodeURIComponent(match[1]) : undefined
}

async function listArtifactFiles(
  dir: string,
  root = dir,
): Promise<Array<{ name: string; size: number; mtime: string; kind: string; contentType: string }>> {
  if (!(await safeStatAsync(dir))) return []
  let entries: import("node:fs").Dirent[]
  try {
    entries = await readdirP(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: Array<{ name: string; size: number; mtime: string; kind: string; contentType: string }> = []
  for (const entry of entries) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await listArtifactFiles(file, root)))
      continue
    }
    const stat = await safeStatAsync(file)
    if (!stat?.isFile()) continue
    const relative = path.relative(root, file)
    const contentType = contentTypeForFile(relative)
    out.push({
      name: relative,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      kind: fileKind(contentType),
      contentType,
    })
  }
  return out.sort((a, b) => b.mtime.localeCompare(a.mtime))
}

function resolveArtifactFile(artifactDir: string, name: string) {
  if (path.isAbsolute(name)) return undefined
  if (name.split(/[\\/]/).includes("..")) return undefined

  const root = path.resolve(artifactDir)
  const file = path.resolve(root, name)
  if (file !== root && !file.startsWith(root + path.sep)) return undefined
  return file
}

function contentTypeForFile(name: string) {
  const lower = name.toLowerCase()
  if (lower.endsWith(".png")) return "image/png"
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg"
  if (lower.endsWith(".webp")) return "image/webp"
  if (lower.endsWith(".gif")) return "image/gif"
  if (lower.endsWith(".svg")) return "image/svg+xml"
  if (lower.endsWith(".mp4")) return "video/mp4"
  if (lower.endsWith(".webm")) return "video/webm"
  if (lower.endsWith(".mov")) return "video/quicktime"
  if (lower.endsWith(".mp3")) return "audio/mpeg"
  if (lower.endsWith(".wav")) return "audio/wav"
  if (lower.endsWith(".pdf")) return "application/pdf"
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html"
  if (lower.endsWith(".json")) return "application/json"
  if (
    /\.(ts|tsx|js|jsx|mjs|cjs|css|scss|sass|py|rb|go|rs|java|c|cc|cpp|h|hpp|cs|php|swift|kt|kts|sh|bash|zsh|fish|sql|yaml|yml|toml|xml|vue|svelte)$/i.test(
      lower,
    )
  )
    return "text/plain"
  if (lower.endsWith(".md") || lower.endsWith(".txt") || lower.endsWith(".log")) return "text/plain"
  return "application/octet-stream"
}

function fileViewerRoots() {
  const explicit = process.env.OPENCODE_FILE_VIEW_ROOTS?.split(path.delimiter).filter(Boolean) ?? []
  const browserHome =
    process.env.OPENCODE_BROWSER_HOME ||
    path.join(process.env.HOME ?? "/home/dev", ".local", "share", "opencode-browser")
  return [...explicit, browserHome, process.env.OPENCODE_DEV_ROOT ?? "/home/dev/repos"]
    .map((root) => path.resolve(root))
    .filter((root, index, list) => list.indexOf(root) === index)
}

function fileViewerAllowed(file: string) {
  const resolved = path.resolve(file)
  return fileViewerRoots().some((root) => resolved === root || resolved.startsWith(root + path.sep))
}

async function safeStatAsync(file: string) {
  try {
    return await statP(file)
  } catch {
    return undefined
  }
}

function safeStat(file: string) {
  try {
    return statSync(file, { throwIfNoEntry: false })
  } catch {
    return undefined
  }
}

function fileBrowserDefaultPath() {
  const configured = process.env.OPENCODE_FILE_BROWSER_ROOT
  if (configured) return configured
  const opencode = "/home/dev/repos/opencode"
  if (existsSync(opencode)) return opencode
  return fileViewerRoots()[0] ?? process.cwd()
}

function parentDirectory(directory: string) {
  const parent = path.dirname(directory)
  if (parent === directory) return null
  return fileViewerAllowed(parent) ? parent : null
}

const PROJECT_METADATA_REL = path.join(".opencode", "design", "project.json")
const PROJECT_METADATA_MAX_BYTES = 256 * 1024

// Walk up from a path (within allowlisted roots) to find the nearest
// .opencode/design/project.json. Read-only; returns present:false gracefully.
async function projectsReferencingRoutine(routineId: string | null) {
  const id = String(routineId || "").trim()
  if (!id) return { ok: false, error: "routine id is required" }
  const reposRoot = process.env.OPENCODE_DEV_ROOT || "/home/dev/repos"
  if (!fileViewerAllowed(reposRoot)) return { ok: true, id, projects: [] }
  const projects: Array<{ repoRoot: string; name: string | null; metadataPath: string }> = []
  let dirs: import("node:fs").Dirent[]
  try {
    dirs = await readdirP(reposRoot, { withFileTypes: true })
  } catch {
    return { ok: true, id, projects: [] }
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    const candidate = path.join(reposRoot, dir.name, ".opencode", "design", "project.json")
    const stat = await safeStatAsync(candidate)
    if (!stat?.isFile() || stat.size > 256 * 1024) continue
    try {
      const metadata = JSON.parse(await readFileP(candidate, "utf8"))
      const routines = Array.isArray(metadata?.routines) ? metadata.routines : []
      if (routines.some((r: any) => (typeof r === "string" ? r : r?.id) === id)) {
        projects.push({ repoRoot: path.join(reposRoot, dir.name), name: typeof metadata?.name === "string" ? metadata.name : null, metadataPath: candidate })
      }
    } catch {
      // skip unreadable/invalid metadata
    }
  }
  return { ok: true, id, projects }
}

async function resolveProjectMetadata(requested: string | null) {
  const start = path.resolve(requested || fileBrowserDefaultPath())
  if (!fileViewerAllowed(start)) return { ok: false, error: "Path is outside allowlisted roots" }
  const startStat = await safeStatAsync(start)
  let dir = startStat?.isDirectory() ? start : path.dirname(start)
  const searched: string[] = []
  for (let i = 0; i < 12; i++) {
    if (!fileViewerAllowed(dir)) break
    const candidate = path.join(dir, PROJECT_METADATA_REL)
    searched.push(candidate)
    const stat = await safeStatAsync(candidate)
    if (stat?.isFile()) {
      if (stat.size > PROJECT_METADATA_MAX_BYTES)
        return { ok: true, present: false, repoRoot: dir, reason: "metadata file too large", metadataPath: candidate }
      try {
        const metadata = JSON.parse(await readFileP(candidate, "utf8"))
        return { ok: true, present: true, repoRoot: dir, metadataPath: candidate, metadata }
      } catch (error) {
        return { ok: true, present: false, repoRoot: dir, reason: `invalid json: ${(error as Error).message}`, metadataPath: candidate }
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return { ok: true, present: false, repoRoot: startStat?.isDirectory() ? start : path.dirname(start), searched }
}

function fileKind(contentType: string) {
  if (contentType.startsWith("image/")) return "image"
  if (contentType.startsWith("video/")) return "video"
  if (contentType.startsWith("audio/")) return "audio"
  if (contentType === "application/pdf") return "pdf"
  if (contentType === "text/html") return "html"
  if (contentType === "application/json") return "json"
  if (contentType.startsWith("text/")) return "text"
  return "file"
}

type LiveBrowserInput =
  | { action: "status" }
  | { action: "goto"; url?: string }
  | { action: "open"; url?: string }
  | { action: "back" }
  | { action: "forward" }
  | { action: "reload" }
  | { action: "click"; x?: number; y?: number; selector?: string }
  | { action: "fill"; selector?: string; text?: string }
  | { action: "type"; text?: string }
  | { action: "key"; key?: string }
  | { action: "scroll"; deltaX?: number; deltaY?: number }
  | { action: "inspect"; selector?: string; limit?: number }
  | { action: "accessibility"; limit?: number }
  | { action: "history" }
  | { action: "annotate"; selector?: string }

const liveBrowserDisplay = () => process.env.OPENCODE_LIVE_BROWSER_DISPLAY || ":99"
const liveBrowserStreamBoundary = "opencode-browser-frame"
const liveBrowserStreamDelay = () => {
  const requested = Number(process.env.OPENCODE_LIVE_BROWSER_FRAME_MS || 100)
  if (!Number.isFinite(requested)) return 100
  return Math.max(50, requested)
}
const liveBrowserHome = () =>
  path.resolve(
    process.env.OPENCODE_LIVE_BROWSER_HOME ||
      path.join(process.env.HOME ?? "/home/dev", ".local", "share", "opencode-live-browser"),
  )
const liveBrowserProfile = () => path.join(liveBrowserHome(), "profile")
const liveBrowserArtifacts = () => path.join(liveBrowserHome(), "artifacts")
const liveBrowserDebugPort = () => Number(process.env.OPENCODE_LIVE_BROWSER_DEBUG_PORT || 9224)
const liveBrowserNoVNCURL = () =>
  (process.env.OPENCODE_LIVE_BROWSER_NOVNC_URL || "http://127.0.0.1:6080").replace(/\/+$/, "")

const optimizedBrowserViewerURL = () =>
  (process.env.OPENCODE_BROWSER_OPTIMIZED_VIEWER_URL || "http://127.0.0.1:7458").replace(/\/+$/, "")

async function optimizedBrowserViewerHealthy() {
  try {
    const response = await fetch(`${optimizedBrowserViewerURL()}/api/state`, {
      signal: AbortSignal.timeout(1200),
    })
    if (!response.ok) return false
    const body = (await response.json().catch(() => null)) as { ok?: boolean } | null
    return body?.ok === true
  } catch {
    return false
  }
}

async function optimizedBrowserViewerProxyResponse(input: {
  method: string
  target: URL
  body?: string
  contentType?: string
}) {
  const response = await fetch(input.target, {
    method: input.method,
    headers: input.body ? { "content-type": input.contentType || "application/json" } : undefined,
    body: input.body,
  })
  const contentType = response.headers.get("content-type") ?? "application/octet-stream"
  if (!response.ok) {
    return HttpServerResponse.text(await response.text(), { status: response.status, contentType })
  }
  return HttpServerResponse.setHeader(
    HttpServerResponse.uint8Array(new Uint8Array(await response.arrayBuffer()), { contentType }),
    "cache-control",
    "no-store",
  )
}
const liveBrowserExposureEnabled = () => process.env.OPENCODE_LIVE_BROWSER_EXPOSE !== "0"
const liveBrowserStrictAccessRequired = () => process.env.OPENCODE_LIVE_BROWSER_REQUIRE_ACCESS === "1"
const liveBrowserViewport = () => {
  const raw = process.env.OPENCODE_LIVE_BROWSER_VIEWPORT || "1920x1400"
  const match = raw.match(/^(\d{3,5})x(\d{3,5})$/i)
  if (!match) return { width: 1920, height: 1400 }
  return {
    width: Math.min(7680, Math.max(640, Number(match[1]))),
    height: Math.min(4320, Math.max(480, Number(match[2]))),
  }
}

type LiveBrowserAccess =
  | {
      ok: true
      mode: "cloudflare-access" | "live-public-warning"
      email: string | null
      audience?: string
      teamDomain?: string
      warnings?: string[]
    }
  | {
      ok: false
      mode: "disabled" | "missing-cloudflare-config" | "missing-cloudflare-token" | "invalid-cloudflare-token"
      error: string
      requiredAccessBoundary: string
      cloudflareAccess: {
        configured: boolean
        audienceConfigured: boolean
        teamDomainConfigured: boolean
        allowedEmailsConfigured: boolean
      }
    }

type LiveBrowserBlockedMode = Extract<LiveBrowserAccess, { ok: false }>["mode"]

let liveBrowserCloudflareJWKS:
  | {
      url: string
      jwks: ReturnType<typeof createRemoteJWKSet>
    }
  | undefined

function liveBrowserCloudflareAccessConfig() {
  const audience = process.env.OPENCODE_CLOUDFLARE_ACCESS_AUD?.trim()
  const rawTeamDomain = process.env.OPENCODE_CLOUDFLARE_ACCESS_TEAM_DOMAIN?.trim()
  const teamDomain = rawTeamDomain
    ? rawTeamDomain.startsWith("http")
      ? rawTeamDomain.replace(/\/+$/, "")
      : `https://${rawTeamDomain.replace(/\/+$/, "")}`
    : undefined
  const allowedEmails = (process.env.OPENCODE_CLOUDFLARE_ACCESS_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
  return {
    audience,
    teamDomain,
    allowedEmails,
    configured: Boolean(audience && teamDomain),
  }
}

function liveBrowserAccessConfigSummary() {
  const config = liveBrowserCloudflareAccessConfig()
  return {
    configured: config.configured,
    audienceConfigured: Boolean(config.audience),
    teamDomainConfigured: Boolean(config.teamDomain),
    allowedEmailsConfigured: config.allowedEmails.length > 0,
  }
}

function liveBrowserGateStatus() {
  return {
    enabled: liveBrowserExposureEnabled(),
    mode: liveBrowserExposureEnabled()
      ? liveBrowserStrictAccessRequired()
        ? "cloudflare-access-required"
        : "live-public-warning"
      : "disabled",
    requiredAccessBoundary: "Cloudflare Access GitHub login for code.hustletogether.com",
    cloudflareAccess: liveBrowserAccessConfigSummary(),
    profilePolicy: liveBrowserProfilePolicy(),
    routes: {
      status: "/experimental/browser/live/status",
      profileStatus: "/experimental/browser/profile/status",
      stream: "/experimental/browser/live/stream",
      snapshot: "/experimental/browser/live/snapshot",
      novnc: "/experimental/browser/novnc/opencode-lite.html?path=websockify",
    },
  }
}

function liveBrowserProfilePolicy() {
  const cloudflareAccess = liveBrowserAccessConfigSummary()
  const accessBoundaryReady = liveBrowserExposureEnabled() && cloudflareAccess.configured
  const extensionRequested = process.env.OPENCODE_LIVE_BROWSER_EXTENSIONS === "1"
  const lastPassRequested = process.env.OPENCODE_LIVE_BROWSER_LASTPASS === "1"
  const persistentAuthRequested =
    process.env.OPENCODE_LIVE_BROWSER_PERSISTENT_AUTH === "1" ||
    process.env.OPENCODE_BROWSER_USE_PERSISTENT_PROFILE === "1"
  const persistentAuthReady = accessBoundaryReady || (liveBrowserExposureEnabled() && persistentAuthRequested)
  const profileRoot = liveBrowserProfile()
  const status = persistentAuthReady
    ? accessBoundaryReady
      ? "ready_after_manual_profile_setup"
      : "persistent_profile_enabled_by_explicit_live_override"
    : accessBoundaryReady
      ? "safe_default_no_persistent_auth"
      : liveBrowserExposureEnabled()
        ? "live_exposed_profile_features_disabled"
        : "blocked_access_boundary"

  return {
    ok: true,
    status,
    requiredAccessBoundary: "Cloudflare Access GitHub login for code.hustletogether.com",
    accessBoundaryReady,
    cloudflareAccess,
    profileRoot,
    profileStorage: {
      type: "ct100-local-chrome-user-data-dir",
      persistentOnDisk: true,
      containsSecrets: "unknown_until_user_configures_profile",
      exposedToBrowserUI: persistentAuthReady,
    },
    persistentAuth: {
      requested: persistentAuthRequested,
      enabled: persistentAuthReady && persistentAuthRequested,
      status: persistentAuthReady
        ? accessBoundaryReady
          ? "manual_profile_setup_required"
          : "enabled_by_explicit_live_override"
        : liveBrowserExposureEnabled()
          ? "disabled_until_access_boundary"
          : "blocked_until_browser_exposed",
    },
    extensions: {
      requested: extensionRequested,
      enabled: accessBoundaryReady && extensionRequested,
      installMode: accessBoundaryReady && extensionRequested ? "manual_chrome_profile" : "disabled",
      status: accessBoundaryReady
        ? extensionRequested
          ? "manual_install_required"
          : "disabled_by_policy"
        : liveBrowserExposureEnabled()
          ? "disabled_until_access_boundary"
          : "blocked_until_browser_exposed",
    },
    lastPass: {
      requested: lastPassRequested,
      enabled: accessBoundaryReady && extensionRequested && lastPassRequested,
      status: accessBoundaryReady
        ? extensionRequested && lastPassRequested
          ? "manual_install_and_login_required"
          : "disabled_by_policy"
        : liveBrowserExposureEnabled()
          ? "disabled_until_access_boundary"
          : "blocked_until_browser_exposed",
    },
    surfaces: [
      {
        id: "browser",
        label: "Browser",
        tab: "Browser",
        purpose:
          "Unified interactive Chromium surface for hosted routes, local project URLs, public websites, Open Design, and model browser tools.",
        usesChromeProfile: true,
        toolControlled: true,
        aliases: ["Preview", "Agent Chrome", "Project Preview"],
        safeWhilePublic: !persistentAuthRequested && !extensionRequested && !lastPassRequested,
        exposed: liveBrowserExposureEnabled(),
      },
      {
        id: "browser_use",
        label: "Browser Use",
        tab: "Browser",
        purpose: "Browser Use OSS bridge for model-driven browser tasks.",
        usesChromeProfile: persistentAuthRequested,
        toolControlled: true,
        safeWhilePublic: !persistentAuthRequested,
      },
      {
        id: "open_design",
        label: "Open Design",
        tab: "Open Design",
        purpose: "Interactive Open Design UI and daemon-backed tool surface.",
        usesChromeProfile: false,
        toolControlled: true,
        safeWhilePublic: false,
      },
    ],
  }
}

function liveBrowserAccessBlocked(mode: LiveBrowserBlockedMode, error: string): LiveBrowserAccess {
  return {
    ok: false,
    mode,
    error,
    requiredAccessBoundary: "Cloudflare Access GitHub login for code.hustletogether.com",
    cloudflareAccess: liveBrowserAccessConfigSummary(),
  }
}

function liveBrowserAccessToken(request: { headers: Record<string, string | undefined> }) {
  const headerToken = request.headers["cf-access-jwt-assertion"]
  if (headerToken) return headerToken
  const cookie = request.headers.cookie ?? ""
  return cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("CF_Authorization="))
    ?.slice("CF_Authorization=".length)
}

async function liveBrowserExposureAccess(request: {
  headers: Record<string, string | undefined>
}): Promise<LiveBrowserAccess> {
  if (!liveBrowserExposureEnabled()) {
    return liveBrowserAccessBlocked(
      "disabled",
      "Live browser viewing and control are disabled because OPENCODE_LIVE_BROWSER_EXPOSE=0.",
    )
  }

  const config = liveBrowserCloudflareAccessConfig()
  if (!config.configured || !config.audience || !config.teamDomain) {
    if (liveBrowserStrictAccessRequired()) {
      return liveBrowserAccessBlocked(
        "missing-cloudflare-config",
        "OPENCODE_LIVE_BROWSER_REQUIRE_ACCESS=1, but Cloudflare Access AUD/team domain env vars are missing.",
      )
    }
    return {
      ok: true,
      mode: "live-public-warning",
      email: request.headers["cf-access-authenticated-user-email"]?.toLowerCase() ?? null,
      warnings: [
        "Browser is exposed on the live OpenCode route because Alfonso explicitly requested it.",
        "Cloudflare Access env is not configured in the running service, so persistent auth, extensions, and LastPass stay disabled by profile policy.",
      ],
    }
  }

  const token = liveBrowserAccessToken(request)
  if (!token) {
    if (liveBrowserStrictAccessRequired()) {
      return liveBrowserAccessBlocked("missing-cloudflare-token", "Missing Cloudflare Access JWT assertion.")
    }
    return {
      ok: true,
      mode: "live-public-warning",
      email: request.headers["cf-access-authenticated-user-email"]?.toLowerCase() ?? null,
      audience: config.audience,
      teamDomain: config.teamDomain,
      warnings: [
        "Cloudflare Access config exists, but this request did not include a verified Access JWT.",
        "Browser remains available by live-only override; persistent profile features remain disabled unless separately enabled.",
      ],
    }
  }

  try {
    const certsURL = `${config.teamDomain}/cdn-cgi/access/certs`
    if (!liveBrowserCloudflareJWKS || liveBrowserCloudflareJWKS.url !== certsURL) {
      liveBrowserCloudflareJWKS = {
        url: certsURL,
        jwks: createRemoteJWKSet(new URL(certsURL)),
      }
    }
    const verified = await jwtVerify(token, liveBrowserCloudflareJWKS.jwks, {
      audience: config.audience,
      issuer: config.teamDomain,
    })
    const email =
      typeof verified.payload.email === "string"
        ? verified.payload.email.toLowerCase()
        : typeof request.headers["cf-access-authenticated-user-email"] === "string"
          ? request.headers["cf-access-authenticated-user-email"].toLowerCase()
          : null
    if (config.allowedEmails.length > 0 && (!email || !config.allowedEmails.includes(email))) {
      return liveBrowserAccessBlocked(
        "invalid-cloudflare-token",
        "Cloudflare Access user is not allowlisted for Browser.",
      )
    }
    return {
      ok: true,
      mode: "cloudflare-access",
      email,
      audience: config.audience,
      teamDomain: config.teamDomain,
    }
  } catch (error) {
    return liveBrowserAccessBlocked(
      "invalid-cloudflare-token",
      error instanceof Error ? error.message : "Invalid Cloudflare Access JWT assertion.",
    )
  }
}

function liveBrowserExposureBlockedResponse(format: "json" | "text", access?: LiveBrowserAccess) {
  const message =
    access?.ok === false
      ? access.error
      : "Live browser viewing and control are disabled until code.hustletogether.com is protected by the approved access boundary."
  if (format === "json") {
    return HttpServerResponse.jsonUnsafe(
      {
        ok: false,
        exposureBlocked: true,
        error: message,
        requiredAccessBoundary:
          access?.ok === false
            ? access.requiredAccessBoundary
            : "Cloudflare Access GitHub login for code.hustletogether.com",
        mode: access?.ok === false ? access.mode : "disabled",
        cloudflareAccess: access?.ok === false ? access.cloudflareAccess : liveBrowserAccessConfigSummary(),
        profilePolicy: liveBrowserProfilePolicy(),
      },
      { status: 403 },
    )
  }
  return HttpServerResponse.text(message, { status: 403 })
}

function liveBrowserNoVNCProxyURL(requestURL: string) {
  const url = new URL(requestURL, "http://localhost")
  const pathPart = url.pathname.replace(/^\/experimental\/browser\/novnc\/?/, "") || "vnc.html"
  const target = new URL(liveBrowserNoVNCURL() + "/" + pathPart)
  target.search = url.search
  return target
}

function liveBrowserNoVNCLiteResponse(requestURL: string) {
  const url = new URL(requestURL, "http://localhost")
  const params = new URLSearchParams(url.search)
  const pathParam = params.get("path") || "websockify"
  const pathValue = pathParam.startsWith("/") ? pathParam.slice(1) : pathParam
  const websocketPath = `/experimental/browser/novnc/${pathValue}`
  const qualityLevel = boundedInteger(params.get("quality") ?? process.env.OPENCODE_BROWSER_NOVNC_QUALITY, 4, 0, 9)
  const compressionLevel = boundedInteger(
    params.get("compression") ?? process.env.OPENCODE_BROWSER_NOVNC_COMPRESSION,
    0,
    0,
    9,
  )
  const scaleViewport = params.get("scaleViewport") !== "false"
  const resizeSession = params.get("resizeSession") === "true"
  const clipViewport = params.get("clipViewport") === "true"
  const dragViewport = params.get("dragViewport") === "true"
  const showDotCursor = params.get("showDotCursor") !== "false"
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>OpenCode Browser</title>
    <style>
      :root { color-scheme: dark light; background: #050505; }
      html, body, #screen { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #050505; }
      #screen { display: flex; align-items: stretch; justify-content: stretch; }
      #screen canvas { background: #fff; }
      body[data-scale="true"] #screen canvas { width: 100% !important; height: 100% !important; object-fit: contain; }
      body[data-scale="false"] #screen { align-items: flex-start; justify-content: flex-start; overflow: hidden; }
      #status {
        position: fixed;
        left: 12px;
        bottom: 10px;
        z-index: 2;
        border-radius: 999px;
        background: rgba(0, 0, 0, 0.64);
        color: rgba(255, 255, 255, 0.88);
        font: 12px/1.4 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        padding: 5px 9px;
        pointer-events: none;
        opacity: 0.82;
        transition: opacity 160ms ease;
      }
      #status[data-connected="true"] { opacity: 0; }
      body:hover #status { opacity: 0.82; }
    </style>
  </head>
  <body data-scale="${scaleViewport ? "true" : "false"}">
    <div id="screen"></div>
    <div id="status">connecting</div>
    <script type="module">
      import RFB from "/experimental/browser/novnc/core/rfb.js";

      const status = document.getElementById("status");
      const target = document.getElementById("screen");
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = protocol + "//" + window.location.host + "${websocketPath}";
      const rfb = new RFB(target, url, {
        shared: true,
        repeaterID: "",
      });

      rfb.viewOnly = false;
      rfb.scaleViewport = ${JSON.stringify(scaleViewport)};
      rfb.resizeSession = ${JSON.stringify(resizeSession)};
      rfb.focusOnClick = true;
      rfb.showDotCursor = ${JSON.stringify(showDotCursor)};
      rfb.clipViewport = ${JSON.stringify(clipViewport)};
      rfb.dragViewport = ${JSON.stringify(dragViewport)};
      rfb.qualityLevel = ${qualityLevel};
      rfb.compressionLevel = ${compressionLevel};

      const publish = (state, detail = {}) => {
        window.parent?.postMessage({ type: "opencode-browser-vnc", state, detail }, window.location.origin);
      };

      rfb.addEventListener("connect", () => {
        status.textContent = "interactive";
        status.dataset.connected = "true";
        publish("connected");
        target.focus?.();
      });
      rfb.addEventListener("disconnect", (event) => {
        const state = event.detail?.clean ? "disconnected" : "error";
        status.textContent = event.detail?.clean ? "disconnected" : "connection lost";
        status.dataset.connected = "false";
        publish(state, event.detail ?? {});
      });
      rfb.addEventListener("credentialsrequired", () => {
        status.textContent = "credentials required";
        status.dataset.connected = "false";
        publish("credentialsrequired");
      });

      window.addEventListener("beforeunload", () => rfb.disconnect());
    </script>
  </body>
</html>`
  return HttpServerResponse.setHeader(
    HttpServerResponse.text(html, { contentType: "text/html" }),
    "cache-control",
    "no-store",
  )
}

function boundedInteger(value: string | null | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

async function liveBrowserNoVNCProxyResponse(target: URL) {
  const response = await fetch(target)
  const contentType = response.headers.get("content-type") ?? "application/octet-stream"
  if (!response.ok) {
    return HttpServerResponse.text(await response.text(), { status: response.status, contentType })
  }
  return HttpServerResponse.setHeader(
    HttpServerResponse.uint8Array(new Uint8Array(await response.arrayBuffer()), { contentType }),
    "cache-control",
    "no-store",
  )
}

async function liveBrowserStatus(access?: Extract<LiveBrowserAccess, { ok: true }>) {
  const browser = await ensureLiveBrowser().catch((error: unknown) => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }))
  const cdp = await currentLiveBrowserURL().catch(() => undefined)
  const noVNCMode = process.env.OPENCODE_BROWSER_NOVNC_MODE || "fast"
  const noVNCModes = {
    fast: { qualityLevel: 4, compressionLevel: 0, scaleViewport: true, resizeSession: false },
    balanced: { qualityLevel: 6, compressionLevel: 1, scaleViewport: true, resizeSession: false },
    sharp: { qualityLevel: 8, compressionLevel: 2, scaleViewport: true, resizeSession: false },
    mobile: {
      qualityLevel: 4,
      compressionLevel: 0,
      scaleViewport: false,
      resizeSession: false,
      clipViewport: true,
      dragViewport: true,
    },
  } as const
  const defaultNoVNC = noVNCModes[noVNCMode as keyof typeof noVNCModes] ?? noVNCModes.fast
  const defaultNoVNCParams = new URLSearchParams({
    path: "websockify",
    quality: String(defaultNoVNC.qualityLevel),
    compression: String(defaultNoVNC.compressionLevel),
    scaleViewport: String(defaultNoVNC.scaleViewport),
    resizeSession: String(defaultNoVNC.resizeSession),
    clipViewport: String("clipViewport" in defaultNoVNC ? defaultNoVNC.clipViewport : false),
    dragViewport: String("dragViewport" in defaultNoVNC ? defaultNoVNC.dragViewport : false),
  })
  return {
    ok: browser.ok,
    mode: "ct100-cdp-chrome",
    primaryTransport: "cdp",
    fallbackTransport: "vnc",
    display: liveBrowserDisplay(),
    viewport: liveBrowserViewport(),
    profile: liveBrowserProfile(),
    profilePolicy: liveBrowserProfilePolicy(),
    debugPort: liveBrowserDebugPort(),
    currentURL: cdp?.url,
    title: cdp?.title,
    error: "error" in browser ? browser.error : undefined,
    screenshotURL: "/experimental/browser/live/snapshot",
    streamURL: "/experimental/browser/live/stream",
    proxiedLiveURL: `/experimental/browser/novnc/opencode-lite.html?${defaultNoVNCParams.toString()}`,
    optimizedViewer: (await optimizedBrowserViewerHealthy())
      ? {
          ok: true,
          proxiedURL: `/experimental/browser/optimized/?vnc=${encodeURIComponent(
            `/experimental/browser/novnc/opencode-lite.html?${defaultNoVNCParams.toString()}`,
          )}`,
          apiBase: "/experimental/browser/optimized/api",
        }
      : { ok: false },
    noVNC: {
      viewer: "opencode-lite",
      defaultMode: noVNCMode in noVNCModes ? noVNCMode : "fast",
      modes: noVNCModes,
    },
    actions: [
      "open",
      "goto",
      "back",
      "forward",
      "reload",
      "click",
      "fill",
      "type",
      "key",
      "scroll",
      "inspect",
      "accessibility",
      "history",
      "annotate",
      "screenshot",
      "selector",
    ],
    access: access
      ? {
          mode: access.mode,
          email: access.email,
          teamDomain: access.teamDomain,
          warnings: access.warnings,
        }
      : undefined,
    browserUse: await browserUseBridgeStatus().catch((error: unknown) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })),
  }
}

type EnsureLiveBrowserResult = { ok: true; pid?: number } | { ok: false; error: string }
let liveBrowserEnsureInFlight: Promise<EnsureLiveBrowserResult> | undefined

// Launch the live Chrome in dev's OWN user-manager cgroup slice (out of
// opencode.service's cgroup) with its own memory cap, so Chrome memory growth
// can never push the shared cgroup into MemoryHigh throttling — the root cause of
// the recurring event-loop-freeze wedge. Falls back to a direct detached spawn
// (previous behavior, in opencode's cgroup) if systemd-run --user is unavailable,
// so the browser never fails to launch.
async function spawnLiveChrome(chrome: string, args: string[], display: string): Promise<number | undefined> {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined
  if (uid !== undefined) {
    const launched = await new Promise<boolean>((resolve) => {
      try {
        const runner = spawn(
          "systemd-run",
          [
            "--user",
            "--collect",
            "-p",
            "MemoryHigh=4G",
            "-p",
            "MemoryMax=6G",
            `--setenv=DISPLAY=${display}`,
            "--",
            chrome,
            ...args,
          ],
          { stdio: "ignore", env: { ...process.env, DISPLAY: display, XDG_RUNTIME_DIR: `/run/user/${uid}` } },
        )
        runner.on("error", () => resolve(false))
        runner.on("exit", (code) => resolve(code === 0))
      } catch {
        resolve(false)
      }
    })
    if (launched) return undefined
  }
  const child = spawn(chrome, args, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, DISPLAY: display },
  })
  child.unref()
  return child.pid
}

async function ensureLiveBrowser(): Promise<EnsureLiveBrowserResult> {
  // Share one in-flight ensure across concurrent callers so two simultaneous
  // browser ops can't both spawn Chrome (the pre-existing double-spawn race).
  if (liveBrowserEnsureInFlight) return liveBrowserEnsureInFlight
  const run = (async (): Promise<EnsureLiveBrowserResult> => {
    await mkdirP(liveBrowserProfile(), { recursive: true })
    await mkdirP(liveBrowserArtifacts(), { recursive: true })

    const existing = await execText("pgrep", ["-f", `${liveBrowserProfile()}`]).catch(() => "")
    const pid = existing
      .split(/\s+/)
      .map((value) => Number(value))
      .find((value) => Number.isFinite(value) && value > 0)
    if (pid) {
      await fitLiveBrowserWindow().catch(() => undefined)
      return { ok: true, pid }
    }

    const chrome = process.env.OPENCODE_LIVE_BROWSER_BIN || "google-chrome"
    const viewport = liveBrowserViewport()
    const spawnedPid = await spawnLiveChrome(
      chrome,
      [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${liveBrowserProfile()}`,
        "--remote-debugging-address=127.0.0.1",
        `--remote-debugging-port=${liveBrowserDebugPort()}`,
        `--window-size=${viewport.width},${viewport.height}`,
        "--start-maximized",
        "about:blank",
      ],
      liveBrowserDisplay(),
    )
    await delay(1200)
    await fitLiveBrowserWindow().catch(() => undefined)
    return { ok: true, pid: spawnedPid }
  })()
  liveBrowserEnsureInFlight = run
  void run.finally(() => {
    if (liveBrowserEnsureInFlight === run) liveBrowserEnsureInFlight = undefined
  })
  return run
}

async function runLiveBrowserInput(input: LiveBrowserInput) {
  await ensureLiveBrowser()
  switch (input.action) {
    case "status":
      return await liveBrowserStatus()
    case "goto":
    case "open": {
      const url = normalizeBrowserURL(input.url)
      if (!url) return { ok: false, error: "Missing URL" }
      await cdpCommand("Page.navigate", { url })
      await delay(900)
      return { ok: true, currentURL: url }
    }
    case "back":
      await cdpEvaluate("history.back()")
      await delay(400)
      return { ok: true }
    case "forward":
      await cdpEvaluate("history.forward()")
      await delay(400)
      return { ok: true }
    case "reload":
      await cdpCommand("Page.reload", { ignoreCache: false })
      await delay(600)
      return { ok: true }
    case "click": {
      if (input.selector?.trim()) return await clickLiveBrowserSelector(input.selector.trim())
      if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) {
        return { ok: false, error: "Missing coordinates or selector" }
      }
      const x = Math.max(0, Math.round(input.x ?? 0))
      const y = Math.max(0, Math.round(input.y ?? 0))
      await dispatchLiveBrowserClick(x, y)
      return { ok: true, x, y }
    }
    case "fill": {
      if (!input.selector?.trim()) return { ok: false, error: "Missing selector" }
      const result = await fillLiveBrowserSelector(input.selector.trim(), input.text ?? "")
      return { ok: true, selector: input.selector.trim(), result }
    }
    case "type": {
      if (!input.text) return { ok: false, error: "Missing text" }
      await cdpCommand("Input.insertText", { text: input.text })
      return { ok: true }
    }
    case "key": {
      if (!input.key) return { ok: false, error: "Missing key" }
      await dispatchCDPKey(input.key)
      return { ok: true }
    }
    case "scroll": {
      const deltaX = input.deltaX ?? 0
      const deltaY = input.deltaY ?? 0
      await cdpCommand("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: 720,
        y: 500,
        deltaX,
        deltaY,
      })
      return { ok: true, deltaX, deltaY }
    }
    case "inspect":
      return { ok: true, ...(await inspectLiveBrowserDOM(input.selector, input.limit)) }
    case "accessibility":
      return { ok: true, ...(await inspectLiveBrowserAccessibility(input.limit)) }
    case "history":
      return { ok: true, ...(await liveBrowserHistoryState()) }
    case "annotate": {
      if (!input.selector?.trim()) return { ok: false, error: "Missing selector" }
      return await highlightLiveBrowserSelector(input.selector.trim())
    }
    default:
      return { ok: false, error: `Unknown action: ${String((input as { action?: unknown }).action ?? "")}` }
  }
}

function liveBrowserStream() {
  return Stream.fromAsyncIterable(
    (async function* () {
      await ensureLiveBrowser()
      while (true) {
        const image = await captureLiveBrowserImage({ transient: true })
        yield multipartBrowserFrame(image)
        await delay(liveBrowserStreamDelay())
      }
    })(),
    (error) => error,
  )
}

function multipartBrowserFrame(image: Buffer) {
  const header = new TextEncoder().encode(
    [
      `--${liveBrowserStreamBoundary}`,
      "content-type: image/png",
      `content-length: ${image.length}`,
      "cache-control: no-store",
      "",
      "",
    ].join("\r\n"),
  )
  const footer = new TextEncoder().encode("\r\n")
  const frame = new Uint8Array(header.length + image.length + footer.length)
  frame.set(header, 0)
  frame.set(image, header.length)
  frame.set(footer, header.length + image.length)
  return frame
}

async function captureLiveBrowserImage(_options: { transient?: boolean } = {}) {
  await ensureLiveBrowser()
  const result = (await cdpCommand("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  })) as { data?: string }
  if (!result.data) throw new Error("CDP screenshot returned no data")
  return Buffer.from(result.data, "base64")
}

async function saveLiveBrowserScreenshot(
  sessionID: string,
  input: { annotationDataURL?: string; note?: string; selector?: string },
) {
  await ensureLiveBrowser()
  const paths = sessionPaths(sessionID)
  await mkdirP(paths.artifactDir, { recursive: true })
  const stamped = new Date().toISOString().replace(/[:.]/g, "-")
  const name = input.annotationDataURL ? `browser-annotation-${stamped}.png` : `browser-screenshot-${stamped}.png`
  const file = path.join(paths.artifactDir, name)

  if (input.annotationDataURL?.startsWith("data:image/")) {
    const base64 = input.annotationDataURL.split(",", 2)[1]
    if (!base64) throw new Error("Invalid annotation data URL")
    await writeFileP(file, Buffer.from(base64, "base64"))
  } else {
    const image = await captureLiveBrowserImage()
    await writeFileP(file, image)
  }

  const meta = {
    createdAt: new Date().toISOString(),
    kind: input.annotationDataURL ? "browser-annotation" : "browser-screenshot",
    note: input.note ?? null,
    selector: input.selector ?? null,
    source: await currentLiveBrowserURL().catch(() => null),
    image: name,
  }
  await writeFileP(path.join(paths.artifactDir, `${name}.json`), JSON.stringify(meta, null, 2))

  return {
    ok: true,
    name,
    path: file,
    url: `/experimental/browser/${encodeURIComponent(sessionID)}/artifacts/${encodeURIComponent(name)}`,
    meta,
  }
}

async function highlightLiveBrowserSelector(selector: string) {
  await ensureLiveBrowser()
  const expression = `(() => {
    const previous = document.querySelectorAll('[data-opencode-selector-highlight="true"]');
    for (const el of previous) {
      el.style.outline = el.dataset.opencodePreviousOutline || '';
      el.style.boxShadow = el.dataset.opencodePreviousBoxShadow || '';
      delete el.dataset.opencodeSelectorHighlight;
      delete el.dataset.opencodePreviousOutline;
      delete el.dataset.opencodePreviousBoxShadow;
    }
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { found: false };
    el.dataset.opencodeSelectorHighlight = 'true';
    el.dataset.opencodePreviousOutline = el.style.outline || '';
    el.dataset.opencodePreviousBoxShadow = el.style.boxShadow || '';
    el.style.outline = '3px solid #f97316';
    el.style.boxShadow = '0 0 0 6px rgba(249, 115, 22, 0.25)';
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = el.getBoundingClientRect();
    return {
      found: true,
      tag: el.tagName,
      text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('alt') || '').slice(0, 240),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  })()`
  const result = await cdpEvaluate(expression)
  const data = result && typeof result === "object" ? (result as Record<string, unknown>) : {}
  return { ok: true, selector, ...data, result }
}

async function dispatchLiveBrowserClick(x: number, y: number) {
  await cdpCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" })
  await cdpCommand("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 })
  await cdpCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 })
}

async function clickLiveBrowserSelector(selector: string) {
  await ensureLiveBrowser()
  const expression = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { found: false };
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = el.getBoundingClientRect();
    return {
      found: true,
      tag: el.tagName,
      text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('alt') || '').slice(0, 240),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  })()`
  const result = await cdpEvaluate(expression)
  const data = result && typeof result === "object" ? (result as Record<string, unknown>) : {}
  const rect = data.rect && typeof data.rect === "object" ? (data.rect as Record<string, unknown>) : undefined
  if (data.found !== true || !rect) return { ok: false, selector, found: false }
  const x = Math.max(0, Math.round(Number(rect.x ?? 0) + Number(rect.width ?? 0) / 2))
  const y = Math.max(0, Math.round(Number(rect.y ?? 0) + Number(rect.height ?? 0) / 2))
  await dispatchLiveBrowserClick(x, y)
  return { ok: true, selector, x, y, ...data, result }
}

async function fillLiveBrowserSelector(selector: string, text: string) {
  await ensureLiveBrowser()
  const expression = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { found: false };
    const value = ${JSON.stringify(text)};
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    if (typeof el.focus === 'function') el.focus();
    if ('value' in el) {
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      if (descriptor?.set) descriptor.set.call(el, value);
      else el.value = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      const rect = el.getBoundingClientRect();
      return { found: true, tag: el.tagName, valueLength: value.length, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
    }
    el.textContent = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    const rect = el.getBoundingClientRect();
    return { found: true, tag: el.tagName, textLength: value.length, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
  })()`
  return await cdpEvaluate(expression)
}

async function inspectLiveBrowserDOM(selector?: string, limitInput?: number) {
  await ensureLiveBrowser()
  const limit = Math.max(1, Math.min(200, Math.round(limitInput ?? 80)))
  const expression = `(() => {
    const rootSelector = ${JSON.stringify(selector?.trim() || "")};
    const root = rootSelector ? document.querySelector(rootSelector) : document.body;
    const makeSelector = (el) => {
      if (!el || !el.tagName) return '';
      if (el.id) return '#' + CSS.escape(el.id);
      const parts = [];
      let node = el;
      while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 4) {
        let part = node.tagName.toLowerCase();
        if (node.classList?.length) part += '.' + Array.from(node.classList).slice(0, 2).map((x) => CSS.escape(x)).join('.');
        const parent = node.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((x) => x.tagName === node.tagName);
          if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
        }
        parts.unshift(part);
        node = parent;
      }
      return parts.join(' > ');
    };
    if (!root) return { found: false, selector: rootSelector || null, url: location.href, title: document.title, elements: [] };
    const query = [
      'a[href]',
      'button',
      'input',
      'textarea',
      'select',
      '[role]',
      '[contenteditable="true"]',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',');
    const elements = Array.from(root.querySelectorAll(query)).slice(0, ${limit}).map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        selector: makeSelector(el),
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role'),
        type: el.getAttribute('type'),
        name: el.getAttribute('name'),
        label: (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.value || '').trim().slice(0, 160),
        href: el.getAttribute('href'),
        visible: rect.width > 0 && rect.height > 0,
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      };
    });
    return {
      found: true,
      selector: rootSelector || null,
      url: location.href,
      title: document.title,
      textPreview: (root.innerText || document.body?.innerText || '').trim().slice(0, 1200),
      elements,
    };
  })()`
  return await cdpEvaluate(expression)
}

async function inspectLiveBrowserAccessibility(limitInput?: number) {
  await ensureLiveBrowser()
  const limit = Math.max(1, Math.min(300, Math.round(limitInput ?? 120)))
  const body = (await cdpCommand("Accessibility.getFullAXTree")) as {
    nodes?: Array<{
      role?: { value?: string }
      name?: { value?: string }
      value?: { value?: string }
      ignored?: boolean
      childIds?: string[]
    }>
  }
  const nodes = (body.nodes ?? [])
    .filter((node) => !node.ignored)
    .slice(0, limit)
    .map((node) => ({
      role: node.role?.value ?? "",
      name: node.name?.value ?? "",
      value: node.value?.value ?? "",
      childCount: node.childIds?.length ?? 0,
    }))
  return { url: (await currentLiveBrowserURL()).url, nodes }
}

async function liveBrowserHistoryState() {
  await ensureLiveBrowser()
  return await cdpEvaluate(`(() => ({
    url: location.href,
    title: document.title,
    historyLength: history.length,
    referrer: document.referrer || null,
    canGoBack: history.length > 1,
    note: 'Browsers do not expose the full cross-origin history list to page JavaScript; use back/forward actions to navigate it.'
  }))()`)
}

async function currentLiveBrowserURL() {
  const page = await liveBrowserPage()
  return { url: page.url, title: page.title }
}

async function raiseLiveBrowserWindow() {
  const current = await currentLiveBrowserURL().catch(() => undefined)
  const windows = await visibleChromeWindows()
  if (!windows.length) return

  const title = current?.title?.trim()
  const host = (() => {
    try {
      return current?.url ? new URL(current.url).hostname.replace(/^www\./, "") : undefined
    } catch {
      return undefined
    }
  })()
  const match =
    windows.find((window) => title && window.title.includes(title)) ??
    windows.find((window) => host && window.title.toLowerCase().includes(host.split(".")[0]?.toLowerCase() ?? host)) ??
    windows[0]
  if (!match) return

  await execText("xdotool", ["windowraise", match.id, "windowfocus", match.id], liveBrowserDisplay()).catch(
    () => undefined,
  )
  await delay(150)
}

async function fitLiveBrowserWindow() {
  const windows = await visibleChromeWindows()
  const match = windows
    .filter((window) => (window.width ?? 0) >= 200 && (window.height ?? 0) >= 200)
    .sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0))[0]
  if (!match) return

  const viewport = liveBrowserViewport()
  await execText("xdotool", ["windowmove", match.id, "0", "0"], liveBrowserDisplay()).catch(() => undefined)
  await execText(
    "xdotool",
    ["windowsize", match.id, String(viewport.width), String(viewport.height)],
    liveBrowserDisplay(),
  ).catch(() => undefined)
}

async function visibleChromeWindows() {
  const raw = await execText("xdotool", ["search", "--onlyvisible", "--class", "chrome"], liveBrowserDisplay()).catch(
    () => "",
  )
  const ids = raw
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean)

  const windows: Array<{ id: string; title: string; width?: number; height?: number }> = []
  for (const id of ids) {
    const title = await execText("xdotool", ["getwindowname", id], liveBrowserDisplay()).catch(() => "")
    const info = await execText("xwininfo", ["-id", id], liveBrowserDisplay()).catch(() => "")
    const width = Number(info.match(/Width:\s+(\d+)/)?.[1])
    const height = Number(info.match(/Height:\s+(\d+)/)?.[1])
    windows.push({
      id,
      title: title.trim(),
      width: Number.isFinite(width) ? width : undefined,
      height: Number.isFinite(height) ? height : undefined,
    })
  }
  return windows
}

async function cdpEvaluate(expression: string) {
  const body = await cdpCommand("Runtime.evaluate", { expression, returnByValue: true })
  return (body as any)?.result?.value ?? body
}

async function dispatchCDPKey(key: string) {
  const normalized = key === "Return" ? "Enter" : key === "BackSpace" ? "Backspace" : key
  const codes: Record<string, { code: string; windowsVirtualKeyCode: number }> = {
    Enter: { code: "Enter", windowsVirtualKeyCode: 13 },
    Tab: { code: "Tab", windowsVirtualKeyCode: 9 },
    Escape: { code: "Escape", windowsVirtualKeyCode: 27 },
    Backspace: { code: "Backspace", windowsVirtualKeyCode: 8 },
    Delete: { code: "Delete", windowsVirtualKeyCode: 46 },
    ArrowLeft: { code: "ArrowLeft", windowsVirtualKeyCode: 37 },
    ArrowUp: { code: "ArrowUp", windowsVirtualKeyCode: 38 },
    ArrowRight: { code: "ArrowRight", windowsVirtualKeyCode: 39 },
    ArrowDown: { code: "ArrowDown", windowsVirtualKeyCode: 40 },
  }
  const info = codes[normalized] ?? { code: normalized, windowsVirtualKeyCode: normalized.charCodeAt(0) || 0 }
  const params = {
    key: normalized,
    code: info.code,
    windowsVirtualKeyCode: info.windowsVirtualKeyCode,
    nativeVirtualKeyCode: info.windowsVirtualKeyCode,
  }
  await cdpCommand("Input.dispatchKeyEvent", { ...params, type: "keyDown" })
  await cdpCommand("Input.dispatchKeyEvent", { ...params, type: "keyUp" })
}

async function cdpCommand(method: string, params: Record<string, unknown> = {}) {
  const page = await liveBrowserPage()
  const ws = page.webSocketDebuggerUrl
  if (!ws) throw new Error("Live browser CDP websocket is unavailable")

  const WebSocketCtor = (globalThis as any).WebSocket
  if (typeof WebSocketCtor !== "function") throw new Error("WebSocket is unavailable in this runtime")

  return await new Promise((resolve, reject) => {
    const socket = new WebSocketCtor(ws)
    const timeout = setTimeout(() => {
      socket.close()
      reject(new Error("Live browser CDP request timed out"))
    }, 5000)
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id: 1, method, params }))
    })
    socket.addEventListener("message", (event: MessageEvent) => {
      try {
        const body = JSON.parse(String(event.data))
        if (body.id !== 1) return
        clearTimeout(timeout)
        socket.close()
        if (body.error) reject(new Error(body.error.message || "CDP evaluate failed"))
        else resolve(body.result ?? {})
      } catch (error) {
        clearTimeout(timeout)
        socket.close()
        reject(error)
      }
    })
    socket.addEventListener("error", () => {
      clearTimeout(timeout)
      reject(new Error("Live browser CDP websocket failed"))
    })
  })
}

async function liveBrowserPage() {
  await ensureLiveBrowser()
  const response = await fetch(`http://127.0.0.1:${liveBrowserDebugPort()}/json/list`)
  if (!response.ok) throw new Error(`Live browser CDP returned HTTP ${response.status}`)
  const pages = (await response.json()) as Array<{
    type?: string
    url?: string
    title?: string
    webSocketDebuggerUrl?: string
  }>
  const page =
    pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl) ??
    pages.find((item) => item.webSocketDebuggerUrl)
  if (!page?.webSocketDebuggerUrl) throw new Error("No live browser page target found")
  return {
    url: page.url || "about:blank",
    title: page.title || "",
    webSocketDebuggerUrl: page.webSocketDebuggerUrl,
  }
}

const browserUseBridgeURL = () => process.env.OPENCODE_BROWSER_USE_URL || "http://127.0.0.1:8768"

async function browserUseBridgeStatus() {
  const base = browserUseBridgeURL().replace(/\/+$/, "")
  const [health, sessions] = await Promise.all([
    fetch(`${base}/health`).then(readStatus).catch(errorStatus),
    fetch(`${base}/sessions`).then(readStatus).catch(errorStatus),
  ])
  const healthBody = (health as any)?.body ?? health
  const sessionsBody = (sessions as any)?.body ?? sessions
  return {
    ok: Boolean((health as any)?.ok && healthBody?.ok),
    bridgeURL: base,
    health: healthBody,
    sessions: sessionsBody,
    liveURL: healthBody?.liveUrl,
    activeSessions: healthBody?.activeSessions ?? sessionsBody?.sessions?.length ?? 0,
  }
}

function normalizeBrowserURL(raw?: string) {
  const value = raw?.trim()
  if (!value) return undefined
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value
  if (value.includes(".") && !value.includes(" ")) return `https://${value}`
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`
}

async function liveOnlyEnvironmentStatus() {
  const hostname = process.env.OPENCODE_HOSTNAME || "code.hustletogether.com"
  const releaseRoot = "/opt/opencode-workspace-suite/releases"
  const currentSymlink = "/opt/opencode-workspace-suite/current"
  const currentRelease = await execText("readlink", ["-f", currentSymlink])
    .then((value) => value.trim())
    .catch(() => null)
  const releases = latestWorkspaceSuiteReleases(releaseRoot)
  const [opencodeRepo, experimentsRepo] = await Promise.all([
    gitRepositoryStatus({
      label: "OpenCode workspace suite",
      path: "/home/dev/repos/opencode",
      pushRemote: "fork",
    }),
    gitRepositoryStatus({
      label: "LLM-Experiments",
      path: "/home/dev/repos/LLM-Experiments",
      pushRemote: "origin",
    }),
  ])

  const appPasswordConfigured = Boolean(process.env.OPENCODE_SERVER_PASSWORD)
  const workspaceEnv = readWorkspaceEnvRegistryPublic()
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    mode: "live-only",
    desiredInvariant: "Only code.hustletogether.com should be the public OpenCode entrypoint.",
    routes: {
      liveURL: `https://${hostname}/`,
      healthURL: `https://${hostname}/__health`,
      resetURL: `https://${hostname}/__reset`,
      internalOpenCode: "127.0.0.1:8299",
      publicProxy: "0.0.0.0:8300",
      disabledDirectRuntime: "0.0.0.0:8310",
      legacyHostname: "opencode.hustletogether.com",
      legacyHostnameState:
        "Removed from active CT100 and Proxmox Cloudflare tunnel configs; external DNS/Access object may still exist.",
    },
    release: {
      currentSymlink,
      currentRelease,
      releaseRoot,
      releases,
      rollbackCandidates: releases.filter((item) => item.path !== currentRelease).slice(0, 5),
    },
    access: {
      appPasswordConfigured,
      desiredBoundary: "Cloudflare Access GitHub login",
      status: liveBrowserAccessConfigSummary().configured ? "cloudflare_access_configured" : "approval_required",
      warning: liveBrowserAccessConfigSummary().configured
        ? null
        : "Cloudflare Access GitHub login is not configured in the running service environment. Do not expose Browser until Access AUD/team-domain env vars are set and verified.",
      cloudflareAccess: liveBrowserAccessConfigSummary(),
      secretValuesExposed: false,
    },
    workspaceEnv: {
      route: "/experimental/workspace-env",
      path: workspaceEnv.path,
      count: workspaceEnv.entries.length,
      enabledCount: workspaceEnv.entries.filter((entry) => entry.enabled).length,
      secretCount: workspaceEnv.entries.filter((entry) => entry.secret).length,
      promptSummaryConfigured: workspaceEnv.entries.some((entry) => entry.enabled),
      secretValuesExposed: false,
    },
    git: {
      opencode: opencodeRepo,
      experiments: experimentsRepo,
    },
    gates: [
      {
        label: "GitHub push",
        status: opencodeRepo.pushReady && experimentsRepo.pushReady ? "ready" : "blocked",
        detail: "Push only after the remotes/auth path is valid and Alfonso approves the external mutation.",
      },
      {
        label: "Access boundary",
        status: appPasswordConfigured ? "ready" : "approval_required",
        detail: "Changing OPENCODE_SERVER_PASSWORD, Cloudflare Access, or DNS remains approval-gated.",
      },
      {
        label: "Rollback",
        status: releases.length > 1 ? "available" : "limited",
        detail: "Rollback candidates are previous release directories under /opt/opencode-workspace-suite/releases.",
      },
    ],
  }
}

function workspaceEnvStatus() {
  const registry = readWorkspaceEnvRegistryPublic()
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    registry,
    effective: {
      reposRoot: process.env.OPENCODE_WORKSPACE_ENV_REPOS_ROOT || "/home/dev/repos",
      promptSummaryPreview:
        workspaceEnvPromptSummary({ directory: "/home/dev/repos", cwd: "/home/dev/repos", surface: "bash" }) ?? null,
      inheritedBy: ["terminal", "bash"],
      plannedScopes: ["routines", "browser", "preview", "open_design"],
      apply: {
        // Enabled entries are injected into NEW OpenCode-launched terminals/bash
        // processes at spawn time. Already-running processes (this opencode.service,
        // open terminals, the live browser) keep the env they started with.
        appliesTo: "new OpenCode-launched terminal/bash processes",
        restartRequiredFor: ["opencode.service", "already-open terminals", "running project servers"],
        note: "Saving a variable takes effect for newly launched processes immediately; restart a service or open a fresh terminal to pick up changes there.",
      },
    },
  }
}

function workspaceEnvAction(body: any) {
  try {
    const action = typeof body?.action === "string" ? body.action : "upsert"
    if (action === "delete") {
      const id = typeof body?.id === "string" ? body.id : ""
      if (!id) throw new Error("Missing env entry id")
      return { ok: true, action, ...deleteWorkspaceEnvEntry(id), registry: readWorkspaceEnvRegistryPublic() }
    }
    if (action === "validate") {
      // No values returned - safe for chat/logs/artifacts.
      return { ok: true, action, validation: validateDotenvText(typeof body?.dotenv === "string" ? body.dotenv : "") }
    }
    if (action === "import") {
      if (typeof body?.dotenv !== "string" || !body.dotenv.trim()) throw new Error("Missing dotenv text")
      const summary = importDotenvText(body.dotenv, {
        scope: typeof body?.scope === "string" ? body.scope : undefined,
        enabled: typeof body?.enabled === "boolean" ? body.enabled : undefined,
      })
      return { ok: summary.ok, action, summary, registry: readWorkspaceEnvRegistryPublic() }
    }
    if (action === "upsert") {
      const entry = upsertWorkspaceEnvEntry({
        id: typeof body?.id === "string" ? body.id : undefined,
        name: String(body?.name ?? ""),
        value: typeof body?.value === "string" ? body.value : undefined,
        scope: typeof body?.scope === "string" ? body.scope : undefined,
        target: typeof body?.target === "string" ? body.target : undefined,
        enabled: typeof body?.enabled === "boolean" ? body.enabled : undefined,
        secret: typeof body?.secret === "boolean" ? body.secret : undefined,
        description: typeof body?.description === "string" ? body.description : undefined,
      })
      return { ok: true, action, entry, registry: readWorkspaceEnvRegistryPublic() }
    }
    throw new Error(`Unsupported workspace env action: ${action}`)
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      registry: readWorkspaceEnvRegistryPublic(),
    }
  }
}

function latestWorkspaceSuiteReleases(releaseRoot: string) {
  const rootStat = statSync(releaseRoot, { throwIfNoEntry: false })
  if (!rootStat?.isDirectory()) return []
  return readdirSync(releaseRoot, { withFileTypes: true })
    .flatMap((entry) => {
      if (!entry.isDirectory()) return []
      const releasePath = path.join(releaseRoot, entry.name)
      const stat = statSync(releasePath, { throwIfNoEntry: false })
      if (!stat?.isDirectory()) return []
      return [
        {
          name: entry.name,
          path: releasePath,
          updatedAt: stat.mtime.toISOString(),
        },
      ]
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 12)
}

async function gitRepositoryStatus(input: { label: string; path: string; pushRemote: string }) {
  if (!existsSync(input.path)) {
    return {
      label: input.label,
      path: input.path,
      exists: false,
      pushReady: false,
      error: "Repository path is missing",
    }
  }

  const [branch, commit, status, remotes, remoteProbe] = await Promise.all([
    execTextIn("git", ["rev-parse", "--abbrev-ref", "HEAD"], input.path).catch((error: unknown) => errorMessage(error)),
    execTextIn("git", ["rev-parse", "--short", "HEAD"], input.path).catch((error: unknown) => errorMessage(error)),
    execTextIn("git", ["status", "--short"], input.path).catch((error: unknown) => errorMessage(error)),
    execTextIn("git", ["remote", "-v"], input.path).catch((error: unknown) => errorMessage(error)),
    probeGitRemote(input.path, input.pushRemote),
  ])

  return {
    label: input.label,
    path: input.path,
    exists: true,
    branch: branch.trim(),
    commit: commit.trim(),
    dirtyCount: status.trim() ? status.trim().split("\n").length : 0,
    dirtyPreview: status.trim().split("\n").filter(Boolean).slice(0, 8),
    remotes: remotes
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.replace(/\s+/g, " ")),
    pushRemote: input.pushRemote,
    pushReady: remoteProbe.ok,
    remoteProbe,
  }
}

async function probeGitRemote(cwd: string, remote: string) {
  try {
    const output = await execTextIn("git", ["ls-remote", "--heads", remote], cwd, 10000)
    return {
      ok: true,
      remote,
      headsVisible: output
        .trim()
        .split("\n")
        .filter(Boolean)
        .slice(0, 5)
        .map((line) => line.replace(/\s+/g, " ")),
    }
  } catch (error) {
    return {
      ok: false,
      remote,
      error: errorMessage(error),
    }
  }
}

function execText(command: string, args: string[], display?: string) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      command,
      args,
      { env: display ? { ...process.env, DISPLAY: display } : process.env },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || stdout || error.message))
          return
        }
        resolve(stdout.toString())
      },
    )
  })
}

function execTextIn(command: string, args: string[], cwd: string, timeout = 8000) {
  return new Promise<string>((resolve, reject) => {
    execFile(command, args, { cwd, env: process.env, timeout, maxBuffer: 512_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || stdout || error.message).toString().trim()))
        return
      }
      resolve(stdout.toString())
    })
  })
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function openDesignCodexAccount() {
  const marker =
    process.env.OPENCODE_OPEN_DESIGN_CODEX_MARKER ||
    path.join(process.env.HOME || "/home/dev", ".local", "share", "opencode-open-design", "codex-account.json")
  const parsed = readJsonObject(marker)
  if (!parsed) return { bridged: false, note: "No Codex Multi-Auth account has been synced into Open Design yet." }
  const degraded = parsed.degraded === true
  const requestedActiveAlias = typeof parsed.requestedActiveAlias === "string" ? parsed.requestedActiveAlias : null
  return {
    bridged: true,
    alias: typeof parsed.alias === "string" ? parsed.alias : null,
    email: typeof parsed.email === "string" ? parsed.email : null,
    forced: parsed.forced === true,
    degraded,
    requestedActiveAlias,
    syncedAt: typeof parsed.syncedAt === "string" ? parsed.syncedAt : null,
    note: degraded
      ? `Open Design is authenticated as ${typeof parsed.email === "string" ? parsed.email : "an existing account"}, which may differ from the active Codex account${requestedActiveAlias ? ` (${requestedActiveAlias})` : ""}. Re-seed could not rotate the active token; it re-syncs on the next successful account switch.`
      : "Open Design's Codex CLI authenticates as the active Codex Multi-Auth account (synced by opencode-open-design-codex-sync).",
  }
}

async function openDesignStatus() {
  const { daemonURL, publicURL, token, proxyReady } = openDesignConfig()
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {}

  const health = await fetch(`${daemonURL}/api/health`, { headers }).then(readStatus).catch(errorStatus)
  const projects = await fetch(`${daemonURL}/api/projects`, { headers })
    .then(async (response) => {
      const body = await safeJson(response)
      return {
        ok: response.ok,
        status: response.status,
        count: Array.isArray(body?.projects) ? body.projects.length : 0,
        projects: Array.isArray(body?.projects)
          ? body.projects.slice(0, 12).map((project: any) => ({
              id: project.id,
              name: project.name,
              status: project.status?.value ?? null,
              updatedAt: project.updatedAt ?? null,
            }))
          : [],
      }
    })
    .catch(errorStatus)

  return {
    configured: health.ok === true,
    tokenConfigured: !!token,
    codexAccount: openDesignCodexAccount(),
    daemonURL,
    publicURL,
    proxyURL: "/experimental/open-design/proxy/",
    frameMode: proxyReady ? "proxy" : "external_blocked",
    frameBlockedReason: proxyReady
      ? null
      : "Direct design.hustletogether.com embedding is blocked by Cloudflare Access frame headers; open externally instead.",
    proxyReady,
    routeReady: true,
    routeNote:
      "design.hustletogether.com routes to the Open Design daemon behind Cloudflare Access; the OpenCode tab uses the hosted route for the interactive app.",
    health,
    projects,
  }
}

function openDesignConfig() {
  const daemonURL = (
    process.env.OD_DAEMON_URL ||
    process.env.OPENCODE_OPEN_DESIGN_DAEMON_URL ||
    process.env.OPENCODE_OPEN_DESIGN_URL ||
    "http://127.0.0.1:7456"
  ).replace(/\/+$/, "")
  const publicURL = (process.env.OPENCODE_OPEN_DESIGN_PUBLIC_URL || "https://design.hustletogether.com").replace(
    /\/+$/,
    "",
  )
  const token = process.env.OD_API_TOKEN || process.env.OPENCODE_OPEN_DESIGN_TOKEN
  return {
    daemonURL,
    publicURL,
    token,
    proxyReady: process.env.OPENCODE_OPEN_DESIGN_PROXY !== "0",
  }
}

async function openDesignProxyResponse(
  rawURL: string,
  method = "GET",
  requestHeaders: Record<string, string | undefined> = {},
  rawBody?: string,
) {
  const { daemonURL, token, proxyReady } = openDesignConfig()
  if (!proxyReady) return HttpServerResponse.text("Open Design proxy is disabled", { status: 404 })

  const url = new URL(rawURL, "http://localhost")
  const pathPart = url.pathname.startsWith("/experimental/open-design/proxy/")
    ? url.pathname.replace(/^\/experimental\/open-design\/proxy\/?/, "")
    : url.pathname.replace(/^\/+/, "")
  const targetURL = `${daemonURL}/${pathPart}${url.search}`
  const headers: Record<string, string> = {
    accept: requestHeaders.accept || "*/*",
    "x-opencode-open-design-proxy": "1",
  }
  const contentType = requestHeaders["content-type"]
  if (contentType) headers["content-type"] = contentType
  if (token) headers.authorization = `Bearer ${token}`

  const response = await fetch(targetURL, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : rawBody,
    redirect: "manual",
  }).catch(() => undefined)
  if (!response) return HttpServerResponse.text("Open Design daemon unavailable", { status: 502 })
  const responseContentType = response.headers.get("content-type") ?? "text/html"
  const openDesignCSP = [
    "default-src 'self' data: blob:",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: https://static.cloudflareinsights.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https://fonts.gstatic.com",
    "connect-src * data: blob:",
    "frame-src 'self' https: http:",
    "worker-src 'self' blob:",
    "media-src 'self' data: blob: https: http:",
  ].join("; ")

  const rewriteOpenDesignURL = (value: string) => {
    if (value.startsWith(daemonURL)) {
      const next = new URL(value)
      return `/experimental/open-design/proxy${next.pathname}${next.search}${next.hash}`
    }
    if (value.startsWith("/")) return `/experimental/open-design/proxy${value}`
    return value
  }

  const withProxyHeaders = (result: any) => {
    let next = HttpServerResponse.setHeader(
      HttpServerResponse.setHeader(result, "content-security-policy", openDesignCSP),
      "cache-control",
      "private, no-store",
    )
    const location = response.headers.get("location")
    if (location) next = HttpServerResponse.setHeader(next, "location", rewriteOpenDesignURL(location))
    return next
  }

  const rewriteOpenDesignText = (input: string) =>
    input
      .replaceAll('src="/_next/', 'src="/experimental/open-design/proxy/_next/')
      .replaceAll('href="/_next/', 'href="/experimental/open-design/proxy/_next/')
      .replaceAll('href="/app-icon.png"', 'href="/experimental/open-design/proxy/app-icon.png"')
      .replaceAll('"/_next/', '"/experimental/open-design/proxy/_next/')
      .replaceAll("'/_next/", "'/experimental/open-design/proxy/_next/")
      .replaceAll("`/_next/", "`/experimental/open-design/proxy/_next/")
      .replaceAll('\\"/_next/', '\\"/experimental/open-design/proxy/_next/')
      .replaceAll("\\'/_next/", "\\'/experimental/open-design/proxy/_next/")
      .replaceAll('"/api/', '"/experimental/open-design/proxy/api/')
      .replaceAll("'/api/", "'/experimental/open-design/proxy/api/")
      .replaceAll("`/api/", "`/experimental/open-design/proxy/api/")
      .replaceAll('\\"/api/', '\\"/experimental/open-design/proxy/api/')
      .replaceAll("\\'/api/", "\\'/experimental/open-design/proxy/api/")
      .replaceAll("url(/_next/", "url(/experimental/open-design/proxy/_next/")

  if (responseContentType.includes("text/html")) {
    const html = await response.text()
    return withProxyHeaders(
      HttpServerResponse.text(rewriteOpenDesignText(html), {
        status: response.status,
        contentType: responseContentType,
      }),
    )
  }

  if (responseContentType.includes("text/css")) {
    const css = await response.text()
    return withProxyHeaders(
      HttpServerResponse.text(rewriteOpenDesignText(css), {
        status: response.status,
        contentType: responseContentType,
      }),
    )
  }

  if (
    responseContentType.includes("javascript") ||
    responseContentType.includes("application/json") ||
    responseContentType.includes("text/plain")
  ) {
    const body = await response.text()
    return withProxyHeaders(
      HttpServerResponse.text(rewriteOpenDesignText(body), {
        status: response.status,
        contentType: responseContentType,
      }),
    )
  }

  const bytes = new Uint8Array(await response.arrayBuffer())
  return withProxyHeaders(
    HttpServerResponse.uint8Array(bytes, { status: response.status, contentType: responseContentType }),
  )
}

function macViewFeedURL() {
  return process.env.OPENCODE_MAC_VIEW_URL?.replace(/\/+$/, "")
}

type MacViewSettings = {
  fps: number
  width: number
  quality: number
  bitrate: number
  transport: "webrtc" | "video" | "mjpeg"
}

const macViewSettingsPath = () =>
  path.join(
    process.env.OPENCODE_MAC_VIEW_SETTINGS_HOME ||
      path.join(process.env.HOME ?? "/home/dev", ".local", "share", "opencode-mac-view"),
    "settings.json",
  )

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.round(number)))
}

function normalizeMacViewTransport(value?: string): MacViewSettings["transport"] {
  return value === "video" || value === "mjpeg" || value === "webrtc" ? value : "webrtc"
}

function normalizeMacViewSettings(input: Partial<MacViewSettings>): MacViewSettings {
  return {
    fps: macViewFPS(input.fps),
    width: clampNumber(input.width, 640, 2048, 1280),
    quality: clampNumber(input.quality, 4, 18, 8),
    bitrate: clampNumber(input.bitrate, 1000, 20000, 6000),
    transport: normalizeMacViewTransport(input.transport),
  }
}

function macViewDefaultSettings(): MacViewSettings {
  return normalizeMacViewSettings({
    fps: Number(process.env.OPENCODE_MAC_VIEW_FPS ?? 30),
    width: Number(process.env.OPENCODE_MAC_VIEW_WIDTH ?? 1280),
    quality: Number(process.env.OPENCODE_MAC_VIEW_QUALITY ?? 8),
    bitrate: Number(process.env.OPENCODE_MAC_VIEW_BITRATE ?? 6000),
    transport: normalizeMacViewTransport(process.env.OPENCODE_MAC_VIEW_TRANSPORT),
  })
}

function macViewSettings(): MacViewSettings {
  const defaults = macViewDefaultSettings()
  try {
    const parsed = JSON.parse(readFileSync(macViewSettingsPath(), "utf8")) as Partial<MacViewSettings>
    return normalizeMacViewSettings({ ...defaults, ...parsed })
  } catch {
    return defaults
  }
}

function writeMacViewSettings(input: Partial<MacViewSettings>): MacViewSettings {
  const next = normalizeMacViewSettings({ ...macViewSettings(), ...input })
  const target = macViewSettingsPath()
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`)
  return next
}

function macViewFPS(value = process.env.OPENCODE_MAC_VIEW_FPS || 30) {
  const configured = Number(value)
  if (!Number.isFinite(configured)) return 30
  return Math.max(1, Math.min(60, Math.round(configured)))
}

function macViewFPSFromRequest(requestURL: string) {
  const value = new URL(requestURL, "http://localhost").searchParams.get("fps")
  return macViewFPS(value || undefined)
}

async function macViewStreamResponse(requestURL: string) {
  const feedURL = macViewFeedURL()
  if (!feedURL) return HttpServerResponse.text("Mac View is not configured", { status: 404 })
  const url = new URL(requestURL, "http://localhost")
  const settings = macViewSettings()
  const fps = macViewFPS(url.searchParams.get("fps") || settings.fps)
  const width = clampNumber(url.searchParams.get("width") || settings.width, 640, 2048, settings.width)
  const quality = clampNumber(url.searchParams.get("quality") || settings.quality, 4, 18, settings.quality)
  const controller = new AbortController()
  const response = await fetch(
    `${feedURL}/stream?fps=${fps}&width=${Math.round(width)}&quality=${Math.round(quality)}`,
    { signal: controller.signal },
  )
  if (!response.ok || !response.body) {
    controller.abort()
    return HttpServerResponse.text(`Mac View stream unavailable: ${response.status}`, { status: 502 })
  }
  const reader = response.body.getReader()
  return HttpServerResponse.setHeader(
    HttpServerResponse.stream(
      Stream.fromAsyncIterable(
        (async function* () {
          try {
            while (true) {
              const chunk = await reader.read()
              if (chunk.done) return
              yield chunk.value
            }
          } finally {
            controller.abort()
            await reader.cancel().catch(() => undefined)
          }
        })(),
        (cause) => new Error(`Mac View stream error: ${String(cause)}`),
      ),
      { contentType: response.headers.get("content-type") ?? "multipart/x-mixed-replace; boundary=ffmpeg" },
    ),
    "cache-control",
    "no-store",
  )
}

async function macViewVideoResponse(requestURL: string) {
  const feedURL = macViewFeedURL()
  if (!feedURL) return HttpServerResponse.text("Mac View is not configured", { status: 404 })
  const url = new URL(requestURL, "http://localhost")
  const settings = macViewSettings()
  const fps = macViewFPS(url.searchParams.get("fps") || settings.fps)
  const width = clampNumber(url.searchParams.get("width") || settings.width, 640, 2048, settings.width)
  const bitrate = clampNumber(url.searchParams.get("bitrate") || settings.bitrate, 1000, 20000, settings.bitrate)
  const controller = new AbortController()
  const response = await fetch(
    `${feedURL}/video?fps=${fps}&width=${Math.round(width)}&bitrate=${Math.round(bitrate)}`,
    { signal: controller.signal },
  )
  if (!response.ok || !response.body) {
    controller.abort()
    return HttpServerResponse.text(`Mac View video unavailable: ${response.status}`, { status: 502 })
  }
  const reader = response.body.getReader()
  return HttpServerResponse.setHeader(
    HttpServerResponse.stream(
      Stream.fromAsyncIterable(
        (async function* () {
          try {
            while (true) {
              const chunk = await reader.read()
              if (chunk.done) return
              yield chunk.value
            }
          } finally {
            controller.abort()
            await reader.cancel().catch(() => undefined)
          }
        })(),
        (cause) => new Error(`Mac View video error: ${String(cause)}`),
      ),
      { contentType: response.headers.get("content-type") ?? "video/mp4" },
    ),
    "cache-control",
    "no-store",
  )
}

async function macViewSCKStatusResponse() {
  const feedURL = macViewFeedURL()
  if (!feedURL) return HttpServerResponse.text("Mac View is not configured", { status: 404 })
  const response = await fetch(`${feedURL}/sck/status`).catch(() => undefined)
  if (!response) return HttpServerResponse.text("Mac View ScreenCaptureKit probe unavailable", { status: 502 })
  const body = await response.text()
  return HttpServerResponse.setHeader(
    HttpServerResponse.text(body || "{}", {
      status: response.ok ? 200 : response.status,
      contentType: response.headers.get("content-type") ?? "application/json",
    }),
    "cache-control",
    "no-store",
  )
}

async function macViewWebRTCResponse(
  requestURL: string,
  method: string,
  headers: Record<string, string>,
  rawBody?: string,
) {
  const feedURL = macViewFeedURL()
  if (!feedURL) return HttpServerResponse.text("Mac View is not configured", { status: 404 })
  const url = new URL(requestURL, "http://localhost")
  const pathPart = url.pathname.replace(/^\/experimental\/mac-view\/webrtc\/?/, "")
  const targetURL = `${feedURL}/webrtc/${pathPart}${url.search}`
  const proxyHeaders: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase()
    if (!value || ["host", "connection", "content-length"].includes(lower)) continue
    proxyHeaders[key] = value
  }
  const response = await fetch(targetURL, {
    method,
    headers: proxyHeaders,
    body: method === "GET" || method === "HEAD" ? undefined : rawBody,
  }).catch(() => undefined)
  if (!response) return HttpServerResponse.text("Mac View WebRTC proxy unavailable", { status: 502 })
  const bytes = new Uint8Array(await response.arrayBuffer())
  let output = HttpServerResponse.setHeader(
    HttpServerResponse.uint8Array(bytes, {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
    }),
    "cache-control",
    "no-store",
  )
  const location = response.headers.get("location")
  if (location) {
    output = HttpServerResponse.setHeader(
      output,
      "location",
      location.replace(/^\/webrtc\//, "/experimental/mac-view/webrtc/"),
    )
  }
  return output
}

async function macViewStatus() {
  const feedURL = macViewFeedURL()
  if (!feedURL) {
    return {
      configured: false,
      mode: "read-only",
      note: "Set OPENCODE_MAC_VIEW_URL to the Mac ScreenCaptureKit helper endpoint.",
    }
  }
  const health = await fetch(`${feedURL}/health`).then(readStatus).catch(errorStatus)
  const settings = macViewSettings()
  const rawTransportOptions = (health as any)?.body?.options?.transport ?? ["webrtc", "video"]
  const transportOptions = rawTransportOptions.filter((option: string) => option === "webrtc" || option === "video")
  const transport = transportOptions.includes(settings.transport)
    ? settings.transport
    : transportOptions.includes("webrtc")
      ? "webrtc"
      : normalizeMacViewTransport(transportOptions[0])
  return {
    configured: true,
    mode: "read-only",
    feedURL,
    settings,
    fps: settings.fps,
    width: settings.width,
    quality: settings.quality,
    bitrate: settings.bitrate,
    transport,
    fpsOptions: [6, 12, 20, 30, 45, 60],
    widthOptions: [960, 1280, 1600, 2048],
    qualityOptions: [6, 8, 10, 12],
    bitrateOptions: (health as any)?.body?.options?.bitrate ?? [2500, 4000, 6000, 8000, 12000],
    transportOptions,
    nativeCapture: (health as any)?.body?.nativeCapture ?? null,
    webrtc: (health as any)?.body?.webrtc ?? null,
    health,
    snapshotURL: "/experimental/mac-view/snapshot",
    sckStatusURL: "/experimental/mac-view/sck/status",
    webrtcURL: "/experimental/mac-view/webrtc/mac-view/",
    webrtcStatusURL: "/experimental/mac-view/webrtc/status",
    webrtcStartURL: "/experimental/mac-view/webrtc/start",
    webrtcStopURL: "/experimental/mac-view/webrtc/stop",
    streamURL: "/experimental/mac-view/stream",
    videoURL: "/experimental/mac-view/video",
  }
}

async function readStatus(response: Response) {
  return { ok: response.ok, status: response.status, body: await safeJson(response) }
}

async function safeJson(response: Response) {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { text: text.slice(0, 500) }
  }
}

function errorStatus(error: unknown) {
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
}

const uiRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const client = yield* HttpClient.HttpClient
    const flags = yield* RuntimeFlags.Service
    yield* router.add("*", "/*", (request) =>
      serveUIEffect(request, { fs, client, disableEmbeddedWebUi: flags.disableEmbeddedWebUi }),
    )
  }),
).pipe(Layer.provide(authOnlyRouterLayer))

type RouteRequirements =
  | HttpRouter.HttpRouter
  | HttpRouter.Request<"Error", unknown>
  | HttpRouter.Request<"GlobalError", unknown>
  | HttpRouter.Request<"Requires", unknown>
  | HttpRouter.Request<"GlobalRequires", never>

const app = LayerNode.group([
  Npm.node,
  FSUtil.node,
  Database.node,
  Auth.node,
  Account.node,
  Config.node,
  Env.node,
  Git.node,
  Ripgrep.node,
  Storage.node,
  Snapshot.node,
  Plugin.node,
  ModelsDev.node,
  Provider.node,
  ProviderAuth.node,
  Agent.node,
  Skill.node,
  Discovery.node,
  Question.node,
  Permission.node,
  PermissionSaved.node,
  Todo.node,
  Session.node,
  SessionProjector.node,
  SessionStatus.node,
  BackgroundJob.node,
  RuntimeFlags.node,
  EventV2Bridge.node,
  SessionRunState.node,
  SessionProcessor.node,
  SessionCompaction.node,
  SessionRevert.node,
  SessionSummary.node,
  SessionPrompt.node,
  Instruction.node,
  LLM.node,
  LSP.node,
  MCP.node,
  McpAuth.node,
  Command.node,
  Truncate.node,
  ToolRegistry.node,
  Format.node,
  Project.node,
  Vcs.node,
  Workspace.node,
  Worktree.node,
  Installation.node,
  ShareNext.node,
  SessionShare.node,
  InstanceStore.node,
  httpClient,
  EventV2.node,
  ProjectV2.node,
  ProjectCopy.node,
  PtyTicket.node,
])

export function createRoutes(
  corsOptions?: CorsOptions,
): Layer.Layer<never, EffectConfig.ConfigError, RouteRequirements> {
  return Layer.mergeAll(
    rootApiRoutes,
    eventApiRoutes,
    ptyConnectApiRoutes,
    instanceRoutes,
    serverRoutes,
    docRoute,
    browserPreviewRoute,
    workspaceIndexRoute,
    fileViewerRoute,
    tracingStatusRoute,
    imageGenRoute,
    secretsRoute,
    homeChatRoute,
    workspaceSuiteRoute,
    uiRoute,
  ).pipe(
    Layer.provide([
      errorLayer,
      compressionLayer,
      corsVaryFix,
      fenceLayer,
      cors(corsOptions),
      MoveSession.defaultLayer,
      HttpServer.layerServices,
    ]),
    Layer.provide(Layer.succeed(CorsConfig)(corsOptions)),
    Layer.provideMerge(Observability.layer),

    Layer.provide(sessionLocationLayer),
    Layer.provide(locationLayer),
    Layer.provide(PtyEnvironment.layer),
    Layer.provide(
      SessionV2.defaultLayer.pipe(
        Layer.provide(SessionExecutionLocal.defaultLayer),
        Layer.provide(locationServiceMapLayer),
      ),
    ),
    Layer.provide(locationServiceMapLayer),

    Layer.provide(LayerNode.compile(app)),
  )
}

export const routes = createRoutes()

export const webHandler = lazy(() =>
  HttpRouter.toWebHandler(routes, {
    disableLogger: true,
    memoMap,
    middleware: disposeMiddleware,
  }),
)

export * as HttpApiApp from "./server"
