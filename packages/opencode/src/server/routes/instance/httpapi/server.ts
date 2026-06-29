import { Config as EffectConfig, Context, Effect, Layer, Stream } from "effect"
import { HttpApiBuilder, OpenApi } from "effect/unstable/httpapi"
import { HttpClient, HttpMiddleware, HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { execFile, spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
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

    yield* router.add("GET", "/experimental/browser/live/status", () =>
      Effect.promise(async () => HttpServerResponse.jsonUnsafe(await liveBrowserStatus())),
    )

    yield* router.add("GET", "/experimental/browser/live/stream", () =>
      Effect.succeed(
        HttpServerResponse.setHeader(
          HttpServerResponse.stream(liveBrowserStream(), {
            contentType: `multipart/x-mixed-replace; boundary=${liveBrowserStreamBoundary}`,
          }),
          "cache-control",
          "no-store",
        ),
      ),
    )

    yield* router.add("GET", "/experimental/browser/live/snapshot", () =>
      Effect.promise(async () => {
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
      ),
    )

    yield* router.add("POST", "/experimental/browser/live/input", (request) =>
      Effect.gen(function* () {
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
        return HttpServerResponse.jsonUnsafe(result, { status: result.ok ? 200 : 500 })
      }),
    )

    yield* router.add("POST", "/experimental/browser/live/selector", (request) =>
      Effect.gen(function* () {
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
        if (!fileViewerAllowed(directory))
          return HttpServerResponse.text("Directory is outside allowed roots", { status: 403 })

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
        if (!fileViewerAllowed(file))
          return HttpServerResponse.text("File is outside allowed viewer roots", { status: 403 })

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
            "browser_use",
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

    yield* router.add("GET", "/experimental/mac-view/stream", () =>
      Effect.promise(async () => {
        const feedURL = process.env.OPENCODE_MAC_VIEW_URL?.replace(/\/+$/, "")
        if (!feedURL) return HttpServerResponse.text("Mac View is not configured", { status: 404 })
        const response = await fetch(`${feedURL}/snapshot`).catch(() => undefined)
        if (!response?.ok) return HttpServerResponse.text("Mac View stream unavailable", { status: 502 })
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

function listArtifactFiles(
  dir: string,
  root = dir,
): Array<{ name: string; size: number; mtime: string; kind: string }> {
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

type LiveBrowserInput =
  | { action: "status" }
  | { action: "goto"; url?: string }
  | { action: "back" }
  | { action: "forward" }
  | { action: "reload" }
  | { action: "click"; x?: number; y?: number }
  | { action: "type"; text?: string }
  | { action: "key"; key?: string }
  | { action: "scroll"; deltaX?: number; deltaY?: number }

const liveBrowserDisplay = () => process.env.OPENCODE_LIVE_BROWSER_DISPLAY || ":99"
const liveBrowserStreamBoundary = "opencode-browser-frame"
const liveBrowserHome = () =>
  path.resolve(
    process.env.OPENCODE_LIVE_BROWSER_HOME ||
      path.join(process.env.HOME ?? "/home/dev", ".local", "share", "opencode-live-browser"),
  )
const liveBrowserProfile = () => path.join(liveBrowserHome(), "profile")
const liveBrowserArtifacts = () => path.join(liveBrowserHome(), "artifacts")
const liveBrowserDebugPort = () => Number(process.env.OPENCODE_LIVE_BROWSER_DEBUG_PORT || 9224)

async function liveBrowserStatus() {
  const browser = await ensureLiveBrowser().catch((error: unknown) => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }))
  const cdp = await currentLiveBrowserURL().catch(() => undefined)
  return {
    ok: browser.ok,
    mode: "ct100-xvfb-chrome",
    display: liveBrowserDisplay(),
    profile: liveBrowserProfile(),
    debugPort: liveBrowserDebugPort(),
    currentURL: cdp?.url,
    title: cdp?.title,
    error: "error" in browser ? browser.error : undefined,
    screenshotURL: "/experimental/browser/live/snapshot",
    streamURL: "/experimental/browser/live/stream",
    browserUse: await browserUseBridgeStatus().catch((error: unknown) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })),
  }
}

async function ensureLiveBrowser(): Promise<{ ok: true; pid?: number } | { ok: false; error: string }> {
  mkdirSync(liveBrowserProfile(), { recursive: true })
  mkdirSync(liveBrowserArtifacts(), { recursive: true })

  const existing = await execText("pgrep", ["-f", `${liveBrowserProfile()}`]).catch(() => "")
  const pid = existing
    .split(/\s+/)
    .map((value) => Number(value))
    .find((value) => Number.isFinite(value) && value > 0)
  if (pid) return { ok: true, pid }

  const chrome = process.env.OPENCODE_LIVE_BROWSER_BIN || "google-chrome"
  const child = spawn(
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
      "--window-size=1440,1000",
      "--start-maximized",
      "about:blank",
    ],
    {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        DISPLAY: liveBrowserDisplay(),
      },
    },
  )
  child.unref()
  await delay(1200)
  return { ok: true, pid: child.pid }
}

async function runLiveBrowserInput(input: LiveBrowserInput) {
  await ensureLiveBrowser()
  switch (input.action) {
    case "status":
      return await liveBrowserStatus()
    case "goto": {
      const url = normalizeBrowserURL(input.url)
      if (!url) return { ok: false, error: "Missing URL" }
      await cdpEvaluate(`location.href = ${JSON.stringify(url)}`)
      await delay(900)
      await raiseLiveBrowserWindow()
      return { ok: true, currentURL: url }
    }
    case "back":
      await cdpEvaluate("history.back()")
      await delay(400)
      await raiseLiveBrowserWindow()
      return { ok: true }
    case "forward":
      await cdpEvaluate("history.forward()")
      await delay(400)
      await raiseLiveBrowserWindow()
      return { ok: true }
    case "reload":
      await cdpEvaluate("location.reload()")
      await delay(600)
      await raiseLiveBrowserWindow()
      return { ok: true }
    case "click": {
      const x = Math.max(0, Math.round(input.x ?? 0))
      const y = Math.max(0, Math.round(input.y ?? 0))
      await execText("xdotool", ["mousemove", "--sync", String(x), String(y), "click", "1"], liveBrowserDisplay())
      return { ok: true, x, y }
    }
    case "type": {
      if (!input.text) return { ok: false, error: "Missing text" }
      await execText("xdotool", ["type", "--delay", "1", input.text], liveBrowserDisplay())
      return { ok: true }
    }
    case "key": {
      if (!input.key) return { ok: false, error: "Missing key" }
      await execText("xdotool", ["key", input.key], liveBrowserDisplay())
      return { ok: true }
    }
    case "scroll": {
      const dy = input.deltaY ?? 0
      const button = dy < 0 ? "4" : "5"
      const steps = Math.min(8, Math.max(1, Math.round(Math.abs(dy) / 160)))
      for (let idx = 0; idx < steps; idx += 1) await execText("xdotool", ["click", button], liveBrowserDisplay())
      return { ok: true, steps, deltaY: dy }
    }
  }
}

function liveBrowserStream() {
  return Stream.fromAsyncIterable(
    (async function* () {
      await ensureLiveBrowser()
      while (true) {
        const image = await captureLiveBrowserImage({ transient: true })
        yield multipartBrowserFrame(image)
        await delay(850)
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

async function captureLiveBrowserImage(options: { transient?: boolean } = {}) {
  await ensureLiveBrowser()
  await raiseLiveBrowserWindow()
  const file = options.transient
    ? path.join(liveBrowserHome(), `live-frame-${process.pid}.png`)
    : path.join(liveBrowserArtifacts(), `snapshot-${Date.now()}.png`)
  await execText("import", ["-window", "root", "-resize", "1280x889", file], liveBrowserDisplay())
  return readFileSync(file)
}

async function saveLiveBrowserScreenshot(
  sessionID: string,
  input: { annotationDataURL?: string; note?: string; selector?: string },
) {
  await ensureLiveBrowser()
  const paths = sessionPaths(sessionID)
  mkdirSync(paths.artifactDir, { recursive: true })
  const stamped = new Date().toISOString().replace(/[:.]/g, "-")
  const name = input.annotationDataURL ? `browser-annotation-${stamped}.png` : `browser-screenshot-${stamped}.png`
  const file = path.join(paths.artifactDir, name)

  if (input.annotationDataURL?.startsWith("data:image/")) {
    const base64 = input.annotationDataURL.split(",", 2)[1]
    if (!base64) throw new Error("Invalid annotation data URL")
    writeFileSync(file, Buffer.from(base64, "base64"))
  } else {
    const image = await captureLiveBrowserImage()
    writeFileSync(file, image)
  }

  const meta = {
    createdAt: new Date().toISOString(),
    kind: input.annotationDataURL ? "browser-annotation" : "browser-screenshot",
    note: input.note ?? null,
    selector: input.selector ?? null,
    source: await currentLiveBrowserURL().catch(() => null),
    image: name,
  }
  writeFileSync(path.join(paths.artifactDir, `${name}.json`), JSON.stringify(meta, null, 2))

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
  return { ok: true, selector, result }
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

async function visibleChromeWindows() {
  const raw = await execText("xdotool", ["search", "--onlyvisible", "--class", "chrome"], liveBrowserDisplay()).catch(
    () => "",
  )
  const ids = raw
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean)

  const windows: Array<{ id: string; title: string }> = []
  for (const id of ids) {
    const title = await execText("xdotool", ["getwindowname", id], liveBrowserDisplay()).catch(() => "")
    windows.push({ id, title: title.trim() })
  }
  return windows
}

async function cdpEvaluate(expression: string) {
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
      socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }))
    })
    socket.addEventListener("message", (event: MessageEvent) => {
      try {
        const body = JSON.parse(String(event.data))
        if (body.id !== 1) return
        clearTimeout(timeout)
        socket.close()
        if (body.error) reject(new Error(body.error.message || "CDP evaluate failed"))
        else resolve(body.result?.result?.value ?? body.result)
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

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
