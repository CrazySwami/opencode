import { Config as EffectConfig, Context, Effect, Layer } from "effect"
import { HttpApiBuilder, OpenApi } from "effect/unstable/httpapi"
import { HttpClient, HttpMiddleware, HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import * as Observability from "@opencode-ai/core/observability"
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
import { disposeMiddleware } from "./lifecycle"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { compressionLayer } from "./middleware/compression"
import { corsVaryFix } from "./middleware/cors-vary"
import { errorLayer } from "./middleware/error"
import { fenceLayer } from "./middleware/fence"
import { schemaErrorLayer } from "./middleware/schema-error"
import { captureBrowserScreenshot, runBrowserAction, sessionPaths, type BrowserActionInput } from "@/tool/browser"
import { collectResourceStatus } from "@/tool/resource-status"

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

const browserPreviewRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
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
  }),
).pipe(Layer.provide(authOnlyRouterLayer))

const workspaceIndexRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const projects = yield* Project.Service
    const sessions = yield* Session.Service

    yield* router.add("GET", "/__workspace-index", () =>
      Effect.gen(function* () {
        const projectList = yield* projects.list()
        const sessionList = yield* sessions.listGlobal({ roots: true, limit: 500 })
        const sessionCounts = new Map<string, number>()

        for (const session of sessionList) {
          const projectID = session.project?.id
          if (!projectID) continue
          sessionCounts.set(projectID, (sessionCounts.get(projectID) ?? 0) + 1)
        }

        return HttpServerResponse.jsonUnsafe({
          ok: true,
          generatedAt: new Date().toISOString(),
          roots: fileViewerRoots(),
          projects: projectList.map((project) => ({
            id: project.id,
            name: project.name,
            worktree: project.worktree,
            updatedAt: project.time.updated,
            activeSessions: sessionCounts.get(project.id) ?? 0,
          })),
          sessions: sessionList.slice(0, 100).map((session) => ({
            id: session.id,
            title: session.title,
            directory: session.directory,
            updatedAt: session.time.updated,
            project: session.project,
          })),
        })
      }),
    )
  }),
).pipe(Layer.provide(authOnlyRouterLayer))

const fileViewerRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add("GET", "/experimental/files/browse", (request) =>
      Effect.promise(async () => {
        const url = new URL(request.url, "http://localhost")
        const requested = url.searchParams.get("path")
        const directory = path.resolve(requested || fileBrowserDefaultPath())
        if (!fileViewerAllowed(directory)) return HttpServerResponse.text("Directory is outside allowed roots", { status: 403 })

        const stat = statSync(directory, { throwIfNoEntry: false })
        if (!stat?.isDirectory()) return HttpServerResponse.text("Directory not found", { status: 404 })

        const entries = readdirSync(directory, { withFileTypes: true })
          .flatMap((entry) => {
            if (entry.name === "." || entry.name === "..") return []
            const file = path.join(directory, entry.name)
            const fileStat = statSync(file, { throwIfNoEntry: false })
            if (!fileStat) return []
            const isDirectory = entry.isDirectory()
            const contentType = isDirectory ? null : contentTypeForFile(file)
            return [
              {
                name: entry.name,
                path: file,
                kind: isDirectory ? "directory" : fileKind(contentType ?? ""),
                contentType,
                size: isDirectory ? null : fileStat.size,
                mtime: fileStat.mtime.toISOString(),
                browseURL: isDirectory ? `/experimental/files/browse?path=${encodeURIComponent(file)}` : null,
                url: isDirectory ? null : `/experimental/files/view?path=${encodeURIComponent(file)}`,
              },
            ]
          })
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
        if (!fileViewerAllowed(file)) return HttpServerResponse.text("File is outside allowed viewer roots", { status: 403 })

        const stat = statSync(file, { throwIfNoEntry: false })
        if (!stat?.isFile()) return HttpServerResponse.text("File not found", { status: 404 })

        return HttpServerResponse.setHeader(
          HttpServerResponse.uint8Array(new Uint8Array(readFileSync(file)), { contentType: contentTypeForFile(file) }),
          "cache-control",
          "private, no-store",
        )
      }),
    )
  }),
).pipe(Layer.provide(authOnlyRouterLayer))

const workspaceSuiteRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add("GET", "/experimental/workspace-suite/status", () =>
      Effect.promise(async () =>
        HttpServerResponse.jsonUnsafe({
          ok: true,
          generatedAt: new Date().toISOString(),
          hostname: process.env.OPENCODE_HOSTNAME ?? null,
          tools: [
            "browser",
            "terminal",
            "open_design",
            "mac_view",
            "resource_status",
            "artifact",
            "file_browser",
            "account_status",
          ],
          openDesign: await openDesignStatus(),
          macView: await macViewStatus(),
          resources: {
            route: "/experimental/resources/status",
            macHost: process.env.OPENCODE_MAC_RESOURCE_HOST || "alfonso-mac",
          },
          artifactRootConfigured: !!process.env.OPENCODE_BROWSER_HOME,
        }),
      ),
    )

    yield* router.add("GET", "/experimental/resources/status", (request) =>
      Effect.promise(async () => {
        const url = new URL(request.url, "http://localhost")
        const target = url.searchParams.get("target")
        const safeTarget = target === "server" || target === "mac" || target === "all" ? target : "all"
        return HttpServerResponse.jsonUnsafe(await collectResourceStatus(safeTarget))
      }),
    )

    yield* router.add("GET", "/experimental/open-design/status", () =>
      Effect.promise(async () => HttpServerResponse.jsonUnsafe(await openDesignStatus())),
    )

    yield* router.add("GET", "/experimental/open-design/proxy/*", (request) =>
      Effect.promise(async () => openDesignProxyResponse(request.url)),
    )

    yield* router.add("GET", "/experimental/mac-view/status", () =>
      Effect.promise(async () => HttpServerResponse.jsonUnsafe(await macViewStatus())),
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

    yield* router.add("GET", "/experimental/browser/:sessionID/artifacts", (request) =>
      Effect.promise(async () => {
        const sessionID = decodeParam(request.url, /^\/experimental\/browser\/([^/]+)\/artifacts$/)
        if (!sessionID) return HttpServerResponse.text("Missing session ID", { status: 400 })
        const paths = sessionPaths(sessionID)
        return HttpServerResponse.jsonUnsafe({
          browserSessionID: paths.browserSessionID,
          artifactDir: paths.artifactDir,
          files: listArtifactFiles(paths.artifactDir).map((file) => ({
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
        const stat = statSync(file, { throwIfNoEntry: false })
        if (!stat?.isFile()) return HttpServerResponse.text("Artifact not found", { status: 404 })
        return HttpServerResponse.setHeader(
          HttpServerResponse.uint8Array(new Uint8Array(readFileSync(file)), { contentType: contentTypeForFile(name) }),
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

function listArtifactFiles(dir: string, root = dir): Array<{ name: string; size: number; mtime: string; kind: string }> {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) return listArtifactFiles(file, root)
      const stat = statSync(file, { throwIfNoEntry: false })
      if (!stat?.isFile()) return []
      const relative = path.relative(root, file)
      return [
        {
          name: relative,
          size: stat.size,
          mtime: stat.mtime.toISOString(),
          kind: relative.toLowerCase().endsWith(".png") ? "image" : "file",
        },
      ]
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime))
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
  if (lower.endsWith(".md") || lower.endsWith(".txt") || lower.endsWith(".log")) return "text/plain"
  return "application/octet-stream"
}

function fileViewerRoots() {
  const explicit = process.env.OPENCODE_FILE_VIEW_ROOTS?.split(path.delimiter).filter(Boolean) ?? []
  const browserHome =
    process.env.OPENCODE_BROWSER_HOME || path.join(process.env.HOME ?? "/home/dev", ".local", "share", "opencode-browser")
  return [...explicit, browserHome, process.env.OPENCODE_DEV_ROOT ?? "/home/dev/repos"]
    .map((root) => path.resolve(root))
    .filter((root, index, list) => list.indexOf(root) === index)
}

function fileViewerAllowed(file: string) {
  const resolved = path.resolve(file)
  return fileViewerRoots().some((root) => resolved === root || resolved.startsWith(root + path.sep))
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

function fileKind(contentType: string) {
  if (contentType.startsWith("image/")) return "image"
  if (contentType.startsWith("video/")) return "video"
  if (contentType.startsWith("audio/")) return "audio"
  if (contentType === "application/pdf") return "pdf"
  if (contentType.startsWith("text/") || contentType === "application/json") return "text"
  return "file"
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
    configured: !!token,
    daemonURL,
    publicURL,
    proxyURL: "/experimental/open-design/proxy/",
    proxyReady,
    routeReady: false,
    routeNote: "design.hustletogether.com is intentionally held at safe 404 until Cloudflare Access is approved.",
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
    proxyReady: process.env.OPENCODE_OPEN_DESIGN_PROXY === "1",
  }
}

async function openDesignProxyResponse(rawURL: string) {
  const { daemonURL, token, proxyReady } = openDesignConfig()
  if (!proxyReady) return HttpServerResponse.text("Open Design proxy is disabled", { status: 404 })

  const url = new URL(rawURL, "http://localhost")
  const pathPart = url.pathname.replace(/^\/experimental\/open-design\/proxy\/?/, "")
  const targetURL = `${daemonURL}/${pathPart}${url.search}`
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {}

  const response = await fetch(targetURL, { headers }).catch(() => undefined)
  if (!response) return HttpServerResponse.text("Open Design daemon unavailable", { status: 502 })
  const bytes = new Uint8Array(await response.arrayBuffer())
  return HttpServerResponse.setHeader(
    HttpServerResponse.uint8Array(bytes, { contentType: response.headers.get("content-type") ?? "text/html" }),
    "cache-control",
    "private, no-store",
  )
}

async function macViewStatus() {
  const feedURL = process.env.OPENCODE_MAC_VIEW_URL?.replace(/\/+$/, "")
  if (!feedURL) {
    return {
      configured: false,
      mode: "read-only",
      note: "Set OPENCODE_MAC_VIEW_URL to the Mac ScreenCaptureKit helper endpoint.",
    }
  }
  const health = await fetch(`${feedURL}/health`).then(readStatus).catch(errorStatus)
  return {
    configured: true,
    mode: "read-only",
    feedURL,
    health,
    snapshotURL: "/experimental/mac-view/snapshot",
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
