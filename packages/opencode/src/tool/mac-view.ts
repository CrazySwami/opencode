import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./mac-view.txt"

export const Parameters = Schema.Struct({
  action: Schema.Literal("status").annotate({ description: "Only status is supported for the read-only Mac View MVP." }),
})

type Metadata = {
  configured: boolean
  feedURL?: string
}

export const MacViewTool = Tool.define<typeof Parameters, Metadata, never>(
  "mac_view",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: () =>
        Effect.gen(function* () {
          const feedURL = process.env.OPENCODE_MAC_VIEW_URL
          const body = {
            configured: !!feedURL,
            feedURL: feedURL ?? null,
            mode: "read-only",
            note: feedURL
              ? "Mac View feed URL is configured. The OpenCode tab can poll its snapshot endpoint."
              : "Set OPENCODE_MAC_VIEW_URL to a ScreenCaptureKit helper endpoint to enable live Mac View.",
          }
          return {
            title: "mac_view status",
            output: JSON.stringify(body, null, 2),
            metadata: {
              configured: !!feedURL,
              ...(feedURL ? { feedURL } : {}),
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
