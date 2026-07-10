import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./image-gen.txt"
import { generateImage } from "./image-gen"

export const Parameters = Schema.Struct({
  prompt: Schema.String.annotate({ description: "Description of the image to generate." }),
  provider: Schema.optional(Schema.Literals(["local", "recraft", "gemini"])).annotate({
    description:
      "Preferred image provider. Falls back to the first available provider (local hub, then Recraft, then Gemini) if omitted or unavailable.",
  }),
  size: Schema.optional(Schema.String).annotate({
    description: "Optional image size, e.g. '768x768' or '1024x1024'. Provider-dependent.",
  }),
})

type Metadata = {
  provider?: string
  ok: boolean
}

export const ImageGenTool = Tool.define(
  "image_gen",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "image_gen",
            patterns: [params.prompt],
            always: ["*"],
            metadata: {
              prompt: params.prompt,
              provider: params.provider,
              size: params.size,
            },
          })

          const result = yield* Effect.promise(() =>
            generateImage({
              prompt: params.prompt,
              provider: params.provider,
              size: params.size,
            }),
          )

          if (!result.ok) {
            return {
              title: "image_gen failed",
              output: `Image generation failed: ${result.error}`,
              metadata: { provider: result.provider, ok: false },
            }
          }

          const url = result.dataUri ?? result.url
          if (!url) {
            return {
              title: "image_gen failed",
              output: "Image generation reported success but returned no image data.",
              metadata: { provider: result.provider, ok: false },
            }
          }

          return {
            title: `image_gen (${result.provider})`,
            output: `Generated an image using the ${result.provider} provider.`,
            metadata: { provider: result.provider, ok: true },
            attachments: [
              {
                type: "file" as const,
                mime: "image/png",
                url,
              },
            ],
          }
        }).pipe(Effect.orDie),
    }
  }),
)
