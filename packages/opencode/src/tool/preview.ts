import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./preview.txt"
import { captureBrowserScreenshot, runBrowserAction, type BrowserActionInput } from "./browser"
import { publishAppleBridgeEvent } from "./ios-bridge-events"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { sessionPaths } from "./browser"

const actions = [
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
] as const

const PREVIEW_MODE = "preview-playwright" as const

export const Parameters = Schema.Struct({
  action: Schema.Literals(actions).annotate({
    description: "Preview action to run against the session-scoped lightweight preview browser.",
  }),
  url: Schema.optional(Schema.String).annotate({
    description: "URL for preview.navigate. Use this for local apps, hosted internal tools, OpenDesign, dashboard URLs, and file routes.",
  }),
  selector: Schema.optional(Schema.String).annotate({
    description: "CSS selector or element target for click, fill, submit, inspect, or dom actions.",
  }),
  x: Schema.optional(Schema.Number).annotate({
    description: "Viewport X coordinate for click-point actions.",
  }),
  y: Schema.optional(Schema.Number).annotate({
    description: "Viewport Y coordinate for click-point actions.",
  }),
  text: Schema.optional(Schema.String).annotate({
    description: "Text for fill and type actions.",
  }),
  key: Schema.optional(Schema.String).annotate({
    description: "Key name for key actions.",
  }),
  deltaX: Schema.optional(Schema.Number).annotate({
    description: "Horizontal wheel delta for scroll.",
  }),
  deltaY: Schema.optional(Schema.Number).annotate({
    description: "Vertical wheel delta for scroll.",
  }),
  json: Schema.optional(Schema.Boolean)
    .annotate({ description: "Request JSON output where supported. Defaults to true for inspection actions." })
    .pipe(Schema.withDecodingDefault(Effect.succeed(true))),
})

type PreviewParams = Schema.Schema.Type<typeof Parameters>

type Metadata = {
  action: PreviewParams["action"]
  previewSessionID: string
  browserSessionID?: string
  profileDir?: string
  artifactDir?: string
  screenshotPath?: string
  screenshotURL?: string
  mode: typeof PREVIEW_MODE
}

export type PreviewSurfaceState = {
  ok: true
  mode: typeof PREVIEW_MODE
  previewSessionID: string
  browserSessionID?: string
  url?: string
  action?: PreviewParams["action"]
  mappedBrowserAction?: BrowserActionInput["action"]
  artifactURL?: string
  screenshotPath?: string
  screenshotURL?: string
  updatedAt: string
  source: "tool" | "client" | "unknown"
  note: string
}

export function readPreviewSurfaceState(sessionID: string): PreviewSurfaceState {
  const paths = sessionPaths(sessionID)
  const fallback: PreviewSurfaceState = {
    ok: true,
    mode: PREVIEW_MODE,
    previewSessionID: sessionID,
    updatedAt: new Date(0).toISOString(),
    source: "unknown",
    note: "No preview state has been recorded for this session yet.",
  }
  try {
    const file = path.join(paths.sessionDir, "preview-state.json")
    if (!existsSync(file)) return fallback
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<PreviewSurfaceState>
    return {
      ...fallback,
      ...parsed,
      ok: true,
      mode: PREVIEW_MODE,
      previewSessionID: sessionID,
      note: parsed.note ?? "Preview state is shared between the visible Preview tab and the preview tool.",
    }
  } catch {
    return fallback
  }
}

export function writePreviewSurfaceState(
  sessionID: string,
  patch: Partial<Omit<PreviewSurfaceState, "ok" | "mode" | "previewSessionID" | "updatedAt">>,
) {
  const paths = sessionPaths(sessionID)
  mkdirSync(paths.sessionDir, { recursive: true })
  const next: PreviewSurfaceState = {
    ...readPreviewSurfaceState(sessionID),
    ...patch,
    ok: true,
    mode: PREVIEW_MODE,
    previewSessionID: sessionID,
    updatedAt: new Date().toISOString(),
    note: patch.note ?? "Preview state is shared between the visible Preview tab and the preview tool.",
  }
  writeFileSync(path.join(paths.sessionDir, "preview-state.json"), JSON.stringify(next, null, 2))
  return next
}

export async function runPreviewAction(
  sessionID: string,
  params: PreviewParams,
  signal: AbortSignal,
  source: PreviewSurfaceState["source"] = "tool",
) {
  if (params.action === "attach" || params.action === "screenshot") {
    const shot = await captureBrowserScreenshot(sessionID, signal)
    const state = writePreviewSurfaceState(sessionID, {
      action: params.action,
      browserSessionID: shot.browserSessionID,
      screenshotPath: shot.screenshotPath,
      screenshotURL: shot.screenshotURL,
      source,
    })
    publishAppleBridgeEvent("preview", "preview.snapshot.ready", {
      ok: true,
      action: params.action,
      previewSessionID: sessionID,
      browserSessionID: shot.browserSessionID,
      screenshotURL: shot.screenshotURL,
      updatedAt: state.updatedAt,
      hasAttachment: existsSync(shot.screenshotPath),
    })
    return {
      ok: true,
      mode: PREVIEW_MODE,
      action: params.action,
      previewSessionID: sessionID,
      browserSessionID: shot.browserSessionID,
      screenshotPath: shot.screenshotPath,
      screenshotURL: shot.screenshotURL,
      previewStateURL: `/experimental/preview/${encodeURIComponent(sessionID)}/state`,
      state,
    }
  }

  const input = previewToBrowserAction(params)
  const result = await runBrowserAction(sessionID, input, signal)
  const state = writePreviewSurfaceState(sessionID, {
    action: params.action,
    mappedBrowserAction: input.action,
    ...(params.action === "navigate" ? { url: params.url } : {}),
    browserSessionID: result.browserSessionID,
    artifactURL: result.artifactURL,
    source,
  })
  publishAppleBridgeEvent("preview", "preview.action.completed", {
    ok: true,
    action: params.action,
    previewSessionID: sessionID,
    browserSessionID: result.browserSessionID,
    mappedBrowserAction: input.action,
    url: params.action === "navigate" ? params.url : undefined,
    selector: params.selector,
    hasText: typeof params.text === "string" && params.text.length > 0,
    artifactURL: result.artifactURL,
    updatedAt: state.updatedAt,
  })
  return {
    ok: true,
    mode: PREVIEW_MODE,
    action: params.action,
    mappedBrowserAction: input.action,
    previewSessionID: sessionID,
    browserSessionID: result.browserSessionID,
    output: result.output,
    artifactURL: result.artifactURL,
    previewStateURL: `/experimental/preview/${encodeURIComponent(sessionID)}/state`,
    state,
  }
}

export const PreviewTool = Tool.define<typeof Parameters, Metadata, never>(
  "preview",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: PreviewParams, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "browser",
            patterns: [`preview.${params.action}`],
            always: ["snapshot", "accessibility", "dom", "inspect"],
            metadata: {
              action: params.action,
              url: params.url,
              selector: params.selector,
            },
          })

          if (params.action === "attach" || params.action === "screenshot") {
            const result = yield* Effect.promise(() => runPreviewAction(ctx.sessionID, params, ctx.abort, "tool"))
            const attachments =
              typeof result.screenshotPath === "string" && existsSync(result.screenshotPath)
                ? [
                    {
                      type: "file" as const,
                      mime: "image/png",
                      url: `data:image/png;base64,${Buffer.from(readFileSync(result.screenshotPath)).toString("base64")}`,
                    },
                  ]
                : undefined
            return {
              title: `preview ${params.action}`,
              output: JSON.stringify(
                {
                  ok: true,
                  mode: PREVIEW_MODE,
                  screenshotPath: result.screenshotPath,
                  screenshotURL: result.screenshotURL,
                  previewStateURL: `/experimental/preview/${encodeURIComponent(ctx.sessionID)}/state`,
                  note: "Preview screenshot captured and attached when supported by the client.",
                },
                null,
                2,
              ),
              attachments,
              metadata: {
                action: params.action,
                previewSessionID: ctx.sessionID,
                browserSessionID: result.browserSessionID,
                screenshotPath: result.screenshotPath,
                screenshotURL: result.screenshotURL,
                mode: PREVIEW_MODE,
              },
            }
          }

          const result = yield* Effect.promise(() => runPreviewAction(ctx.sessionID, params, ctx.abort, "tool"))
          return {
            title: `preview ${params.action}`,
            output: JSON.stringify(
              {
                ok: true,
                mode: PREVIEW_MODE,
                action: params.action,
                mappedBrowserAction: result.mappedBrowserAction,
                output: result.output,
                artifactURL: result.artifactURL,
                previewStateURL: `/experimental/preview/${encodeURIComponent(ctx.sessionID)}/state`,
              },
              null,
              2,
            ),
            metadata: {
              action: params.action,
              previewSessionID: ctx.sessionID,
              browserSessionID: result.browserSessionID,
              mode: PREVIEW_MODE,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

function previewToBrowserAction(params: PreviewParams): BrowserActionInput {
  switch (params.action) {
    case "navigate":
      return { action: "open", url: required(params.url, "url"), json: false }
    case "snapshot":
    case "accessibility":
    case "dom":
      return { action: "snapshot", target: params.selector, json: params.json }
    case "inspect":
      return { action: "snapshot", target: params.selector, json: params.json }
    case "click":
      return { action: "click", target: required(params.selector, "selector"), json: false }
    case "click-point":
      return { action: "click-point", x: requiredNumber(params.x, "x"), y: requiredNumber(params.y, "y"), json: false }
    case "fill":
      return {
        action: "fill",
        target: required(params.selector, "selector"),
        text: required(params.text, "text"),
        json: false,
      }
    case "submit":
      return {
        action: "press",
        target: params.selector,
        text: "Enter",
        json: false,
      }
    case "scroll":
      return { action: "scroll", deltaX: params.deltaX ?? 0, deltaY: params.deltaY ?? 600, json: false }
    case "type":
      return { action: "type", text: required(params.text, "text"), json: false }
    case "key":
      return { action: "press", text: required(params.key ?? params.text, "key"), json: false }
    case "reload":
      return { action: "reload", json: false }
    case "screenshot":
    case "attach":
      throw new Error("preview screenshot actions are handled before browser action mapping")
  }
}

function required(value: string | undefined, name: string) {
  if (value?.trim()) return value.trim()
  throw new Error(`preview.${name} is required for this action`)
}

function requiredNumber(value: number | undefined, name: string) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  throw new Error(`preview.${name} is required for this action`)
}
