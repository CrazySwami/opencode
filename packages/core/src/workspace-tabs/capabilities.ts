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
  | "panel://mcp-registry"
  | "panel://token-maxing"
  | "panel://skills"

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
  aliasFor?: WorkspacePanelTabID
  route?: string
  toolIDs: string[]
  mentionIDs: string[]
  aliases: string[]
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
    route: "/experimental/browser/live/status",
    toolIDs: ["browser", "browser_use", "workspace_tabs", "file_browser", "artifact"],
    mentionIDs: ["browser", "browser_use", "agent_chrome", "chrome"],
    aliases: ["browser", "browser_use", "agent_chrome", "chrome"],
    actions: ["refresh", "open_external", "snapshot", "attach_to_chat", "tools", "settings"],
    safetyPolicy: "The Browser is interactive and tool-controlled. Extensions and password managers require separate explicit approval.",
    canSnapshot: true,
    canAttachToChat: true,
    description: "Real Chrome/Chromium surface for public sites, login-heavy tasks, DevTools-style inspection, Browser Use, and Playwright tooling.",
  },
  {
    id: "panel://preview",
    label: "Preview",
    icon: "window-cursor",
    route: "/experimental/browser/live/status",
    toolIDs: ["preview", "workspace_tabs", "file_browser", "artifact", "open_design"],
    mentionIDs: ["preview", "project_preview", "viewer"],
    aliases: ["preview", "project_preview", "viewer"],
    actions: ["refresh", "open_external", "snapshot", "attach_to_chat", "tools"],
    safetyPolicy: "Preview is for same-origin/local/internal routes and Chromium-rendered external fallback. Public login-heavy work should use Browser.",
    canSnapshot: true,
    canAttachToChat: true,
    description: "Lightweight interactive project/app/file/OpenDesign preview with direct iframe mode for controlled URLs and Playwright-backed actions for LLM navigation.",
  },
  {
    id: "panel://terminal",
    label: "Terminal",
    icon: "terminal",
    toolIDs: ["terminal", "bash", "workspace_tabs"],
    mentionIDs: ["terminal", "bash", "shell"],
    aliases: ["terminal", "bash", "shell"],
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
    route: "/experimental/open-design/status",
    toolIDs: ["open_design", "workspace_tabs"],
    mentionIDs: ["open_design", "opendesign", "design"],
    aliases: ["open_design", "opendesign", "design"],
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
    route: "/experimental/mac-view/status",
    toolIDs: ["mac_view", "workspace_tabs"],
    mentionIDs: ["mac_view", "mac", "screen"],
    aliases: ["mac_view", "mac", "screen"],
    actions: ["refresh", "snapshot", "attach_to_chat", "tools", "settings"],
    safetyPolicy: "Mac View streams pixels only; control remains separate from viewing and tool permissions.",
    canSnapshot: true,
    canAttachToChat: true,
    description: "Mac screen feed with WebRTC-first viewing controls.",
  },
  {
    id: "panel://resources",
    label: "Resources",
    badge: "CLI",
    route: "/experimental/cli-resources/status",
    toolIDs: ["cli_resources", "resource_status", "account_status", "workspace_tabs"],
    mentionIDs: [
      "resources",
      "cli_resources",
      "resource_status",
      "cpu",
      "server_status",
      "codex",
      "accounts",
      "account_status",
      "multi_auth",
      "claude_code",
      "antigravity",
      "opencode_provider",
    ],
    aliases: [
      "resources",
      "cli_resources",
      "resource_status",
      "cpu",
      "server_status",
      "codex",
      "accounts",
      "account_status",
      "multi_auth",
      "claude_code",
      "antigravity",
      "opencode_provider",
    ],
    actions: ["refresh", "attach_to_chat", "tools", "settings"],
    safetyPolicy:
      "Read-only status across CLI resources. No auth.json, ~/.claude.json, keyring data, OAuth/refresh tokens, API keys, cookies, or env values are exposed. Codex account mutations and Claude/Antigravity run actions are approval-gated.",
    canSnapshot: false,
    canAttachToChat: true,
    description:
      "CLI resources dashboard: system metrics, OpenCode providers, Codex Multi-Auth, Claude Code, and Antigravity — shown as separate auth systems, not merged providers.",
  },
  {
    id: "panel://accounts",
    label: "Codex",
    shortLabel: "Accounts",
    icon: "providers",
    hidden: true,
    aliasFor: "panel://resources",
    route: "/experimental/cli-resources/status",
    toolIDs: ["account_status", "cli_resources", "workspace_tabs"],
    mentionIDs: ["codex", "accounts", "account_status", "multi_auth"],
    aliases: ["codex", "accounts", "account_status", "multi_auth"],
    actions: ["refresh", "attach_to_chat", "tools", "settings"],
    safetyPolicy: "Account switching, probing, and re-auth are explicit/approval-gated account actions.",
    canSnapshot: false,
    canAttachToChat: true,
    description: "Codex account lanes (now inside the Resources tab, Codex section). Alias kept for compatibility.",
  },
  {
    id: "panel://artifacts",
    hidden: true,
    label: "Artifacts",
    icon: "photo",
    toolIDs: ["artifact", "workspace_tabs"],
    mentionIDs: ["artifacts", "artifact", "file_viewer"],
    aliases: ["artifacts", "artifact", "file_viewer"],
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
    route: "/experimental/files/browse",
    toolIDs: ["file_browser", "workspace_tabs"],
    mentionIDs: ["file_browser", "files", "file_browser_tab"],
    aliases: ["file_browser", "files", "file_browser_tab"],
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
    route: "/experimental/routines/jobs",
    toolIDs: ["routines", "workspace_tabs"],
    mentionIDs: ["routines", "routine", "scheduler", "cron"],
    aliases: ["routines", "routine", "scheduler", "cron"],
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
    route: "/experimental/workspace-suite/environments",
    toolIDs: ["workspace_tabs", "account_status", "resource_status"],
    mentionIDs: ["environment", "env", "deployment"],
    aliases: ["environment", "env", "deployment"],
    actions: ["refresh", "attach_to_chat", "tools"],
    safetyPolicy: "Read-only environment summary. Do not leak token values or private config contents.",
    canSnapshot: false,
    canAttachToChat: true,
    description: "Live route, service, release, and environment topology.",
  },
  {
    id: "panel://mcp-registry",
    label: "MCP Registry",
    badge: "MCP",
    icon: "puzzle",
    route: "/experimental/mcp/registry",
    toolIDs: ["workspace_tabs"],
    mentionIDs: ["mcp", "mcp_registry", "plugins", "connectors"],
    aliases: ["mcp", "mcp_registry", "plugins", "connectors"],
    actions: ["refresh", "attach_to_chat", "tools"],
    safetyPolicy: "Read-only catalog + configured MCP list. Adding/enabling a server is a separate config action; never leak header/token values.",
    canSnapshot: false,
    canAttachToChat: true,
    description: "Browse configured MCP servers and a catalog of installable ones; add custom MCPs.",
  },
  {
    id: "panel://token-maxing",
    label: "Token Maxing",
    badge: "TM",
    route: "/experimental/token-maxing/usage",
    toolIDs: ["workspace_tabs"],
    mentionIDs: ["token_maxing", "token-maxing", "usage", "quota", "tokens"],
    aliases: ["token_maxing", "token-maxing", "usage", "quota", "tokens"],
    actions: ["refresh", "attach_to_chat", "tools"],
    safetyPolicy: "Read-only usage view across accounts via the local token-maxing daemon. Account switching is a separate operator-gated action; never leak keys or tokens.",
    canSnapshot: false,
    canAttachToChat: true,
    description: "Live usage across all model accounts/profiles + switch controls (backed by the local token-maxing daemon).",
  },
  {
    id: "panel://skills",
    label: "Skills",
    badge: "SK",
    route: "/experimental/skills",
    toolIDs: ["skill", "workspace_tabs"],
    mentionIDs: ["skills", "skill", "skill_library"],
    aliases: ["skills", "skill", "skill_library"],
    actions: ["refresh", "attach_to_chat", "tools"],
    safetyPolicy: "Read-only skill catalog across roots. Running or editing a skill remains permission-gated.",
    canSnapshot: false,
    canAttachToChat: true,
    description: "Library of installed skills across Claude/Codex/OpenCode/project roots, with source + description.",
  },
]

export const WORKSPACE_PANEL_TAB_IDS = new Set(WORKSPACE_PANEL_TABS.map((tab) => tab.id))
export const WORKSPACE_PANEL_TAB_BY_ID = Object.fromEntries(WORKSPACE_PANEL_TABS.map((tab) => [tab.id, tab])) as unknown as Record<
  WorkspacePanelTabID,
  WorkspacePanelDefinition
>

export function canonicalWorkspacePanelTab(tab: string) {
  const direct = WORKSPACE_PANEL_TABS.find((item) => item.id === tab)
  if (direct?.aliasFor) return direct.aliasFor
  if (direct) return direct.id
  const normalized = tab.toLowerCase().replace(/-/g, "_")
  const matched = WORKSPACE_PANEL_TABS.find((item) => item.aliases.includes(normalized) || item.mentionIDs.includes(normalized))
  return matched?.aliasFor ?? matched?.id
}

export function workspacePanelTabForTool(id: string, source?: string) {
  const normalized = id.toLowerCase().replace(/-/g, "_")
  if (normalized === "preview" || normalized === "project_preview" || normalized === "viewer") return "panel://preview"
  const byMention = WORKSPACE_PANEL_TABS.find((tab) => tab.mentionIDs.includes(normalized))
  if (byMention) return byMention.aliasFor ?? byMention.id
  const byTool = WORKSPACE_PANEL_TABS.find((tab) => tab.toolIDs.includes(normalized))
  if (byTool) return byTool.aliasFor ?? byTool.id
  if (source === "browser") return "panel://browser"
  if (source === "preview") return "panel://preview"
  if (source === "terminal") return "panel://terminal"
  if (source === "open_design") return "panel://open-design"
  if (source === "mac_view") return "panel://mac-view"
  if (source === "resource") return "panel://resources"
  if (source === "artifact") return "panel://artifacts"
  if (source === "file_browser") return "panel://file-browser"
  if (source === "account") return "panel://resources"
  if (source === "routines") return "panel://routines"
  return undefined
}
