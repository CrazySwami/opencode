import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./artifact.txt"
import { sessionPaths } from "./browser"
import { existsSync, readdirSync, statSync } from "node:fs"
import path from "node:path"

export const Parameters = Schema.Struct({
  action: Schema.Literal("list").annotate({ description: "List session artifacts." }),
})

type Metadata = {
  artifactDir: string
  count: number
}

export const ArtifactTool = Tool.define<typeof Parameters, Metadata, never>(
  "artifact",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (_params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const paths = sessionPaths(ctx.sessionID)
          const files = listFiles(paths.artifactDir)
          return {
            title: "artifact list",
            output: JSON.stringify({ browserSessionID: paths.browserSessionID, artifactDir: paths.artifactDir, files }, null, 2),
            metadata: {
              artifactDir: paths.artifactDir,
              count: files.length,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

function listFiles(dir: string) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .flatMap((name) => {
      const file = path.join(dir, name)
      const stat = statSync(file, { throwIfNoEntry: false })
      if (!stat?.isFile()) return []
      return [
        {
          name,
          path: file,
          size: stat.size,
          mtime: stat.mtime.toISOString(),
          kind: name.toLowerCase().endsWith(".png") ? "image" : "file",
        },
      ]
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime))
}
