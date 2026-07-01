import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./preview.txt"
import { captureBrowserScreenshot, runBrowserAction, type BrowserActionInput } from "./browser"
import { existsSync, readFileSync } from "node:fs"

const actions = [
  "navigate",
  "snapshot",
  "screenshot",
  "accessibility",
  "dom",
  "inspect",
  "click",
  "fill",
  "submit",
  "scroll",
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
  text: Schema.optional(Schema.String).annotate({
    description: "Text for fill actions.",
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
            const shot = yield* Effect.promise(() => captureBrowserScreenshot(ctx.sessionID, ctx.abort))
            const attachments =
              existsSync(shot.screenshotPath)
                ? [
                    {
                      type: "file" as const,
                      mime: "image/png",
                      url: `data:image/png;base64,${Buffer.from(readFileSync(shot.screenshotPath)).toString("base64")}`,
                    },
                  ]
                : undefined
            return {
              title: `preview ${params.action}`,
              output: JSON.stringify(
                {
                  ok: true,
                  mode: PREVIEW_MODE,
                  screenshotPath: shot.screenshotPath,
                  screenshotURL: shot.screenshotURL,
                  note: "Preview screenshot captured and attached when supported by the client.",
                },
                null,
                2,
              ),
              attachments,
              metadata: {
                action: params.action,
                previewSessionID: ctx.sessionID,
                browserSessionID: shot.browserSessionID,
                profileDir: shot.profileDir,
                artifactDir: shot.artifactDir,
                screenshotPath: shot.screenshotPath,
                screenshotURL: shot.screenshotURL,
                mode: PREVIEW_MODE,
              },
            }
          }

          const input = previewToBrowserAction(params)
          const result = yield* Effect.promise(() => runBrowserAction(ctx.sessionID, input, ctx.abort))
          return {
            title: `preview ${params.action}`,
            output: JSON.stringify(
              {
                ok: true,
                mode: PREVIEW_MODE,
                action: params.action,
                mappedBrowserAction: input.action,
                output: result.output,
                artifactURL: result.artifactURL,
              },
              null,
              2,
            ),
            metadata: {
              action: params.action,
              previewSessionID: ctx.sessionID,
              browserSessionID: result.browserSessionID,
              profileDir: result.profileDir,
              artifactDir: result.artifactDir,
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
    case "screenshot":
    case "attach":
      throw new Error("preview screenshot actions are handled before browser action mapping")
  }
}

function required(value: string | undefined, name: string) {
  if (value?.trim()) return value.trim()
  throw new Error(`preview.${name} is required for this action`)
}
