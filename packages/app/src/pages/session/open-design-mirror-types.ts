// Shared contract for the OpenDesign mirror + its Phase-2 modules. Mirrors a
// subset of OD's PersistedAgentEvent (open-design/packages/contracts/src/api/chat.ts).

export const OPEN_DESIGN_BRIDGE_EVENT = "opencode:open-design-bridge-state"

// Base for reaching the OD daemon through the CT100 proxy (read-only history,
// SSE runs, and tool-result POSTs all hang off this).
export const OD_PROXY_BASE = "/experimental/open-design/proxy/api"

export type ODEvent =
  | { kind: "status"; label: string; detail?: string }
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; id: string; name: string; input?: unknown }
  | { kind: "tool_result"; toolUseId: string; content: string; isError?: boolean }
  | { kind: "usage"; inputTokens?: number; outputTokens?: number; costUsd?: number; durationMs?: number }
  | { kind: "image" | "file" | "live_artifact" | "live_artifact_refresh" | "raw"; [k: string]: unknown }

export type ODMessage = {
  id: string
  role: "user" | "assistant"
  content: string
  agentName?: string
  events?: ODEvent[]
  runStatus?: "queued" | "running" | "succeeded" | "failed" | "canceled"
  createdAt?: number
  // Present on assistant messages with an active/last run — needed for SSE
  // reattach + tool-result POSTs (Phase 2).
  runId?: string
  lastRunEventId?: string
}

export type ODBridgeState =
  | {
      active?: boolean
      acceptsPrompts?: boolean
      projectId?: string
      projectName?: string
      activeConversationId?: string | null
      conversations?: { id: string; title?: string | null }[]
      chatId?: string | null
      chatName?: string | null
    }
  | undefined
