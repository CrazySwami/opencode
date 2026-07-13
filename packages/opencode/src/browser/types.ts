/**
 * Shared contracts for the neko + Steel remote browser stack clients.
 *
 * Unlike the read-only Trellis bridge, these clients are LIVE-ONLY (no fixtures):
 * a browser you can't reach is simply unavailable. Every method still resolves to
 * a discriminated result and NEVER throws, so a down/misbehaving stack degrades
 * gracefully instead of corrupting a session. Any auth (neko member password,
 * Steel API token) is read server-side and never returned to a caller.
 */
export type BrowserResult<T> = { ok: true; data: T } | { ok: false; error: string }

// --- neko (shared interactive browser, driven over CDP) ----------------------
export interface NekoHealth {
  browser: string
  protocolVersion: string | null
  /** Whether OPENCODE_NEKO_URL (the WebRTC viewer) is configured. */
  viewerConfigured: boolean
  /** The CDP base OpenCode is driving (never includes credentials). */
  cdpUrl: string
}

export interface NekoTarget {
  id: string
  type: string
  title: string
  url: string
  /** webSocketDebuggerUrl with its host rewritten to the reachable CDP host. */
  webSocketDebuggerUrl: string | null
}

// --- Steel (headless automation lane) ----------------------------------------
export interface SteelHealth {
  ok: boolean
  apiUrl: string
  /** Steel's embeddable viewer, if configured (OPENCODE_STEEL_VIEWER_URL). */
  viewerUrl: string | null
}

export interface SteelSession {
  id: string
  status: string | null
  /** CDP websocket for driving the session, if Steel returned one. */
  websocketUrl: string | null
  /** Steel's live session viewer URL, if any. */
  sessionViewerUrl: string | null
}
