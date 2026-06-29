import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./file-browser.txt"
import { existsSync, readdirSync, statSync } from "node:fs"
import path from "node:path"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["roots", "list", "stat"]).annotate({ description: "File browser action." }),
  path: Schema.optional(Schema.String).annotate({ description: "Absolute path inside an allowlisted root." }),
})

type Metadata = {
  action: "roots" | "list" | "stat"
  path?: string
}

export const FileBrowserTool = Tool.define<typeof Parameters, Metadata, never>(
  "file_browser",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>) =>
        Effect.gen(function* () {
          const body = executeFileBrowser(params)
          return {
            title: `file_browser ${params.action}`,
            output: JSON.stringify(body, null, 2),
            metadata: {
              action: params.action,
              path: params.path,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

type FileBrowserParams = Schema.Schema.Type<typeof Parameters>

function executeFileBrowser(params: FileBrowserParams) {
  if (params.action === "roots") return { roots: fileRoots(), defaultPath: defaultPath() }

  const target = path.resolve(params.path || defaultPath())
  assertAllowed(target)
  const stat = statSync(target, { throwIfNoEntry: false })
  if (!stat) throw new Error(`Path not found: ${target}`)

  if (params.action === "stat") {
    return {
      path: target,
      kind: stat.isDirectory() ? "directory" : fileKind(contentTypeForFile(target)),
      size: stat.isDirectory() ? null : stat.size,
      mtime: stat.mtime.toISOString(),
      url: stat.isDirectory() ? null : `/experimental/files/view?path=${encodeURIComponent(target)}`,
    }
  }

  if (!stat.isDirectory()) throw new Error(`Path is not a directory: ${target}`)
  return {
    path: target,
    parent: parentDirectory(target),
    roots: fileRoots(),
    entries: readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
      const entryPath = path.join(target, entry.name)
      const entryStat = statSync(entryPath, { throwIfNoEntry: false })
      if (!entryStat) return []
      const isDirectory = entry.isDirectory()
      const contentType = isDirectory ? null : contentTypeForFile(entryPath)
      return [
        {
          name: entry.name,
          path: entryPath,
          kind: isDirectory ? "directory" : fileKind(contentType ?? ""),
          contentType,
          size: isDirectory ? null : entryStat.size,
          mtime: entryStat.mtime.toISOString(),
          url: isDirectory ? null : `/experimental/files/view?path=${encodeURIComponent(entryPath)}`,
        },
      ]
    }),
  }
}

function fileRoots() {
  const explicit = process.env.OPENCODE_FILE_VIEW_ROOTS?.split(path.delimiter).filter(Boolean) ?? []
  const browserHome =
    process.env.OPENCODE_BROWSER_HOME || path.join(process.env.HOME ?? "/home/dev", ".local", "share", "opencode-browser")
  return [...explicit, browserHome, process.env.OPENCODE_DEV_ROOT ?? "/home/dev/repos"]
    .map((root) => path.resolve(root))
    .filter((root, index, list) => list.indexOf(root) === index)
}

function defaultPath() {
  const configured = process.env.OPENCODE_FILE_BROWSER_ROOT
  if (configured) return configured
  const opencode = "/home/dev/repos/opencode"
  if (existsSync(opencode)) return opencode
  return fileRoots()[0] ?? process.cwd()
}

function assertAllowed(target: string) {
  const resolved = path.resolve(target)
  if (fileRoots().some((root) => resolved === root || resolved.startsWith(root + path.sep))) return
  throw new Error(`Path is outside allowlisted file browser roots: ${target}`)
}

function parentDirectory(directory: string) {
  const parent = path.dirname(directory)
  if (parent === directory) return null
  return fileRoots().some((root) => parent === root || parent.startsWith(root + path.sep)) ? parent : null
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

function fileKind(contentType: string) {
  if (contentType.startsWith("image/")) return "image"
  if (contentType.startsWith("video/")) return "video"
  if (contentType.startsWith("audio/")) return "audio"
  if (contentType === "application/pdf") return "pdf"
  if (contentType.startsWith("text/") || contentType === "application/json") return "text"
  return "file"
}
