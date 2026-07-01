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
import { createRoutineDraft, routineLogs, routinesAction, routinesStatus } from "@/tool/routines"
import { publishAppleBridgeEvent } from "@/tool/ios-bridge-events"
import { ackWorkspaceTabsAction, updateWorkspaceTabsClientState, workspaceTabsAction, workspaceTabsPendingActions, workspaceTabsStatus } from "@/tool/workspace-tabs"

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
    const index = await Effect.runPromise(buildWorkspaceIndex(projects, sessions))
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

const codexMultiAuthScript = () =>
  process.env.OPENCODE_CODEX_MULTI_AUTH_SCRIPT || "/home/dev/repos/LLM-Experiments/scripts/opencode-codex-multi-auth-profile.mjs"

type CodexMultiAuthCommandResult = {
  ok: boolean
  configured: boolean
  command?: string
  output?: string
  error?: string
}

type CodexMultiAuthStatusResult = Record<string, unknown>

let codexMultiAuthStatusInFlight: Promise<CodexMultiAuthStatusResult> | null = null
let codexMultiAuthStatusCache:
  | {
      expiresAt: number
      value: CodexMultiAuthStatusResult
    }
  | null = null

function clearCodexMultiAuthStatusCache() {
  codexMultiAuthStatusCache = null
}

async function runCodexMultiAuthCommand(command: string, timeout = 8000): Promise<CodexMultiAuthCommandResult> {
  const script = codexMultiAuthScript()
  if (!existsSync(script))
    return { ok: false, configured: false, command: script + " " + command, error: "Codex multi-auth status script not found" }
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
          resolve({ ok: false, configured: true, command: script + " " + command, error: cleanStatusOutput(output || error.message) })
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

function parseCodexUsageSummary(value: string | undefined) {
  if (!value) return null
  const lines = value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /remaining|weekly|limit|reset|usage/i.test(line))
  return lines.slice(0, 3).join(" · ") || null
}

function codexMultiAuthLoginAttemptPath() {
  const home = process.env.HOME || "/home/dev"
  return path.join(home, ".local", "share", "opencode-codex-multi-auth", "login-status.json")
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
  if (value.hasUserCode || parsed.code) sanitized.hasUserCode = true
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
      error: parseCodexAuthFailure([attempt.output, attempt.error, attempt.authorizationURL].filter(Boolean).join("\n")),
      note: "Start a fresh Authenticate Codex account flow after the rate limit or challenge clears.",
    })
    writeCodexMultiAuthLoginAttempt(next)
    return next
  }
  const waiting =
    attempt?.phase === "waiting_for_device_approval" || attempt?.phase === "waiting_for_browser_approval"
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
  const status = await runCodexMultiAuthCommand("status")
  const loginAttempt = normalizeCodexMultiAuthLoginAttempt(readCodexMultiAuthLoginAttempt())
  const base = {
    commands: ["login", "login-headless", "list", "status", "limits", "health", "run"],
    loginRoute: "/experimental/codex-multi-auth/login",
    authFlow: "opencode-multi-auth add <alias>",
    loginAttempt,
  }
  if (!status.configured || !status.ok)
    return {
      ...status,
      ...base,
      accountCount: 0,
      accountsConfigured: false,
      sendRouting: "unavailable",
      warning: status.error ?? "Codex multi-auth status is unavailable.",
    }
  const statusAccountCount = parseCodexAccountCount(status.output)
  const detailResults: CodexMultiAuthCommandResult[] =
    statusAccountCount > 0
      ? await Promise.all([
          runCodexMultiAuthCommand("list", 4000),
          runCodexMultiAuthCommand("limits", 2500),
          runCodexMultiAuthCommand("health", 2500),
        ])
      : [
          { ok: true, configured: true, output: status.output },
          { ok: true, configured: true, output: "" },
          { ok: true, configured: true, output: "" },
        ]
  const [list, limits, health] = detailResults
  const accountCount = parseCodexAccountCount(status.output, list.output, limits.output, health.output)
  const accountsConfigured = accountCount > 0
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
    accountCount,
    accountsConfigured,
    activeAccount: null,
    rotationStrategy: "auto",
    sendRouting: accountsConfigured ? "multi-auth-profile-pending-runner-verification" : "openai-fallback",
    warning: accountsConfigured
      ? "Codex multi-auth accounts are configured. Verify backend send routing before relying on account rotation."
      : loginAttemptPhase === "account_written_or_already_authorized"
        ? "The last Codex login process exited successfully, but no multi-auth account is visible yet. Refresh status once; if accountCount remains 0, rerun Authenticate Codex account."
        : loginAttemptPhase === "failed_after_device_code"
          ? failedAuthStartWarning
          : "No Codex multi-auth plugin accounts are configured yet. Normal OpenAI OAuth may exist, but Codex Multi-Auth model selections currently fall back to the normal OpenAI provider.",
    statusPhase: accountsConfigured ? "account_written" : loginAttemptPhase ?? "needs_plugin_account",
    usageSummary: parseCodexUsageSummary(limits.output),
    listOutput: list.output ?? list.error,
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
  const command = "cd /home/dev/repos/LLM-Experiments && node scripts/opencode-codex-multi-auth-profile.mjs login-headless"
  const existing = normalizeCodexMultiAuthLoginAttempt(readCodexMultiAuthLoginAttempt())
  const existingWaiting =
    existing?.phase === "waiting_for_device_approval" || existing?.phase === "waiting_for_browser_approval"
  if (
    existingWaiting &&
    existing.authorizationURL &&
    processIsRunning(existing.pid)
  ) {
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
      const phase =
        authFailure
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
    currentURL: typeof result?.currentURL === "string" ? result.currentURL : typeof result?.url === "string" ? result.url : null,
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

    yield* router.add("GET", "/experimental/workspace-suite/status", () =>
      Effect.promise(async () =>
        {
          const [openDesign, macView, routines, codexAccounts, workspaceIndex] = await Promise.all([
            statusWithTimeout<any>(
              "Open Design status",
              1000,
              { configured: false, proxyReady: true, proxyURL: "/experimental/open-design/proxy/", publicURL: "https://design.hustletogether.com" },
              openDesignStatus,
            ),
            statusWithTimeout<any>("Mac View status", 1500, { configured: false, mode: "read-only" }, macViewStatus),
            statusWithTimeout<any>("Routines status", 1000, { ok: false, routines: [] }, routinesStatus),
            statusWithTimeout<any>(
              "Codex multi-auth status",
              600,
              {
                ok: false,
                configured: true,
                accountCount: 0,
                accountsConfigured: false,
                sendRouting: "openai-fallback",
                warning: "Codex multi-auth summary is deferred. Open the Codex tab for direct status.",
              },
              codexMultiAuthStatus,
            ),
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
          codexAccounts,
          artifactRootConfigured: !!process.env.OPENCODE_BROWSER_HOME,
          agentChrome: liveBrowserGateStatus(),
          workspaceIndex,
        })
        },
      ),
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

    yield* router.add("POST", "/experimental/workspace-tabs/client-state", (request) =>
      Effect.gen(function* () {
        const raw = yield* Effect.orDie(request.text)
        const body = raw ? JSON.parse(raw) : {}
        return yield* Effect.promise(async () => HttpServerResponse.jsonUnsafe(updateWorkspaceTabsClientState(body as any)))
      }),
    )

    yield* router.add("GET", "/experimental/workspace-tabs/pending", (request) =>
      Effect.promise(async () => {
        const url = new URL(request.url, "http://localhost")
        return HttpServerResponse.jsonUnsafe(workspaceTabsPendingActions(url.searchParams.get("sessionID") || undefined))
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

    yield* router.add("GET", "/experimental/routines/status", () =>
      Effect.promise(async () => HttpServerResponse.jsonUnsafe(await routinesStatus())),
    )

    yield* router.add("GET", "/experimental/routines/jobs", () =>
      Effect.promise(async () => HttpServerResponse.jsonUnsafe(await routinesAction({ action: "list" }))),
    )

    yield* router.add("POST", "/experimental/routines/jobs", (request) =>
      Effect.gen(function* () {
        const raw = yield* Effect.orDie(request.text)
        let body: { name?: string; description?: string; schedule?: string; command?: string; tags?: string[]; notify?: string[] }
        try {
          body = JSON.parse(raw || "{}") as { name?: string; description?: string; schedule?: string; command?: string; tags?: string[]; notify?: string[] }
        } catch {
          return HttpServerResponse.text("Invalid JSON body", { status: 400 })
        }
        const result = yield* Effect.promise(() => createRoutineDraft(body))
        publishAppleBridgeEvent("routines", "routine.created", summarizeRoutineEvent("create", result))
        const error = result.ok ? undefined : (result as { error?: string }).error
        return HttpServerResponse.jsonUnsafe(result, { status: result.ok ? 200 : error?.includes("not enabled") ? 403 : 400 })
      }),
    )

    yield* router.add("PATCH", "/experimental/routines/jobs/:id", (request) =>
      Effect.gen(function* () {
        const id = decodeParam(request.url, /^\/experimental\/routines\/jobs\/([^/]+)$/)
        const raw = yield* Effect.orDie(request.text)
        type RoutineUpdateBody = {
          name?: string
          description?: string
          schedule?: string
          command?: string
          enabled?: boolean
          tags?: string[]
          notify?: string[]
        }
        let body: RoutineUpdateBody
        try {
          body = JSON.parse(raw || "{}") as RoutineUpdateBody
        } catch {
          return HttpServerResponse.text("Invalid JSON body", { status: 400 })
        }
        const result = yield* Effect.promise(() => routinesAction({ action: "update", id, ...body }))
        publishAppleBridgeEvent("routines", "routine.updated", summarizeRoutineEvent("update", result, id))
        const error = result.ok ? undefined : (result as { error?: string }).error
        return HttpServerResponse.jsonUnsafe(result, { status: result.ok ? 200 : error?.includes("not enabled") ? 403 : 400 })
      }),
    )

    yield* router.add("POST", "/experimental/routines/jobs/:id/run", (request) =>
      Effect.promise(async () => {
        const id = decodeParam(request.url, /^\/experimental\/routines\/jobs\/([^/]+)\/run$/)
        const result = await routinesAction({ action: "run", id })
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
        return HttpServerResponse.jsonUnsafe(result, { status: result.ok ? 200 : error?.includes("not enabled") ? 403 : 400 })
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
        const raw = request.method === "GET" || request.method === "HEAD" ? undefined : yield* Effect.orDie(request.text)
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
            restartRequired: body.transport === "webrtc" || body.bitrate !== undefined || body.width !== undefined || body.fps !== undefined,
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
const liveBrowserNoVNCURL = () => (process.env.OPENCODE_LIVE_BROWSER_NOVNC_URL || "http://127.0.0.1:6080").replace(/\/+$/, "")
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
        purpose: "Unified interactive Chromium surface for hosted routes, local project URLs, public websites, Open Design, and model browser tools.",
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

async function liveBrowserExposureAccess(request: { headers: Record<string, string | undefined> }): Promise<LiveBrowserAccess> {
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
      return liveBrowserAccessBlocked("invalid-cloudflare-token", "Cloudflare Access user is not allowlisted for Browser.")
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
  const compressionLevel = boundedInteger(params.get("compression") ?? process.env.OPENCODE_BROWSER_NOVNC_COMPRESSION, 0, 0, 9)
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
    mobile: { qualityLevel: 4, compressionLevel: 0, scaleViewport: false, resizeSession: false, clipViewport: true, dragViewport: true },
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

async function ensureLiveBrowser(): Promise<{ ok: true; pid?: number } | { ok: false; error: string }> {
  mkdirSync(liveBrowserProfile(), { recursive: true })
  mkdirSync(liveBrowserArtifacts(), { recursive: true })

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
      `--window-size=${viewport.width},${viewport.height}`,
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
  await fitLiveBrowserWindow().catch(() => undefined)
  return { ok: true, pid: child.pid }
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
        : "Cloudflare Access GitHub login is not configured in the running service environment. Do not expose Browser until Access AUD/team-domain env vars are set and verified.",
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
    routeReady: true,
    routeNote: "design.hustletogether.com routes to the Open Design daemon behind Cloudflare Access; the OpenCode tab uses the hosted route for the interactive app.",
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
    return withProxyHeaders(HttpServerResponse.text(rewriteOpenDesignText(html), { status: response.status, contentType: responseContentType }))
  }

  if (responseContentType.includes("text/css")) {
    const css = await response.text()
    return withProxyHeaders(HttpServerResponse.text(rewriteOpenDesignText(css), { status: response.status, contentType: responseContentType }))
  }

  if (
    responseContentType.includes("javascript") ||
    responseContentType.includes("application/json") ||
    responseContentType.includes("text/plain")
  ) {
    const body = await response.text()
    return withProxyHeaders(HttpServerResponse.text(rewriteOpenDesignText(body), { status: response.status, contentType: responseContentType }))
  }

  const bytes = new Uint8Array(await response.arrayBuffer())
  return withProxyHeaders(HttpServerResponse.uint8Array(bytes, { status: response.status, contentType: responseContentType }))
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
  const settings = macViewSettings()
  const fps = macViewFPS(url.searchParams.get("fps") || settings.fps)
  const width = clampNumber(url.searchParams.get("width") || settings.width, 640, 2048, settings.width)
  const bitrate = clampNumber(url.searchParams.get("bitrate") || settings.bitrate, 1000, 20000, settings.bitrate)
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
