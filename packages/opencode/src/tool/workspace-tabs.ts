import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./workspace-tabs.txt"

const workspaceTabs = [
  {
    id: "panel://browser",
    label: "Browser",
    tools: ["browser", "browser_use", "workspace_tabs", "file_browser", "artifact"],
    mentions: ["@browser", "@browser_use", "@agent_chrome", "@chrome", "@preview", "@project_preview", "@viewer"],
    actions: ["refresh", "open_external", "snapshot", "attach_to_chat", "tools", "settings"],
    safetyPolicy: "The Browser is interactive and tool-controlled. Extensions and password managers require separate explicit approval.",
    canSnapshot: true,
    canAttachToChat: true,
    route: "/experimental/browser/live/status",
    description: "Real Chrome/Chromium surface for public sites, local apps, Open Design, product previews, and model browser tools.",
  },
  {
    id: "panel://preview",
    label: "Browser",
    hidden: true,
    aliasFor: "panel://browser",
    tools: ["browser", "browser_use", "workspace_tabs"],
    mentions: [],
    actions: ["refresh", "open_external", "snapshot", "attach_to_chat", "tools"],
    safetyPolicy: "Compatibility alias. Opens the unified Browser tab.",
    canSnapshot: true,
    canAttachToChat: true,
    route: "/experimental/browser/live/status",
    description: "Compatibility alias for older saved Preview tabs. New preview requests open the unified Browser.",
  },
  {
    id: "panel://terminal",
    label: "Terminal",
    tools: ["terminal", "bash", "workspace_tabs"],
    mentions: ["@terminal", "@bash", "@shell"],
    actions: ["refresh", "attach_to_chat", "tools"],
    safetyPolicy: "Terminal actions follow normal OpenCode command permissions and project workspace scope.",
    canSnapshot: false,
    canAttachToChat: true,
    description: "Project-scoped PTY terminal kept inside the right-side tab surface.",
  },
  {
    id: "panel://open-design",
    label: "Open Design",
    tools: ["open_design", "workspace_tabs"],
    mentions: ["@open_design", "@opendesign", "@design"],
    actions: ["refresh", "open_external", "attach_to_chat", "tools"],
    safetyPolicy: "UI viewing is separate from daemon/API writes; mutating Open Design tools remain permission-gated.",
    canSnapshot: true,
    canAttachToChat: true,
    route: "/experimental/open-design/status",
    description: "Open Design UI plus daemon/MCP-backed tool context.",
  },
  {
    id: "panel://mac-view",
    label: "Mac View",
    tools: ["mac_view", "workspace_tabs"],
    mentions: ["@mac_view", "@mac", "@screen"],
    actions: ["refresh", "snapshot", "attach_to_chat", "tools", "settings"],
    safetyPolicy: "Mac View streams pixels only; control remains separate from viewing and tool permissions.",
    canSnapshot: true,
    canAttachToChat: true,
    route: "/experimental/mac-view/status",
    description: "Mac screen feed with WebRTC-first viewing controls.",
  },
  {
    id: "panel://resources",
    label: "Resources",
    tools: ["resource_status", "workspace_tabs"],
    mentions: ["@resources", "@resource_status", "@cpu", "@server_status"],
    actions: ["refresh", "attach_to_chat", "tools"],
    safetyPolicy: "Read-only metrics. Do not expose secrets or environment variable values.",
    canSnapshot: false,
    canAttachToChat: true,
    route: "/experimental/resources/status",
    description: "Server and Mac CPU, memory, storage, online, and uptime status.",
  },
  {
    id: "panel://accounts",
    label: "Codex",
    tools: ["account_status", "workspace_tabs"],
    mentions: ["@codex", "@accounts", "@account_status", "@multi_auth"],
    actions: ["refresh", "attach_to_chat", "tools", "settings"],
    safetyPolicy: "Account switching, probing, and re-auth are explicit/approval-gated account actions.",
    canSnapshot: false,
    canAttachToChat: true,
    route: "/experimental/workspace-suite/status",
    description: "Codex account lanes, rotation status, account health, and workspace index.",
  },
  {
    id: "panel://artifacts",
    label: "Artifacts",
    tools: ["artifact", "workspace_tabs"],
    mentions: ["@artifacts", "@artifact", "@file_viewer"],
    actions: ["refresh", "open_external", "attach_to_chat", "tools"],
    safetyPolicy: "Viewer routes are allowlisted and should not serve raw secrets or credentials.",
    canSnapshot: true,
    canAttachToChat: true,
    description: "Session artifacts and per-file media/document viewer tabs.",
  },
  {
    id: "panel://file-browser",
    label: "File Browser",
    tools: ["file_browser", "workspace_tabs"],
    mentions: ["@file_browser", "@files", "@file_browser_tab"],
    actions: ["refresh", "open_external", "attach_to_chat", "tools"],
    safetyPolicy: "File browsing is restricted to allowlisted roots and safe viewer routes.",
    canSnapshot: false,
    canAttachToChat: true,
    route: "/experimental/files/browse",
    description: "Allowlisted folder browser with search, metadata, and open actions.",
  },
  {
    id: "panel://routines",
    label: "Routines",
    tools: ["routines", "workspace_tabs"],
    mentions: ["@routines", "@routine", "@scheduler", "@cron"],
    actions: ["refresh", "attach_to_chat", "tools", "settings"],
    safetyPolicy: "Routine writes and manual runs are held unless the protected mutation flag is enabled.",
    canSnapshot: false,
    canAttachToChat: true,
    route: "/experimental/routines/jobs",
    description: "Scheduled routine list, logs, draft routine creation, and scheduler status.",
  },
  {
    id: "panel://environment",
    label: "Environment",
    tools: ["workspace_tabs", "account_status", "resource_status"],
    mentions: ["@environment", "@env", "@deployment"],
    actions: ["refresh", "attach_to_chat", "tools"],
    safetyPolicy: "Read-only environment summary. Do not leak token values or private config contents.",
    canSnapshot: false,
    canAttachToChat: true,
    route: "/experimental/workspace-suite/environments",
    description: "Live route, service, release, and environment topology.",
  },
] as const

const actions = ["list", "open", "focus", "close", "state", "actions", "run_action", "snapshot", "attach_to_chat"] as const

export const Parameters = Schema.Struct({
  action: Schema.Literals(actions).annotate({
    description: "Workspace tab operation to describe or request.",
  }),
  tab: Schema.optional(Schema.String).annotate({
    description: "Tab id such as panel://browser, panel://preview, panel://routines, or panel://accounts. panel://preview is a compatibility alias for panel://browser.",
  }),
  tabID: Schema.optional(Schema.String).annotate({
    description: "Alias for tab. Accepted by the HTTP API and tool for client payload compatibility.",
  }),
  tabAction: Schema.optional(Schema.String).annotate({
    description: "Action id for run_action, such as refresh, snapshot, open_external, attach_to_chat, tools, or settings.",
  }),
})

type Action = (typeof actions)[number]
type Metadata = {
  action: Action
  tab?: string
  tabID?: string
  tabAction?: string
}

export const WorkspaceTabsTool = Tool.define<typeof Parameters, Metadata, never>(
  "workspace_tabs",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>) =>
        Effect.gen(function* () {
          const result = workspaceTabsAction(params)
          return {
            title: `workspace_tabs ${params.action}`,
            output: JSON.stringify(result, null, 2),
            metadata: {
              action: params.action,
              ...(params.tab ? { tab: params.tab } : {}),
              ...(params.tabID ? { tabID: params.tabID } : {}),
              ...(params.tabAction ? { tabAction: params.tabAction } : {}),
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export function workspaceTabsStatus() {
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    registryVersion: 3,
    activeStateSource: "OpenCode web client",
    tabs: workspaceTabs.map((tab) => ({
      ...tab,
      runtimeState: {
        tabID: tab.id,
        canonicalTabID: canonicalWorkspaceTab(tab.id),
        stateRoute: "route" in tab ? tab.route : null,
        localClientState:
          tab.id === "panel://file-browser"
            ? "stored in browser localStorage"
            : "owned by visible client",
        canOpenFromTool: true,
        canFocusFromTool: true,
        canCloseFromTool: true,
      },
      toolContract: {
        list: { tool: "workspace_tabs", action: "list" },
        state: { tool: "workspace_tabs", action: "state", tab: tab.id },
        open: { tool: "workspace_tabs", action: "open", tab: tab.id },
        focus: { tool: "workspace_tabs", action: "focus", tab: tab.id },
        close: { tool: "workspace_tabs", action: "close", tab: tab.id },
        attachToChat: { tool: "workspace_tabs", action: "attach_to_chat", tab: tab.id },
      },
    })),
    contracts: {
      clientCanOpenTabs: true,
      serverCanRequestTabs: true,
      serverCannotInspectBrowserLocalTabState: true,
      openRequestShape: { tool: "workspace_tabs", action: "open", tab: "panel://browser" },
      clientEventShape: {
        event: "opencode:workspace-tab-action",
        detail: { type: "workspace_tab", action: "open", tab: "panel://browser" },
      },
      note: "The backend returns the canonical registry and requested client actions. The web client owns the currently visible/open tab set and applies matching workspace tab events.",
    },
  }
}

export function workspaceTabsAction(input: Schema.Schema.Type<typeof Parameters>) {
  const requestedTab = input.tab ?? input.tabID
  const canonicalTab = requestedTab ? canonicalWorkspaceTab(requestedTab) : undefined
  const tab = canonicalTab ? workspaceTabs.find((item) => item.id === canonicalTab) : undefined
  if ((input.action === "open" || input.action === "focus" || input.action === "close" || input.action === "actions" || input.action === "run_action" || input.action === "attach_to_chat") && !tab) {
    return { ok: false, error: `Unknown or missing tab: ${requestedTab ?? "(none)"}`, availableTabs: workspaceTabs.map((item) => item.id) }
  }
  if (input.action === "list" || input.action === "state" || input.action === "snapshot") return workspaceTabsStatus()
  if (input.action === "actions") return { ok: true, tab, actions: tab?.actions ?? [] }
  if (input.action === "run_action") {
    if (!input.tabAction) return { ok: false, error: "run_action requires tabAction", tab }
    if (!tab?.actions.includes(input.tabAction as any)) return { ok: false, error: `Action ${input.tabAction} is not available for ${tab?.id}`, tab }
    return {
      ok: true,
      tab,
      requestedAction: input.tabAction,
      clientAction: {
        type: "workspace_tab_action",
        tab: tab.id,
        requestedTab,
        action: input.tabAction,
        event: "opencode:workspace-tab-action",
      },
      note: "The OpenCode web client owns visible tab state. This tool returns the exact client action request for the UI/chat bridge.",
    }
  }
  if (input.action === "attach_to_chat") {
    return {
      ok: true,
      tab,
      attachmentRequest: {
      type: "workspace_tab_snapshot",
      tab: tab?.id,
      requestedTab,
      includeTools: true,
      includeRouteState: true,
      },
    }
  }
  return {
    ok: true,
    tab,
    clientAction: {
      type: "workspace_tab",
      action: input.action,
      tab: tab?.id,
      requestedTab,
      event: "opencode:workspace-tab-action",
    },
    note: "The web client can use this structured response to open, focus, or close a tab.",
  }
}

function canonicalWorkspaceTab(tab: string) {
  return tab === "panel://preview" ? "panel://browser" : tab
}
