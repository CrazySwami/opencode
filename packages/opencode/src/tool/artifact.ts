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
          const files = listFiles(paths.artifactDir, ctx.sessionID)
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

function listFiles(dir: string, sessionID: string) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .flatMap((name) => {
      const file = path.join(dir, name)
      const stat = statSync(file, { throwIfNoEntry: false })
      if (!stat?.isFile()) return []
      const contentType = contentTypeForFile(name)
      return [
        {
          name,
          path: file,
          size: stat.size,
          mtime: stat.mtime.toISOString(),
          contentType,
          kind: fileKind(contentType),
          url: `/experimental/browser/${encodeURIComponent(sessionID)}/artifacts/${encodeURIComponent(name)}`,
        },
      ]
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime))
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
