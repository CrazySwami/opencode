import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./open-design.txt"

const actions = [
  "health",
  "list-projects",
  "get-project",
  "list-files",
  "get-file",
  "search-files",
  "list-conversations",
  "create-conversation",
  "get-messages",
  "run-prompt",
  "write-file",
  "create-artifact",
  "delete-file",
] as const

export const Parameters = Schema.Struct({
  action: Schema.Literals(actions).annotate({ description: "Open Design action to run." }),
  project: Schema.optional(Schema.String).annotate({
    description: "Open Design project id or name. Required for project-scoped actions.",
  }),
  conversation: Schema.optional(Schema.String).annotate({
    description: "Open Design conversation/chat id. Required for get-messages and optional for run-prompt.",
  }),
  path: Schema.optional(Schema.String).annotate({ description: "Project-relative file path." }),
  query: Schema.optional(Schema.String).annotate({ description: "Search query for search-files." }),
  content: Schema.optional(Schema.String).annotate({ description: "File content for write/create actions." }),
  title: Schema.optional(Schema.String).annotate({ description: "Conversation title for create-conversation." }),
  message: Schema.optional(Schema.String).annotate({ description: "Prompt message for run-prompt." }),
  agent: Schema.optional(Schema.String).annotate({
    description: "Open Design agent id for run-prompt (default codex, the lane bridged to Codex Multi-Auth).",
  }),
})

type Metadata = {
  action: (typeof actions)[number]
  daemonURL: string
  project?: string
  conversation?: string
  path?: string
  status?: number
}

export const OpenDesignTool = Tool.define<typeof Parameters, Metadata, never>(
  "open_design",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (isMutating(params.action)) {
            yield* ctx.ask({
              permission: "open_design",
              patterns: [params.action],
              always: ["health", "list-projects", "get-project", "list-files", "get-file", "search-files"],
              metadata: {
                action: params.action,
                project: params.project,
                path: params.path,
                conversation: params.conversation,
              },
            })
          }

          const client = openDesignClient()
          const result = yield* Effect.promise(() => executeOpenDesignAction(client, params))
          return {
            title: `open_design ${params.action}`,
            output: JSON.stringify(result.body, null, 2),
            metadata: {
              action: params.action,
              daemonURL: client.publicDaemonURL,
              project: params.project,
              conversation: params.conversation,
              path: params.path,
              status: result.status,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

type Client = ReturnType<typeof openDesignClient>
type OpenDesignParams = Schema.Schema.Type<typeof Parameters>

function openDesignClient() {
  const daemonURL =
    process.env.OD_DAEMON_URL ||
    process.env.OPENCODE_OPEN_DESIGN_DAEMON_URL ||
    process.env.OPENCODE_OPEN_DESIGN_URL ||
    "http://127.0.0.1:7456"
  const token = process.env.OD_API_TOKEN || process.env.OPENCODE_OPEN_DESIGN_TOKEN
  return {
    daemonURL: daemonURL.replace(/\/+$/, ""),
    publicDaemonURL: daemonURL.replace(/\/+$/, ""),
    token,
  }
}

function isMutating(action: OpenDesignParams["action"]) {
  return action === "create-conversation" || action === "run-prompt" || action === "write-file" || action === "create-artifact" || action === "delete-file"
}

async function executeOpenDesignAction(client: Client, params: OpenDesignParams) {
  switch (params.action) {
    case "health":
      return request(client, "/api/health")
    case "list-projects":
      return request(client, "/api/projects")
    case "get-project":
      return request(client, `/api/projects/${encodeURIComponent(required(params.project, "project"))}`)
    case "list-files":
      return request(client, `/api/projects/${encodeURIComponent(required(params.project, "project"))}/files`)
    case "get-file":
      return request(
        client,
        `/api/projects/${encodeURIComponent(required(params.project, "project"))}/raw/${encodePath(required(params.path, "path"))}`,
        { parseText: true },
      )
    case "search-files":
      return searchFiles(client, required(params.project, "project"), required(params.query, "query"))
    case "list-conversations":
      return request(client, `/api/projects/${encodeURIComponent(required(params.project, "project"))}/conversations`)
    case "create-conversation":
      return request(client, `/api/projects/${encodeURIComponent(required(params.project, "project"))}/conversations`, {
        method: "POST",
        body: { title: params.title ?? "OpenCode Design Mode" },
      })
    case "get-messages":
      return request(
        client,
        `/api/projects/${encodeURIComponent(required(params.project, "project"))}/conversations/${encodeURIComponent(required(params.conversation, "conversation"))}/messages`,
      )
    case "run-prompt":
      // The daemon fails runs with AGENT_UNAVAILABLE when agentId is omitted.
      return request(client, "/api/runs", {
        method: "POST",
        body: compact({
          projectId: required(params.project, "project"),
          conversationId: params.conversation,
          agentId: params.agent || "codex",
          message: required(params.message, "message"),
        }),
      })
    case "write-file":
    case "create-artifact":
      return request(client, `/api/projects/${encodeURIComponent(required(params.project, "project"))}/files`, {
        method: "POST",
        body: { name: required(params.path, "path"), content: required(params.content, "content") },
      })
    case "delete-file":
      return request(
        client,
        `/api/projects/${encodeURIComponent(required(params.project, "project"))}/files/${encodePath(required(params.path, "path"))}`,
        { method: "DELETE" },
      )
  }
}

async function searchFiles(client: Client, project: string, query: string) {
  const files = await request(client, `/api/projects/${encodeURIComponent(project)}/files`)
  const list = Array.isArray(files.body?.files) ? files.body.files : []
  const matches: Array<{ path: string; line: number; snippet: string }> = []
  for (const file of list.slice(0, 200)) {
    const filePath = typeof file.path === "string" ? file.path : file.name
    if (typeof filePath !== "string") continue
    if (!isLikelyText(file)) continue
    const raw = await request(client, `/api/projects/${encodeURIComponent(project)}/raw/${encodePath(filePath)}`, {
      parseText: true,
    }).catch(() => undefined)
    const text = typeof raw?.body?.text === "string" ? raw.body.text : ""
    const lines = text.split(/\r?\n/)
    lines.forEach((line: string, index: number) => {
      if (matches.length >= 50) return
      if (line.toLowerCase().includes(query.toLowerCase())) {
        matches.push({ path: filePath, line: index + 1, snippet: line.slice(0, 240) })
      }
    })
  }
  return { status: files.status, body: { matches } }
}

function isLikelyText(file: any) {
  const mime = String(file?.mime ?? "")
  const kind = String(file?.kind ?? "")
  return mime.startsWith("text/") || ["html", "text", "code", "document"].includes(kind)
}

async function request(
  client: Client,
  path: string,
  options: { method?: string; body?: unknown; parseText?: boolean } = {},
) {
  const headers: Record<string, string> = {}
  if (client.token) headers.authorization = `Bearer ${client.token}`
  if (options.body !== undefined) headers["content-type"] = "application/json"
  const response = await fetch(`${client.daemonURL}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const contentType = response.headers.get("content-type") ?? ""
  const body =
    options.parseText || !contentType.includes("application/json")
      ? { text: await response.text() }
      : await response.json()
  if (!response.ok) throw new Error(`Open Design request failed ${response.status}: ${JSON.stringify(body)}`)
  return { status: response.status, body }
}

function encodePath(value: string) {
  return value
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/")
}

function required(value: string | undefined, name: string) {
  if (value) return value
  throw new Error(`open_design.${name} is required for this action`)
}

function compact(input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== null && value !== ""))
}
