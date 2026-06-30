export type WorkspacePanelTabID =
  | "panel://browser"
  | "panel://preview"
  | "panel://terminal"
  | "panel://open-design"
  | "panel://mac-view"
  | "panel://resources"
  | "panel://accounts"
  | "panel://artifacts"
  | "panel://file-browser"
  | "panel://routines"
  | "panel://environment"

export type WorkspacePanelActionID =
  | "refresh"
  | "open_external"
  | "snapshot"
  | "attach_to_chat"
  | "tools"
  | "settings"

export type WorkspacePanelDefinition = {
  id: WorkspacePanelTabID
  label: string
  shortLabel?: string
  icon?: string
  badge?: string
  hidden?: boolean
  toolIDs: string[]
  mentionIDs: string[]
  actions: WorkspacePanelActionID[]
  safetyPolicy: string
  canSnapshot: boolean
  canAttachToChat: boolean
  description: string
}

export const WORKSPACE_PANEL_TABS: WorkspacePanelDefinition[] = [
  {
    id: "panel://browser",
    label: "Browser",
    icon: "window-cursor",
    toolIDs: ["browser", "browser_use", "workspace_tabs", "file_browser", "artifact"],
    mentionIDs: ["browser", "browser_use", "agent_chrome", "chrome", "preview", "project_preview", "viewer"],
    actions: ["refresh", "open_external", "snapshot", "attach_to_chat", "tools", "settings"],
    safetyPolicy: "The Browser is interactive and tool-controlled. Extensions and password managers require separate explicit approval.",
    canSnapshot: true,
    canAttachToChat: true,
    description: "Real Chrome/Chromium surface for public sites, local apps, Open Design, product previews, and model browser tools.",
  },
  {
    id: "panel://preview",
    label: "Browser",
    icon: "window-cursor",
    hidden: true,
    toolIDs: ["browser", "browser_use", "workspace_tabs"],
    mentionIDs: [],
    actions: ["refresh", "open_external", "snapshot", "attach_to_chat", "tools"],
    safetyPolicy: "Compatibility alias. Opens the unified Browser tab.",
    canSnapshot: true,
    canAttachToChat: true,
    description: "Compatibility alias for older saved Preview tabs. New preview requests open the unified Browser.",
  },
  {
    id: "panel://terminal",
    label: "Terminal",
    icon: "terminal",
    toolIDs: ["terminal", "bash", "workspace_tabs"],
    mentionIDs: ["terminal", "bash", "shell"],
    actions: ["refresh", "attach_to_chat", "tools"],
    safetyPolicy: "Terminal actions follow normal OpenCode command permissions and project workspace scope.",
    canSnapshot: false,
    canAttachToChat: true,
    description: "Project-scoped PTY terminal kept inside the right-side tab surface.",
  },
  {
    id: "panel://open-design",
    label: "Open Design",
    badge: "OD",
    toolIDs: ["open_design", "workspace_tabs"],
    mentionIDs: ["open_design", "opendesign", "design"],
    actions: ["refresh", "open_external", "attach_to_chat", "tools"],
    safetyPolicy: "UI viewing is separate from daemon/API writes; mutating Open Design tools remain permission-gated.",
    canSnapshot: true,
    canAttachToChat: true,
    description: "Open Design UI plus daemon/MCP-backed tool context.",
  },
  {
    id: "panel://mac-view",
    label: "Mac View",
    icon: "eye",
    toolIDs: ["mac_view", "workspace_tabs"],
    mentionIDs: ["mac_view", "mac", "screen"],
    actions: ["refresh", "snapshot", "attach_to_chat", "tools", "settings"],
    safetyPolicy: "Mac View streams pixels only; control remains separate from viewing and tool permissions.",
    canSnapshot: true,
    canAttachToChat: true,
    description: "Mac screen feed with WebRTC-first viewing controls.",
  },
  {
    id: "panel://resources",
    label: "Resources",
    badge: "CPU",
    toolIDs: ["resource_status", "workspace_tabs"],
    mentionIDs: ["resources", "resource_status", "cpu", "server_status"],
    actions: ["refresh", "attach_to_chat", "tools"],
    safetyPolicy: "Read-only metrics. Do not expose secrets or environment variable values.",
    canSnapshot: false,
    canAttachToChat: true,
    description: "Server and Mac CPU, memory, storage, online, and uptime status.",
  },
  {
    id: "panel://accounts",
    label: "Codex",
    shortLabel: "Accounts",
    icon: "providers",
    toolIDs: ["account_status", "workspace_tabs"],
    mentionIDs: ["codex", "accounts", "account_status", "multi_auth"],
    actions: ["refresh", "attach_to_chat", "tools", "settings"],
    safetyPolicy: "Account switching, probing, and re-auth are explicit/approval-gated account actions.",
    canSnapshot: false,
    canAttachToChat: true,
    description: "Codex account lanes, rotation status, account health, and workspace index.",
  },
  {
    id: "panel://artifacts",
    label: "Artifacts",
    icon: "photo",
    toolIDs: ["artifact", "workspace_tabs"],
    mentionIDs: ["artifacts", "artifact", "file_viewer"],
    actions: ["refresh", "open_external", "attach_to_chat", "tools"],
    safetyPolicy: "Viewer routes are allowlisted and should not serve raw secrets or credentials.",
    canSnapshot: true,
    canAttachToChat: true,
    description: "Session artifacts and per-file media/document viewer tabs.",
  },
  {
    id: "panel://file-browser",
    label: "File Browser",
    icon: "folder",
    toolIDs: ["file_browser", "workspace_tabs"],
    mentionIDs: ["file_browser", "files", "file_browser_tab"],
    actions: ["refresh", "open_external", "attach_to_chat", "tools"],
    safetyPolicy: "File browsing is restricted to allowlisted roots and safe viewer routes.",
    canSnapshot: false,
    canAttachToChat: true,
    description: "Allowlisted folder browser with search, metadata, and open actions.",
  },
  {
    id: "panel://routines",
    label: "Routines",
    icon: "checklist",
    toolIDs: ["routines", "workspace_tabs"],
    mentionIDs: ["routines", "routine", "scheduler", "cron"],
    actions: ["refresh", "attach_to_chat", "tools", "settings"],
    safetyPolicy: "Routine writes and manual runs are held unless the protected mutation flag is enabled.",
    canSnapshot: false,
    canAttachToChat: true,
    description: "Scheduled routine list, logs, draft routine creation, and scheduler status.",
  },
  {
    id: "panel://environment",
    label: "Environment",
    badge: "ENV",
    toolIDs: ["workspace_tabs", "account_status", "resource_status"],
    mentionIDs: ["environment", "env", "deployment"],
    actions: ["refresh", "attach_to_chat", "tools"],
    safetyPolicy: "Read-only environment summary. Do not leak token values or private config contents.",
    canSnapshot: false,
    canAttachToChat: true,
    description: "Live route, service, release, and environment topology.",
  },
]

export const WORKSPACE_PANEL_TAB_IDS = new Set(WORKSPACE_PANEL_TABS.map((tab) => tab.id))
export const WORKSPACE_PANEL_TAB_BY_ID = Object.fromEntries(WORKSPACE_PANEL_TABS.map((tab) => [tab.id, tab])) as Record<
  WorkspacePanelTabID,
  WorkspacePanelDefinition
>

export function workspacePanelTabForTool(id: string, source?: string) {
  const normalized = id.toLowerCase().replace(/-/g, "_")
  if (normalized === "preview" || normalized === "project_preview" || normalized === "viewer") return "panel://browser"
  const byMention = WORKSPACE_PANEL_TABS.find((tab) => tab.mentionIDs.includes(normalized))
  if (byMention) return byMention.id
  const byTool = WORKSPACE_PANEL_TABS.find((tab) => tab.toolIDs.includes(normalized))
  if (byTool) return byTool.id
  if (source === "browser") return "panel://browser"
  if (source === "preview") return "panel://browser"
  if (source === "terminal") return "panel://terminal"
  if (source === "open_design") return "panel://open-design"
  if (source === "mac_view") return "panel://mac-view"
  if (source === "resource") return "panel://resources"
  if (source === "artifact") return "panel://artifacts"
  if (source === "file_browser") return "panel://file-browser"
  if (source === "account") return "panel://accounts"
  if (source === "routines") return "panel://routines"
  return undefined
}
