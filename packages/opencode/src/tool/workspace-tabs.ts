import { Effect, Schema } from "effect"
import {
  WORKSPACE_PANEL_TABS,
  canonicalWorkspacePanelTab,
  type WorkspacePanelActionID,
  type WorkspacePanelTabID,
} from "@opencode-ai/core/workspace-tabs/capabilities"
import { publishAppleBridgeEvent } from "./ios-bridge-events"
import * as Tool from "./tool"
import DESCRIPTION from "./workspace-tabs.txt"

const workspaceTabs = WORKSPACE_PANEL_TABS.map((tab) => ({
  ...tab,
  tools: tab.toolIDs,
  mentions: tab.mentionIDs.map((mention) => `@${mention}`),
}))

const actions = ["list", "open", "focus", "close", "state", "actions", "run_action", "snapshot", "attach_to_chat"] as const

export const Parameters = Schema.Struct({
  action: Schema.Literals(actions).annotate({
    description: "Workspace tab operation to describe or request.",
  }),
  tab: Schema.optional(Schema.String).annotate({
    description: "Tab id such as panel://browser, panel://preview, panel://routines, or panel://accounts.",
  }),
  tabID: Schema.optional(Schema.String).annotate({
    description: "Alias for tab. Accepted by the HTTP API and tool for client payload compatibility.",
  }),
  tabAction: Schema.optional(Schema.String).annotate({
    description: "Action id for run_action, such as refresh, snapshot, open_external, attach_to_chat, tools, or settings.",
  }),
  sessionID: Schema.optional(Schema.String).annotate({
    description: "Optional OpenCode session id. If omitted, the newest visible web client state is used.",
  }),
})

type Action = (typeof actions)[number]
type Metadata = {
  action: Action
  tab?: string
  tabID?: string
  tabAction?: string
  sessionID?: string
}

type WorkspaceTabsClientState = {
  sessionID?: string
  clientID?: string
  route?: string
  activeTab?: string
  rawActiveTab?: string
  activePanelTab?: string
  rawActivePanelTab?: string
  openTabs?: string[]
  openedTabs?: string[]
  openPanelTabs?: string[]
  openedPanelTabs?: string[]
  openFileTabs?: string[]
  openedFileTabs?: string[]
  reviewOpen?: boolean
  panelOpen?: boolean
  rightRailOpen?: boolean
  mobile?: boolean
  desktop?: boolean
  selected?: Record<string, unknown>
  bridges?: Record<string, unknown>
  visibleControls?: Record<string, unknown>
  errors?: unknown[]
  updatedAt?: string
}

type PendingWorkspaceTabAction = {
  id: string
  createdAt: string
  sessionID?: string
  clientID?: string
  action: Action
  tab?: WorkspacePanelTabID
  requestedTab?: string
  tabAction?: string
  clientAction: {
    type: "workspace_tab" | "workspace_tab_action" | "workspace_tab_snapshot"
    event: "opencode:workspace-tab-action"
    action: Action
    tab?: WorkspacePanelTabID
    requestedTab?: string
    tabAction?: string
    actionID: string
  }
}

let latestClientState: WorkspaceTabsClientState | undefined
const latestClientStateBySession = new Map<string, WorkspaceTabsClientState>()
let lastAck: unknown
const pendingActions: PendingWorkspaceTabAction[] = []

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
              ...(params.sessionID ? { sessionID: params.sessionID } : {}),
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

function normalizeClientState(state: WorkspaceTabsClientState | undefined) {
  if (!state) return undefined
  const unique = (items: unknown[] | undefined) => Array.from(new Set((items ?? []).filter((item): item is string => typeof item === "string")))
  const openTabs = unique(state.openedTabs ?? state.openTabs)
  const openPanelTabs = unique(state.openedPanelTabs ?? state.openPanelTabs)
  const openFileTabs = unique(state.openedFileTabs ?? state.openFileTabs)
  const workspacePanelOpen = state.panelOpen === true || state.reviewOpen === true || state.mobile === true
  const rawActiveTab = state.rawActiveTab ?? state.activeTab
  const rawActivePanelTab = state.rawActivePanelTab ?? state.activePanelTab
  const normalizedActivePanelTab = rawActivePanelTab ? canonicalWorkspaceTab(rawActivePanelTab) : undefined
  const visibleActivePanelTab =
    workspacePanelOpen && normalizedActivePanelTab && openPanelTabs.includes(normalizedActivePanelTab)
      ? normalizedActivePanelTab
      : undefined
  const activeTab = rawActiveTab && canonicalWorkspaceTab(rawActiveTab) === visibleActivePanelTab
    ? visibleActivePanelTab
    : rawActiveTab && !rawActiveTab.startsWith("panel://")
      ? rawActiveTab
      : undefined
  return {
    ...state,
    activeTab,
    rawActiveTab,
    activePanelTab: visibleActivePanelTab,
    rawActivePanelTab,
    openTabs,
    openedTabs: openTabs,
    openPanelTabs,
    openedPanelTabs: openPanelTabs,
    openFileTabs,
    openedFileTabs: openFileTabs,
    panelOpen: workspacePanelOpen,
    rightRailOpen: state.rightRailOpen ?? workspacePanelOpen,
  }
}

export function workspaceTabsStatus(sessionID?: string) {
  const now = new Date().toISOString()
  const clientState = normalizeClientState(sessionID ? latestClientStateBySession.get(sessionID) : latestClientState)
  return {
    ok: true,
    generatedAt: now,
    registryVersion: 4,
    activeStateSource: clientState ? "OpenCode web client live sync" : "OpenCode static registry",
    clientState: clientState ?? null,
    pendingActions: pendingActions.slice(-20),
    lastAck: lastAck ?? null,
    tabs: workspaceTabs.map((tab) => ({
      ...tab,
      runtimeState: {
        tabID: tab.id,
        canonicalTabID: canonicalWorkspaceTab(tab.id),
        stateRoute: "route" in tab ? tab.route : null,
        latestClientState:
          clientState?.activePanelTab === canonicalWorkspaceTab(tab.id)
            ? clientState
            : null,
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
      serverReceivesLiveClientState: !!clientState,
      openRequestShape: { tool: "workspace_tabs", action: "open", tab: "panel://browser" },
      clientEventShape: {
        event: "opencode:workspace-tab-action",
        detail: { type: "workspace_tab", action: "open", tab: "panel://browser", actionID: "wta_..." },
      },
      note: "The backend returns the shared registry, live client state when available, and queued client actions. The web client owns visible tab state and acks applied actions.",
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
  if (input.action === "list" || input.action === "state" || input.action === "snapshot") return workspaceTabsStatus(input.sessionID)
  if (input.action === "actions") return { ok: true, tab, actions: tab?.actions ?? [], clientState: normalizeClientState(latestClientState) ?? null }
  if (input.action === "run_action") {
    if (!input.tabAction) return { ok: false, error: "run_action requires tabAction", tab }
    if (!tab?.actions.includes(input.tabAction as WorkspacePanelActionID)) return { ok: false, error: `Action ${input.tabAction} is not available for ${tab?.id}`, tab }
    const clientAction = queueWorkspaceTabClientAction({ action: input.action, tab: tab.id, requestedTab, tabAction: input.tabAction, sessionID: input.sessionID })
    return {
      ok: true,
      tab,
      requestedAction: input.tabAction,
      clientAction: clientAction.clientAction,
      pendingAction: clientAction,
      note: "The web client polls pending workspace tab actions, applies them, and acks success or failure.",
    }
  }
  if (input.action === "attach_to_chat") {
    const clientAction = queueWorkspaceTabClientAction({ action: input.action, tab: tab?.id, requestedTab, sessionID: input.sessionID })
    return {
      ok: true,
      tab,
      attachmentRequest: clientAction.clientAction,
      pendingAction: clientAction,
    }
  }
  const clientAction = queueWorkspaceTabClientAction({ action: input.action, tab: tab?.id, requestedTab, sessionID: input.sessionID })
  return {
    ok: true,
    tab,
    clientAction: clientAction.clientAction,
    pendingAction: clientAction,
    note: "The web client polls pending workspace tab actions, applies them, and acks success or failure.",
  }
}

export function updateWorkspaceTabsClientState(input: WorkspaceTabsClientState) {
  const normalized = normalizeClientState({
    ...input,
    updatedAt: new Date().toISOString(),
  })
  latestClientState = normalized
  if (normalized?.sessionID) latestClientStateBySession.set(normalized.sessionID, normalized)
  const clientState = latestClientState
  publishWorkspaceTabEvent("workspace.tab.state", {
    sessionID: clientState?.sessionID,
    clientID: clientState?.clientID,
    activeTab: clientState?.activeTab,
    activePanelTab: clientState?.activePanelTab,
    openedPanelTabs: clientState?.openedPanelTabs,
    panelOpen: clientState?.panelOpen,
    mobile: clientState?.mobile,
  })
  return { ok: true, clientState, pendingCount: pendingActions.length }
}

export function workspaceTabsPendingActions(sessionID?: string, clientID?: string) {
  const sessionState = sessionID ? latestClientStateBySession.get(sessionID) : latestClientState
  const targetSessionID = sessionID || sessionState?.sessionID
  const targetClientID = clientID || sessionState?.clientID
  const actions = pendingActions.filter((action) => {
    const sessionMatches = !action.sessionID || !targetSessionID || action.sessionID === targetSessionID
    const clientMatches = !action.clientID || (!!targetClientID && action.clientID === targetClientID)
    return sessionMatches && clientMatches
  })
  return { ok: true, sessionID: targetSessionID ?? null, clientID: targetClientID ?? null, actions }
}

export function ackWorkspaceTabsAction(input: { actionID?: string; ok?: boolean; error?: string; state?: unknown }) {
  const actionID = input.actionID
  if (!actionID) return { ok: false, error: "Missing actionID" }
  const index = pendingActions.findIndex((action) => action.id === actionID)
  const action = index >= 0 ? pendingActions.splice(index, 1)[0] : undefined
  lastAck = {
    actionID,
    ok: input.ok !== false,
    error: input.error ?? null,
    state: input.state ?? null,
    action: action ?? null,
    acknowledgedAt: new Date().toISOString(),
  }
  publishWorkspaceTabEvent("workspace.tab.action.acked", lastAck)
  return { ok: true, ack: lastAck, remaining: pendingActions.length }
}

function queueWorkspaceTabClientAction(input: {
  action: Action
  tab?: WorkspacePanelTabID
  requestedTab?: string
  tabAction?: string
  sessionID?: string
  clientID?: string
}) {
  const actionID = `wta_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const type = input.action === "run_action" ? "workspace_tab_action" : input.action === "attach_to_chat" ? "workspace_tab_snapshot" : "workspace_tab"
  const targetState = input.sessionID ? latestClientStateBySession.get(input.sessionID) : latestClientState
  const item: PendingWorkspaceTabAction = {
    id: actionID,
    createdAt: new Date().toISOString(),
    sessionID: input.sessionID ?? targetState?.sessionID,
    clientID: input.clientID ?? targetState?.clientID,
    action: input.action,
    tab: input.tab,
    requestedTab: input.requestedTab,
    tabAction: input.tabAction,
    clientAction: {
      type,
      event: "opencode:workspace-tab-action",
      action: input.action,
      tab: input.tab,
      requestedTab: input.requestedTab,
      tabAction: input.tabAction,
      actionID,
    },
  }
  pendingActions.push(item)
  if (pendingActions.length > 50) pendingActions.splice(0, pendingActions.length - 50)
  publishWorkspaceTabEvent("workspace.tab.action.queued", item)
  return item
}

function publishWorkspaceTabEvent(event: string, payload: unknown) {
  publishAppleBridgeEvent("workspace_tabs", event, payload)
}

function canonicalWorkspaceTab(tab: string) {
  return canonicalWorkspacePanelTab(tab) ?? tab
}
