import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./file-browser.txt"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["roots", "list", "browse", "stat", "metadata", "search", "preview", "project"]).annotate({
    description:
      "File browser action. roots=list allowlisted roots; list/browse=directory entries; stat/metadata=file/dir metadata; search=recursive name match under a path; preview=bounded text/image preview. open_viewer/open_editor/attach_to_chat are UI actions routed via workspace_tabs, not this read-only tool.",
  }),
  path: Schema.optional(Schema.String).annotate({ description: "Absolute path inside an allowlisted root." }),
  query: Schema.optional(Schema.String).annotate({ description: "Name substring to match for the search action." }),
  limit: Schema.optional(Schema.Number).annotate({ description: "Max results for search (default 100, cap 500)." }),
})

type Metadata = {
  action: "roots" | "list" | "browse" | "stat" | "metadata" | "search" | "preview" | "project"
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

const PREVIEW_MAX_BYTES = 64 * 1024
const SEARCH_SKIP = new Set(["node_modules", ".git", ".next", "dist", "build", ".cache", ".turbo"])

const PROJECT_METADATA_REL = path.join(".opencode", "design", "project.json")

function executeFileBrowser(params: FileBrowserParams) {
  if (params.action === "roots") return { roots: fileRoots(), defaultPath: defaultPath() }

  if (params.action === "project") {
    const start = path.resolve(params.path || defaultPath())
    assertAllowed(start)
    const startStat = statSync(start, { throwIfNoEntry: false })
    let dir = startStat?.isDirectory() ? start : path.dirname(start)
    const searched: string[] = []
    for (let i = 0; i < 12; i++) {
      const resolvedDir = path.resolve(dir)
      if (!fileRoots().some((root) => resolvedDir === root || resolvedDir.startsWith(root + path.sep))) break
      const candidate = path.join(dir, PROJECT_METADATA_REL)
      searched.push(candidate)
      const stat = statSync(candidate, { throwIfNoEntry: false })
      if (stat?.isFile()) {
        try {
          return { present: true, repoRoot: dir, metadataPath: candidate, metadata: JSON.parse(readFileSync(candidate, "utf8")) }
        } catch (error) {
          return { present: false, repoRoot: dir, metadataPath: candidate, reason: `invalid json: ${(error as Error).message}` }
        }
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return { present: false, repoRoot: startStat?.isDirectory() ? start : path.dirname(start), searched }
  }

  const target = path.resolve(params.path || defaultPath())
  assertAllowed(target)
  const stat = statSync(target, { throwIfNoEntry: false })
  if (!stat) throw new Error(`Path not found: ${target}`)

  if (params.action === "stat" || params.action === "metadata") {
    return {
      path: target,
      name: path.basename(target),
      kind: stat.isDirectory() ? "directory" : fileKind(contentTypeForFile(target)),
      contentType: stat.isDirectory() ? null : contentTypeForFile(target),
      size: stat.isDirectory() ? null : stat.size,
      mtime: stat.mtime.toISOString(),
      url: stat.isDirectory() ? null : `/experimental/files/view?path=${encodeURIComponent(target)}`,
    }
  }

  if (params.action === "search") {
    const needle = String(params.query || "").trim().toLowerCase()
    if (!needle) throw new Error("search requires a query")
    const root = stat.isDirectory() ? target : parentDirectory(target) || target
    const cap = Math.min(Math.max(1, Number(params.limit) || 100), 500)
    const results: Array<Record<string, unknown>> = []
    const walk = (dir: string, depth: number) => {
      if (results.length >= cap || depth > 6) return
      let entries: import("node:fs").Dirent[]
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (results.length >= cap) return
        if (entry.name.startsWith(".") && SEARCH_SKIP.has(entry.name)) continue
        const entryPath = path.join(dir, entry.name)
        const isDir = entry.isDirectory()
        if (entry.name.toLowerCase().includes(needle)) {
          const ct = isDir ? null : contentTypeForFile(entryPath)
          results.push({
            name: entry.name,
            path: entryPath,
            kind: isDir ? "directory" : fileKind(ct ?? ""),
            url: isDir ? null : `/experimental/files/view?path=${encodeURIComponent(entryPath)}`,
          })
        }
        if (isDir && !SEARCH_SKIP.has(entry.name)) walk(entryPath, depth + 1)
      }
    }
    walk(root, 0)
    return { root, query: needle, truncated: results.length >= cap, count: results.length, results }
  }

  if (params.action === "preview") {
    if (stat.isDirectory()) throw new Error("preview requires a file path")
    const contentType = contentTypeForFile(target)
    const kind = fileKind(contentType)
    const base = {
      path: target,
      name: path.basename(target),
      kind,
      contentType,
      size: stat.size,
      url: `/experimental/files/view?path=${encodeURIComponent(target)}`,
    }
    if (kind === "text" || kind === "json" || contentType === "text/html") {
      const buffer = readFileSync(target)
      const slice = buffer.subarray(0, PREVIEW_MAX_BYTES)
      return { ...base, previewKind: "text", truncated: buffer.length > PREVIEW_MAX_BYTES, text: slice.toString("utf8") }
    }
    // Binary/media: expose the safe view URL for the UI/LLM, not raw bytes here.
    return { ...base, previewKind: kind === "image" || kind === "video" || kind === "audio" || kind === "pdf" ? kind : "binary" }
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
  if (contentType === "text/html") return "html"
  if (contentType === "application/json") return "json"
  if (contentType.startsWith("text/")) return "text"
  return "file"
}
