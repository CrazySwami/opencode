// Interactivity for the OpenDesign mirror: send answers/controls back to OD's
// in-flight agent run through the CT100 proxy. This is the ONLY mirror module
// that mutates OD — everything else is read-only.
//
// Mechanism (from open-design/apps/web/src/providers/daemon.ts):
//   POST /api/runs/:id/tool-result   body { toolUseId, content, isError }
//     Answers Claude's AskUserQuestion tool: the card collects the user's pick,
//     formats it as one text string, and the daemon writes it as a JSONL line on
//     the still-open stdin so the agent resumes mid-call instead of erroring.
//   POST /api/runs/:id/cancel        cancels the run.
import { OD_PROXY_BASE } from "./open-design-mirror-types"

export type ODActionResult = { ok: boolean; status?: number; error?: string }

const TIMEOUT_MS = 8000

async function odPost(path: string, body?: unknown): Promise<ODActionResult> {
  if (typeof fetch === "undefined") return { ok: false, error: "no fetch" }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const resp = await fetch(`${OD_PROXY_BASE}${path}`, {
      method: "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    if (!resp.ok) return { ok: false, status: resp.status, error: `daemon ${resp.status}` }
    return { ok: true, status: resp.status }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "unreachable" }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Answer an in-flight OD `tool_use` (e.g. an AskUserQuestion brief card). `content`
 * is the answer already formatted as a single string (the card owns formatting).
 * A non-string `content` is coerced to a stable string so callers can pass a
 * structured pick without crashing. projectId/conversationId are accepted for
 * call-site clarity/telemetry but the daemon keys purely off runId + toolUseId.
 */
export async function answerOpenDesignToolUse(opts: {
  runId: string
  toolUseId: string
  content: unknown
  isError?: boolean
  projectId?: string
  conversationId?: string
}): Promise<ODActionResult> {
  const runId = typeof opts.runId === "string" ? opts.runId.trim() : ""
  const toolUseId = typeof opts.toolUseId === "string" ? opts.toolUseId.trim() : ""
  if (!runId || !toolUseId) return { ok: false, error: "missing runId or toolUseId" }
  const content =
    typeof opts.content === "string" ? opts.content : JSON.stringify(opts.content ?? "")
  return odPost(`/runs/${encodeURIComponent(runId)}/tool-result`, {
    toolUseId,
    content,
    isError: !!opts.isError,
  })
}

/** Cancel an OD run (mirror "stop" control). */
export async function cancelOpenDesignRun(opts: { runId: string }): Promise<ODActionResult> {
  const runId = typeof opts.runId === "string" ? opts.runId.trim() : ""
  if (!runId) return { ok: false, error: "missing runId" }
  return odPost(`/runs/${encodeURIComponent(runId)}/cancel`)
}
