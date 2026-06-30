import { Config as EffectConfig, Context, Effect, Layer, Stream } from "effect"
import { HttpApiBuilder, OpenApi } from "effect/unstable/httpapi"
import { HttpClient, HttpMiddleware, HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { execFile, spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { createRemoteJWKSet, jwtVerify } from "jose"
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
import { HttpApiProxy } from "./middleware/proxy"
import { disposeMiddleware } from "./lifecycle"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { compressionLayer } from "./middleware/compression"
import { corsVaryFix } from "./middleware/cors-vary"
import { errorLayer } from "./middleware/error"
import { fenceLayer } from "./middleware/fence"
import { schemaErrorLayer } from "./middleware/schema-error"
import { captureBrowserScreenshot, runBrowserAction, sessionPaths, type BrowserActionInput } from "@/tool/browser"
import { collectResourceStatus } from "@/tool/resource-status"
import { routineLogs, routinesAction, routinesStatus } from "@/tool/routines"
import { workspaceTabsAction, workspaceTabsStatus } from "@/tool/workspace-tabs"

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

const fileViewerRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add("GET", "/experimental/files/browse", (request) =>
      Effect.promise(async () => {
        const url = new URL(request.url, "http://localhost")
        const requested = url.searchParams.get("path")
        const directory = path.resolve(requested || fileBrowserDefaultPath())
        if (!fileViewerAllowed(directory))
          return HttpServerResponse.text("Directory is outside allowed roots", { status: 403 })

        const stat = safeStat(directory)
        if (!stat?.isDirectory()) return HttpServerResponse.text("Directory not found", { status: 404 })

        const skipped: Array<{ name: string; reason: string }> = []
        const entries = readdirSync(directory, { withFileTypes: true })
          .flatMap((entry) => {
            if (entry.name === "." || entry.name === "..") return []
            const file = path.join(directory, entry.name)
            const fileStat = safeStat(file)
            if (!fileStat) {
              skipped.push({ name: entry.name, reason: "unreadable" })
              return []
            }
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
          HttpServerResponse.uint8Array(new Uint8Array(readFileSync(file)), { contentType: contentTypeForFile(file) }),
          "cache-control",
          "private, no-store",
        )
      }),
    )
  }),
).pipe(Layer.provide(authOnlyRouterLayer))

async function codexMultiAuthStatus() {
  const script = process.env.OPENCODE_CODEX_MULTI_AUTH_SCRIPT || "/home/dev/repos/LLM-Experiments/scripts/opencode-codex-multi-auth-profile.mjs"
  if (!existsSync(script)) return { ok: false, configured: false, error: "Codex multi-auth status script not found" }
  return new Promise((resolve) => {
    execFile(
      "node",
      [script, "status"],
      { cwd: path.dirname(path.dirname(script)), timeout: 8000, maxBuffer: 256_000 },
      (error, stdout, stderr) => {
        const output = [stdout?.toString(), stderr?.toString()].filter(Boolean).join("\n").trim()
        if (error) {
          resolve({ ok: false, configured: true, command: script + " status", error: cleanStatusOutput(output || error.message) })
          return
        }
        resolve({ ok: true, configured: true, command: script + " status", output: cleanStatusOutput(output) })
      },
    )
  })
}

function cleanStatusOutput(value: string) {
  return value
    .split("\n")
    .filter((line) => !line.startsWith("npm error config prefix cannot be changed"))
    .join("\n")
    .replace(/([A-Za-z0-9_-]{24,})/g, "[redacted]")
    .slice(0, 2000)
}

const workspaceSuiteRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const projects = yield* Project.Service
    const sessions = yield* Session.Service

    yield* router.add("GET", "/experimental/workspace-suite/status", () =>
      Effect.gen(function* () {
        const workspaceIndex = yield* buildWorkspaceIndex(projects, sessions)
        return yield* Effect.promise(async () =>
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
            "routines",
            "workspace_tabs",
          ],
          workspaceTabs: workspaceTabsStatus(),
          openDesign: await openDesignStatus(),
          macView: await macViewStatus(),
          routines: await routinesStatus(),
          resources: {
            route: "/experimental/resources/status",
            macHost: process.env.OPENCODE_MAC_RESOURCE_HOST || "alfonso-mac",
          },
          codexAccounts: await codexMultiAuthStatus(),
          artifactRootConfigured: !!process.env.OPENCODE_BROWSER_HOME,
          agentChrome: liveBrowserGateStatus(),
          workspaceIndex,
        }),
        )
      }),
    )

    yield* router.add("GET", "/experimental/workspace-suite/environments", () =>
      Effect.promise(async () => HttpServerResponse.jsonUnsafe(await liveOnlyEnvironmentStatus())),
    )

    yield* router.add("GET", "/experimental/workspace-tabs/status", () =>
      Effect.promise(async () => HttpServerResponse.jsonUnsafe(workspaceTabsStatus())),
    )

    yield* router.add("POST", "/experimental/workspace-tabs/action", (request) =>
      Effect.gen(function* () {
        const raw = yield* Effect.orDie(request.text)
        const body = raw ? JSON.parse(raw) : {}
        return yield* Effect.promise(async () => HttpServerResponse.jsonUnsafe(workspaceTabsAction(body as any)))
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

    yield* router.add("GET", "/experimental/routines/status", () =>
      Effect.promise(async () => HttpServerResponse.jsonUnsafe(await routinesStatus())),
    )

    yield* router.add("GET", "/experimental/routines/jobs", () =>
      Effect.promise(async () => HttpServerResponse.jsonUnsafe(await routinesAction({ action: "list" }))),
    )

    yield* router.add("GET", "/experimental/routines/jobs/:id/logs", (request) =>
      Effect.promise(async () => {
        const id = decodeParam(request.url, /^\/experimental\/routines\/jobs\/([^/]+)\/logs$/)
        return HttpServerResponse.jsonUnsafe(await routineLogs(id))
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
        const raw = request.method === "GET" || request.method === "HEAD" ? undefined : yield* Effect.orDie(request.text)
        return yield* Effect.promise(async () => macViewWebRTCResponse(request.url, request.method, request.headers, raw))
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
): Array<{ name: string; size: number; mtime: string; kind: string; contentType: string }> {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) return listArtifactFiles(file, root)
      const stat = statSync(file, { throwIfNoEntry: false })
      if (!stat?.isFile()) return []
      const relative = path.relative(root, file)
      const contentType = contentTypeForFile(relative)
      return [
        {
          name: relative,
          size: stat.size,
          mtime: stat.mtime.toISOString(),
          kind: fileKind(contentType),
          contentType,
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
  if (/\.(ts|tsx|js|jsx|mjs|cjs|css|scss|sass|py|rb|go|rs|java|c|cc|cpp|h|hpp|cs|php|swift|kt|kts|sh|bash|zsh|fish|sql|yaml|yml|toml|xml|vue|svelte)$/i.test(lower)) return "text/plain"
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
  | { action: "back" }
  | { action: "forward" }
  | { action: "reload" }
  | { action: "click"; x?: number; y?: number }
  | { action: "type"; text?: string }
  | { action: "key"; key?: string }
  | { action: "scroll"; deltaX?: number; deltaY?: number }

const liveBrowserDisplay = () => process.env.OPENCODE_LIVE_BROWSER_DISPLAY || ":99"
const liveBrowserStreamBoundary = "opencode-browser-frame"
const liveBrowserStreamDelay = () => Math.max(250, Number(process.env.OPENCODE_LIVE_BROWSER_FRAME_MS || 500))
const liveBrowserHome = () =>
  path.resolve(
    process.env.OPENCODE_LIVE_BROWSER_HOME ||
      path.join(process.env.HOME ?? "/home/dev", ".local", "share", "opencode-live-browser"),
  )
const liveBrowserProfile = () => path.join(liveBrowserHome(), "profile")
const liveBrowserArtifacts = () => path.join(liveBrowserHome(), "artifacts")
const liveBrowserDebugPort = () => Number(process.env.OPENCODE_LIVE_BROWSER_DEBUG_PORT || 9224)
const liveBrowserNoVNCURL = () => (process.env.OPENCODE_LIVE_BROWSER_NOVNC_URL || "http://127.0.0.1:6080").replace(/\/+$/, "")
const liveBrowserExposureEnabled = () => process.env.OPENCODE_LIVE_BROWSER_EXPOSE === "1"

type LiveBrowserAccess =
  | {
      ok: true
      mode: "cloudflare-access"
      email: string | null
      audience: string
      teamDomain: string
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
    mode: liveBrowserExposureEnabled() ? "cloudflare-access-required" : "disabled",
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
  const profileRoot = liveBrowserProfile()
  const status = accessBoundaryReady
    ? extensionRequested || persistentAuthRequested
      ? "ready_after_manual_profile_setup"
      : "safe_default_no_persistent_auth"
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
      exposedToBrowserUI: accessBoundaryReady,
    },
    persistentAuth: {
      requested: persistentAuthRequested,
      enabled: accessBoundaryReady && persistentAuthRequested,
      status: accessBoundaryReady
        ? persistentAuthRequested
          ? "manual_profile_setup_required"
          : "disabled_by_policy"
        : "blocked_until_access_boundary",
    },
    extensions: {
      requested: extensionRequested,
      enabled: accessBoundaryReady && extensionRequested,
      installMode: accessBoundaryReady && extensionRequested ? "manual_chrome_profile" : "disabled",
      status: accessBoundaryReady
        ? extensionRequested
          ? "manual_install_required"
          : "disabled_by_policy"
        : "blocked_until_access_boundary",
    },
    lastPass: {
      requested: lastPassRequested,
      enabled: accessBoundaryReady && extensionRequested && lastPassRequested,
      status: accessBoundaryReady
        ? extensionRequested && lastPassRequested
          ? "manual_install_and_login_required"
          : "disabled_by_policy"
        : "blocked_until_access_boundary",
    },
    surfaces: [
      {
        id: "preview",
        label: "Preview",
        tab: "Preview",
        purpose: "Interactive renderer for hosted routes, local project URLs, and viewable files.",
        usesChromeProfile: false,
        toolControlled: false,
        safeWhilePublic: true,
      },
      {
        id: "agent_chrome",
        label: "Agent Chrome",
        tab: "Agent Chrome",
        purpose: "Shared visible Chromium surface for manual viewing and tool control.",
        usesChromeProfile: true,
        toolControlled: true,
        safeWhilePublic: false,
        exposed: accessBoundaryReady,
      },
      {
        id: "browser_use",
        label: "Browser Use",
        tab: "Agent Chrome",
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

async function liveBrowserExposureAccess(request: { headers: Record<string, string | undefined> }): Promise<LiveBrowserAccess> {
  if (!liveBrowserExposureEnabled()) {
    return liveBrowserAccessBlocked(
      "disabled",
      "Live browser viewing and control are disabled. Keep OPENCODE_LIVE_BROWSER_EXPOSE unset until Cloudflare Access with GitHub login is verified.",
    )
  }

  const config = liveBrowserCloudflareAccessConfig()
  if (!config.configured || !config.audience || !config.teamDomain) {
    return liveBrowserAccessBlocked(
      "missing-cloudflare-config",
      "OPENCODE_LIVE_BROWSER_EXPOSE is enabled, but Cloudflare Access AUD/team domain env vars are missing.",
    )
  }

  const token = liveBrowserAccessToken(request)
  if (!token) {
    return liveBrowserAccessBlocked("missing-cloudflare-token", "Missing Cloudflare Access JWT assertion.")
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
      return liveBrowserAccessBlocked("invalid-cloudflare-token", "Cloudflare Access user is not allowlisted for Agent Chrome.")
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
      #screen canvas { width: 100% !important; height: 100% !important; object-fit: contain; background: #fff; }
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
      }
    </style>
  </head>
  <body>
    <div id="screen"></div>
    <div id="status">connecting</div>
    <script type="module">
      import RFB from "/experimental/browser/novnc/core/rfb.js";

      const status = document.getElementById("status");
      const target = document.getElementById("screen");
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = protocol + "//" + window.location.host + "${websocketPath}";
      const rfb = new RFB(target, url, { shared: true });

      rfb.viewOnly = false;
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.focusOnClick = true;

      rfb.addEventListener("connect", () => { status.textContent = "interactive"; });
      rfb.addEventListener("disconnect", (event) => {
        status.textContent = event.detail?.clean ? "disconnected" : "connection lost";
      });
      rfb.addEventListener("credentialsrequired", () => { status.textContent = "credentials required"; });

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
  return {
    ok: browser.ok,
    mode: "ct100-cdp-chrome",
    primaryTransport: "cdp",
    fallbackTransport: "vnc",
    display: liveBrowserDisplay(),
    profile: liveBrowserProfile(),
    profilePolicy: liveBrowserProfilePolicy(),
    debugPort: liveBrowserDebugPort(),
    currentURL: cdp?.url,
    title: cdp?.title,
    error: "error" in browser ? browser.error : undefined,
    screenshotURL: "/experimental/browser/live/snapshot",
    streamURL: "/experimental/browser/live/stream",
    proxiedLiveURL: "/experimental/browser/novnc/opencode-lite.html?path=websockify",
    actions: ["goto", "back", "forward", "reload", "click", "type", "key", "scroll", "screenshot", "selector"],
    access: access
      ? {
          mode: access.mode,
          email: access.email,
          teamDomain: access.teamDomain,
        }
      : undefined,
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
      const x = Math.max(0, Math.round(input.x ?? 0))
      const y = Math.max(0, Math.round(input.y ?? 0))
      await cdpCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" })
      await cdpCommand("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 })
      await cdpCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 })
      return { ok: true, x, y }
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
  const currentRelease = await execText("readlink", ["-f", currentSymlink]).then((value) => value.trim()).catch(() => null)
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
        : "Cloudflare Access GitHub login is not configured in the running service environment. Do not expose Agent Chrome until Access AUD/team-domain env vars are set and verified.",
      cloudflareAccess: liveBrowserAccessConfigSummary(),
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

function macViewFeedURL() {
  return process.env.OPENCODE_MAC_VIEW_URL?.replace(/\/+$/, "")
}

function macViewFPS(value = process.env.OPENCODE_MAC_VIEW_FPS || 30) {
  const configured = Number(value)
  if (!Number.isFinite(configured)) return 30
  return Math.max(1, Math.min(60, configured))
}

function macViewFPSFromRequest(requestURL: string) {
  const value = new URL(requestURL, "http://localhost").searchParams.get("fps")
  return macViewFPS(value || undefined)
}

async function macViewStreamResponse(requestURL: string) {
  const feedURL = macViewFeedURL()
  if (!feedURL) return HttpServerResponse.text("Mac View is not configured", { status: 404 })
  const url = new URL(requestURL, "http://localhost")
  const fps = macViewFPS(url.searchParams.get("fps") || undefined)
  const width = Math.max(640, Math.min(2048, Number(url.searchParams.get("width") || 1280)))
  const quality = Math.max(4, Math.min(18, Number(url.searchParams.get("quality") || process.env.OPENCODE_MAC_VIEW_QUALITY || 8)))
  const controller = new AbortController()
  const response = await fetch(`${feedURL}/stream?fps=${fps}&width=${Math.round(width)}&quality=${Math.round(quality)}`, { signal: controller.signal })
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
  const fps = macViewFPS(url.searchParams.get("fps") || undefined)
  const width = Math.max(640, Math.min(2048, Number(url.searchParams.get("width") || 1280)))
  const bitrate = Math.max(1000, Math.min(20000, Number(url.searchParams.get("bitrate") || process.env.OPENCODE_MAC_VIEW_BITRATE || 6000)))
  const controller = new AbortController()
  const response = await fetch(`${feedURL}/video?fps=${fps}&width=${Math.round(width)}&bitrate=${Math.round(bitrate)}`, { signal: controller.signal })
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

async function macViewWebRTCResponse(requestURL: string, method: string, headers: Record<string, string>, rawBody?: string) {
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
  return {
    configured: true,
    mode: "read-only",
    feedURL,
    fps: macViewFPS(),
    width: Math.max(640, Math.min(2048, Number(process.env.OPENCODE_MAC_VIEW_WIDTH || 1280))),
    quality: Math.max(4, Math.min(18, Number(process.env.OPENCODE_MAC_VIEW_QUALITY || 8))),
    bitrate: Math.max(1000, Math.min(20000, Number(process.env.OPENCODE_MAC_VIEW_BITRATE || 6000))),
    transport: (health as any)?.body?.defaults?.transport ?? "video",
    fpsOptions: [6, 12, 20, 30, 45, 60],
    widthOptions: [960, 1280, 1600, 2048],
    qualityOptions: [6, 8, 10, 12],
    bitrateOptions: (health as any)?.body?.options?.bitrate ?? [2500, 4000, 6000, 8000, 12000],
    transportOptions: (health as any)?.body?.options?.transport ?? ["video", "mjpeg"],
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
