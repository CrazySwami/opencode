import { useFilteredList } from "@opencode-ai/ui/hooks"
import { useSpring } from "@opencode-ai/ui/motion-spring"
import { Popover as KobaltePopover } from "@kobalte/core/popover"
import {
  createEffect,
  on,
  Component,
  Show,
  For,
  onCleanup,
  createMemo,
  createSignal,
  createResource,
  Switch,
  Match,
  type JSX,
} from "solid-js"
import { createStore, type SetStoreFunction, type Store } from "solid-js/store"
import type { useLocal } from "@/context/local"
import { selectionFromLines, type SelectedLineRange, useFile } from "@/context/file"
import {
  ContentPart,
  DEFAULT_PROMPT,
  isPromptEqual,
  Prompt,
  usePrompt,
  ImageAttachmentPart,
  AgentPart,
  FileAttachmentPart,
  ToolPart,
  type ToolPartSource,
} from "@/context/prompt"
import { useLayout } from "@/context/layout"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useComments } from "@/context/comments"
import { Button } from "@opencode-ai/ui/button"
import { DockShellForm, DockTray } from "@opencode-ai/ui/dock-surface"
import { Icon } from "@opencode-ai/ui/icon"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { KeybindV2 } from "@opencode-ai/ui/v2/keybind-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Select } from "@opencode-ai/ui/select"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ModelSelectorPopover } from "@/components/dialog-select-model"
import { useCommand } from "@/context/command"
import { Persist, persisted } from "@/utils/persist"
import { usePermission } from "@/context/permission"
import { CODEX_MULTI_AUTH_PROVIDER_ID } from "@/hooks/provider-catalog"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { createSessionTabs } from "@/pages/session/helpers"
import { WORKSPACE_PANEL_TABS, workspacePanelTabForTool } from "@/workspace-tabs/registry"
import { createTextFragment, getCursorPosition, setCursorPosition, setRangeEdge } from "./prompt-input/editor-dom"
import { createPromptAttachments } from "./prompt-input/attachments"
import { ACCEPTED_FILE_TYPES, pickAttachmentFiles } from "./prompt-input/files"
import {
  canNavigateHistoryAtCursor,
  navigatePromptHistory,
  prependHistoryEntry,
  type PromptHistoryComment,
  type PromptHistoryEntry,
  type PromptHistoryStoredEntry,
  promptLength,
} from "./prompt-input/history"
import { createPromptSubmit, type FollowupDraft } from "./prompt-input/submit"
import { PromptPopover, type AtOption, type SlashCommand } from "./prompt-input/slash-popover"
import { PromptContextItems } from "./prompt-input/context-items"
import { PromptImageAttachments } from "./prompt-input/image-attachments"
import { PromptDragOverlay } from "./prompt-input/drag-overlay"
import { promptPlaceholder } from "./prompt-input/placeholder"
import { createPromptInputTransientState } from "./prompt-input/transient-state"
import { showToast } from "@/utils/toast"
import { ImagePreview } from "@opencode-ai/ui/image-preview"

export type PromptInputState = ReturnType<typeof usePrompt>

export type PromptInputHistory = {
  entries: (mode: "normal" | "shell") => PromptHistoryStoredEntry[]
  add: (prompt: Prompt, mode: "normal" | "shell", comments: PromptHistoryComment[]) => void
}

export type PromptInputSubmission = {
  abort: () => Promise<void> | void
  handleSubmit: (event: Event) => Promise<void> | void
}

type OpenDesignBridgePromptState = {
  kind?: string
  active?: boolean
  projectId?: string
  projectName?: string
  chatId?: string
  chatName?: string
  focusMode?: boolean
  activeCanvasTab?: string
  fileCount?: number
  updatedAt?: string
  // The embedded Open Design build advertises whether it accepts inbound
  // prompts from the OpenCode composer (bridge handshake).
  acceptsPrompts?: boolean
  // Full conversation list for the active project so the composer can switch or
  // start chats, plus the model/provider the OD chat runs on.
  conversations?: { id: string; title?: string | null }[]
  activeConversationId?: string | null
  model?: string | null
  apiProtocol?: string | null
  // Open Design chat slash-commands (if the OD build advertises them).
  slashCommands?: { label: string; hint?: string | null }[]
}

// Core Open Design chat commands, used when the OD build does not advertise its
// own list. These route to the OD chat (the composer sends them into Open Design).
const DEFAULT_OPEN_DESIGN_COMMANDS: { label: string; hint?: string | null }[] = [
  { label: "/search", hint: "Web search inside Open Design" },
  { label: "/mcp", hint: "Use a connected MCP server's tools" },
  { label: "/pet", hint: "Toggle or adopt the Open Design pet" },
]

const OPEN_DESIGN_BRIDGE_EVENT = "opencode:open-design-bridge-state"

function readOpenDesignBridgeState(): OpenDesignBridgePromptState | undefined {
  if (typeof window === "undefined") return undefined
  const state = (window as Window & { __opencodeOpenDesignBridgeState?: unknown }).__opencodeOpenDesignBridgeState
  if (!state || typeof state !== "object") return undefined
  return state as OpenDesignBridgePromptState
}

export type PromptInputControls = {
  agents: {
    available: { name: string; hidden?: boolean; mode: string }[]
    options: string[]
    current: string
    loading: boolean
    visible: boolean
    select: (name: string | undefined) => void
  }
  model: {
    selection: ReturnType<typeof useLocal>["model"]
    paid: boolean
    loading: boolean
  }
  session: {
    id?: string
    tabs: {
      active: () => string | undefined
      all: () => string[]
      open: (tab: string) => void | Promise<void>
      setActive: (tab: string) => void
    }
    reviewPanel: {
      opened: () => boolean
      open: () => void
    }
  }
  newLayoutDesigns: boolean
}

export function createPromptInputHistory(): PromptInputHistory {
  const [normal, setNormal] = createStore<PromptHistoryState>({ entries: [] })
  const [shell, setShell] = createStore<PromptHistoryState>({ entries: [] })
  return createPromptInputHistoryStore(normal, setNormal, shell, setShell)
}

type PromptHistoryState = { entries: PromptHistoryStoredEntry[] }

function createPromptInputHistoryStore(
  normal: Store<PromptHistoryState>,
  setNormal: SetStoreFunction<PromptHistoryState>,
  shell: Store<PromptHistoryState>,
  setShell: SetStoreFunction<PromptHistoryState>,
): PromptInputHistory {
  return {
    entries: (mode) => (mode === "shell" ? shell.entries : normal.entries),
    add(prompt, mode, comments) {
      const current = mode === "shell" ? shell : normal
      const setCurrent = mode === "shell" ? setShell : setNormal
      const next = prependHistoryEntry(current.entries, prompt, comments)
      if (next === current.entries) return
      setCurrent("entries", next)
    },
  }
}

function createPersistedPromptInputHistory() {
  const [normal, setNormal] = persisted(
    Persist.global("prompt-history", ["prompt-history.v1"]),
    createStore<PromptHistoryState>({ entries: [] }),
  )
  const [shell, setShell] = persisted(
    Persist.global("prompt-history-shell", ["prompt-history-shell.v1"]),
    createStore<PromptHistoryState>({ entries: [] }),
  )
  return createPromptInputHistoryStore(normal, setNormal, shell, setShell)
}

export interface PromptInputProps {
  class?: string
  variant?: "dock" | "new-session"
  state?: PromptInputState
  history?: PromptInputHistory
  submission?: PromptInputSubmission
  controls: PromptInputControls
  ref?: (el: HTMLDivElement) => void
  newSessionWorktree?: string
  onNewSessionWorktreeReset?: () => void
  edit?: { id: string; prompt: Prompt; context: FollowupDraft["context"] }
  onEditLoaded?: () => void
  shouldQueue?: () => boolean
  onQueue?: (draft: FollowupDraft) => void
  onAbort?: () => void
  onSubmit?: () => void
  toolbar?: JSX.Element
}

const EXAMPLES = [
  "prompt.example.1",
  "prompt.example.2",
  "prompt.example.3",
  "prompt.example.4",
  "prompt.example.5",
  "prompt.example.6",
  "prompt.example.7",
  "prompt.example.8",
  "prompt.example.9",
  "prompt.example.10",
  "prompt.example.11",
  "prompt.example.12",
  "prompt.example.13",
  "prompt.example.14",
  "prompt.example.15",
  "prompt.example.16",
  "prompt.example.17",
  "prompt.example.18",
  "prompt.example.19",
  "prompt.example.20",
  "prompt.example.21",
  "prompt.example.22",
  "prompt.example.23",
  "prompt.example.24",
  "prompt.example.25",
] as const

const BUILT_IN_TOOL_IDS = new Set([
  "bash",
  "edit",
  "fetch",
  "glob",
  "grep",
  "list",
  "patch",
  "read",
  "todowrite",
  "webfetch",
  "write",
])

const classifyToolMention = (id: string): ToolPartSource => {
  const normalized = id.toLowerCase()
  if (normalized === "swami" || normalized === "alfonso-os" || normalized === "alfonso_os" || normalized === "alfonsoos")
    return "swami"
  if (
    normalized === "browser" ||
    normalized === "browser_use" ||
    normalized === "agent_chrome" ||
    normalized === "preview" ||
    normalized === "project_preview" ||
    normalized === "viewer"
  ) return "browser"
  if (normalized === "terminal" || normalized === "bash") return "terminal"
  if (normalized === "open_design" || normalized.startsWith("open_design_")) return "open_design"
  if (normalized === "mac_view" || normalized.startsWith("mac_view_")) return "mac_view"
  if (normalized === "resource_status" || normalized.startsWith("resource_")) return "resource"
  if (normalized === "artifact" || normalized.startsWith("artifact_")) return "artifact"
  if (normalized === "file_browser" || normalized.startsWith("file_browser_")) return "file_browser"
  if (normalized === "account_status" || normalized.startsWith("account_")) return "account"
  if (normalized === "routines" || normalized === "routine_status" || normalized.startsWith("routine_")) return "routines"
  if (normalized.startsWith("mcp") || normalized.includes("mcp") || !BUILT_IN_TOOL_IDS.has(normalized)) return "mcp"
  return "tool"
}

const toolMentionName = (id: string) => id

const optionForToolMention = (input: { id: string; name?: string; description?: string; icon?: string }): AtOption => {
  const name = input.name ?? toolMentionName(input.id)
  return {
    type: "tool",
    id: input.id,
    name,
    display: `${name} ${input.id} ${input.description ?? ""}`,
    source: classifyToolMention(input.id),
    description: input.description,
    icon: input.icon,
  }
}

const SWAMI_TOOL_MENTIONS = [
  optionForToolMention({
    id: "swami",
    name: "Swami",
    description: "Alfonso OS setup, skills, MCPs, plugins, server, Mac, OpenCode, and Open Design context.",
  }),
  optionForToolMention({
    id: "alfonso-os",
    name: "Alfonso-OS",
    description: "Alias for Swami operating context and Alfonso OS source of truth.",
  }),
]

const WORKSPACE_TOOL_MENTIONS = WORKSPACE_PANEL_TABS.map((tab) =>
  optionForToolMention({
    id: tab.mentionIDs[0] ?? tab.toolIDs[0] ?? tab.id,
    name: tab.label,
    description: tab.description,
    icon: tab.icon,
  }),
)

// The Resources tab has sub-sections (Claude Code, Antigravity, OpenCode
// providers) that are not standalone tabs. Expose them as mentions that focus
// the Resources tab on the matching section.
const RESOURCES_SECTION_MENTIONS = [
  optionForToolMention({
    id: "claude_code",
    name: "Claude Code",
    description: "Claude Code CLI status (installed, settings, telemetry) in the Resources tab.",
  }),
  optionForToolMention({
    id: "antigravity",
    name: "Antigravity",
    description: "Antigravity (agy) CLI status and subcommands in the Resources tab.",
  }),
  optionForToolMention({
    id: "opencode_provider",
    name: "OpenCode Providers",
    description: "OpenCode native provider/auth status in the Resources tab.",
  }),
]

const RESOURCES_SECTION_BY_MENTION: Record<string, string> = {
  codex: "codex",
  accounts: "codex",
  account_status: "codex",
  multi_auth: "codex",
  claude_code: "claude",
  antigravity: "antigravity",
  agy: "antigravity",
  opencode_provider: "opencode",
  resources: "system",
  resource_status: "system",
  cpu: "system",
  server_status: "system",
}

const uniqueToolMentions = (items: AtOption[]) => {
  const seen = new Set<string>()
  return items.filter((item) => {
    if (item.type !== "tool") return true
    const key = item.id.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export const PromptInput: Component<PromptInputProps> = (props) => {
  const sdk = useSDK()

  const sync = useSync()
  const files = useFile()
  const prompt = props.state ?? usePrompt()
  const layout = useLayout()
  const comments = useComments()
  const dialog = useDialog()
  const command = useCommand()
  const permission = usePermission()
  const language = useLanguage()
  const platform = usePlatform()
  const tabs = () => props.controls.session.tabs
  let editorRef!: HTMLDivElement
  let fileInputRef: HTMLInputElement | undefined
  let scrollRef!: HTMLDivElement
  let slashPopoverRef!: HTMLDivElement

  const mirror = { input: false }
  const inset = 56
  const space = `${inset}px`

  const scrollCursorIntoView = () => {
    const container = scrollRef
    const selection = window.getSelection()
    if (!container || !selection || selection.rangeCount === 0) return

    const range = selection.getRangeAt(0)
    if (!editorRef.contains(range.startContainer)) return

    const cursor = getCursorPosition(editorRef)
    const length = promptLength(prompt.current().filter((part) => part.type !== "image"))
    if (cursor >= length) {
      container.scrollTop = container.scrollHeight
      return
    }

    const rect = range.getClientRects().item(0) ?? range.getBoundingClientRect()
    if (!rect.height) return

    const containerRect = container.getBoundingClientRect()
    const top = rect.top - containerRect.top + container.scrollTop
    const bottom = rect.bottom - containerRect.top + container.scrollTop
    const padding = 12

    if (top < container.scrollTop + padding) {
      container.scrollTop = Math.max(0, top - padding)
      return
    }

    if (bottom > container.scrollTop + container.clientHeight - inset) {
      container.scrollTop = bottom - container.clientHeight + inset
    }
  }

  const queueScroll = (count = 2) => {
    requestAnimationFrame(() => {
      scrollCursorIntoView()
      if (count > 1) queueScroll(count - 1)
    })
  }

  const activeFileTab = createSessionTabs({
    tabs,
    pathFromTab: files.pathFromTab,
    normalizeTab: (tab) => (tab.startsWith("file://") ? files.tab(tab) : tab),
  }).activeFileTab

  const commentInReview = (path: string) => {
    const sessionID = props.controls.session.id
    if (!sessionID) return false

    const diffs = sync().data.session_diff[sessionID]
    if (!diffs) return false
    return diffs.some((diff) => diff.file === path)
  }

  const openComment = (item: { path: string; commentID?: string; commentOrigin?: "review" | "file" }) => {
    if (!item.commentID) return

    const focus = { file: item.path, id: item.commentID }
    comments.setActive(focus)

    const queueCommentFocus = (attempts = 6) => {
      const schedule = (left: number) => {
        requestAnimationFrame(() => {
          comments.setFocus({ ...focus })
          if (left <= 0) return
          requestAnimationFrame(() => {
            const current = comments.focus()
            if (!current) return
            if (current.file !== focus.file || current.id !== focus.id) return
            schedule(left - 1)
          })
        })
      }

      schedule(attempts)
    }

    const wantsReview = item.commentOrigin === "review" || (item.commentOrigin !== "file" && commentInReview(item.path))
    if (wantsReview) {
      if (!props.controls.session.reviewPanel.opened()) props.controls.session.reviewPanel.open()
      layout.fileTree.setTab("changes")
      tabs().setActive("review")
      queueCommentFocus()
      return
    }

    if (!props.controls.session.reviewPanel.opened()) props.controls.session.reviewPanel.open()
    layout.fileTree.setTab("all")
    const tab = files.tab(item.path)
    void tabs().open(tab)
    tabs().setActive(tab)
    void Promise.resolve(files.load(item.path)).finally(() => queueCommentFocus())
  }

  const recent = createMemo(() => {
    const all = tabs().all()
    const active = activeFileTab()
    const order = active ? [active, ...all.filter((x) => x !== active)] : all
    const seen = new Set<string>()
    const paths: string[] = []

    for (const tab of order) {
      const path = files.pathFromTab(tab)
      if (!path) continue
      if (seen.has(path)) continue
      seen.add(path)
      paths.push(path)
    }

    return paths
  })
  const info = createMemo(() => (props.controls.session.id ? sync().session.get(props.controls.session.id) : undefined))
  const working = createMemo(() => sync().data.session_working(props.controls.session.id ?? ""))
  const imageAttachments = createMemo(() =>
    prompt.current().filter((part): part is ImageAttachmentPart => part.type === "image"),
  )

  const [store, setStore] = createPromptInputTransientState(
    () => prompt.capture(),
    Math.floor(Math.random() * EXAMPLES.length),
  )
  const buttonsSpring = useSpring(() => (store.mode === "normal" ? 1 : 0), { visualDuration: 0.2, bounce: 0 })
  const motion = (value: number) => ({
    opacity: value,
    transform: `scale(${0.98 + value * 0.02})`,
    filter: `blur(${(1 - value) * 2}px)`,
    "pointer-events": value > 0.5 ? ("auto" as const) : ("none" as const),
  })
  const buttons = createMemo(() => motion(buttonsSpring()))
  const shell = createMemo(() => motion(1 - buttonsSpring()))
  const control = createMemo(() => ({ height: "28px", ...buttons() }))

  const commentCount = createMemo(() => {
    if (store.mode === "shell") return 0
    return prompt.context.items().filter((item) => !!item.comment?.trim()).length
  })
  const blank = createMemo(() => {
    const text = prompt
      .current()
      .map((part) => ("content" in part ? part.content : ""))
      .join("")
    return text.trim().length === 0 && imageAttachments().length === 0 && commentCount() === 0
  })
  const stopping = createMemo(() => working() && blank())
  const tip = () => {
    if (stopping()) {
      return (
        <div class="flex items-center gap-2">
          <span>{language.t("prompt.action.stop")}</span>
          <span class="text-icon-base text-12-medium text-[10px]!">{language.t("common.key.esc")}</span>
        </div>
      )
    }

    return (
      <div class="flex items-center gap-2">
        <span>{language.t("prompt.action.send")}</span>
        <Icon name="enter" size="small" class="text-icon-base" />
      </div>
    )
  }

  const contextItems = createMemo(() => {
    const items = prompt.context.items()
    if (store.mode !== "shell") return items
    return items.filter((item) => !item.comment?.trim())
  })

  const hasUserPrompt = createMemo(() => {
    const sessionID = props.controls.session.id
    if (!sessionID) return false
    const messages = sync().data.message[sessionID]
    if (!messages) return false
    return messages.some((m) => m.role === "user")
  })

  const history = props.history ?? createPersistedPromptInputHistory()

  const suggest = createMemo(() => !hasUserPrompt())

  const placeholder = createMemo(() =>
    promptPlaceholder({
      mode: store.mode,
      commentCount: commentCount(),
      example: suggest() ? (store.mode === "shell" ? "git status" : language.t(EXAMPLES[store.placeholder])) : "",
      suggest: suggest(),
      t: (key, params) => language.t(key as Parameters<typeof language.t>[0], params as never),
    }),
  )

  const historyComments = () => {
    const byID = new Map(comments.all().map((item) => [`${item.file}\n${item.id}`, item] as const))
    return prompt.context.items().flatMap((item) => {
      if (item.type !== "file") return []
      const comment = item.comment?.trim()
      if (!comment) return []

      const selection = item.commentID ? byID.get(`${item.path}\n${item.commentID}`)?.selection : undefined
      const nextSelection =
        selection ??
        (item.selection
          ? ({
              start: item.selection.startLine,
              end: item.selection.endLine,
            } satisfies SelectedLineRange)
          : undefined)
      if (!nextSelection) return []

      return [
        {
          id: item.commentID ?? item.key,
          path: item.path,
          selection: { ...nextSelection },
          comment,
          time: item.commentID ? (byID.get(`${item.path}\n${item.commentID}`)?.time ?? Date.now()) : Date.now(),
          origin: item.commentOrigin,
          preview: item.preview,
        } satisfies PromptHistoryComment,
      ]
    })
  }

  const applyHistoryComments = (items: PromptHistoryComment[]) => {
    comments.replace(
      items.map((item) => ({
        id: item.id,
        file: item.path,
        selection: { ...item.selection },
        comment: item.comment,
        time: item.time,
      })),
    )
    prompt.context.replaceComments(
      items.map((item) => ({
        type: "file" as const,
        path: item.path,
        selection: selectionFromLines(item.selection),
        comment: item.comment,
        commentID: item.id,
        commentOrigin: item.origin,
        preview: item.preview,
      })),
    )
  }

  const applyHistoryPrompt = (entry: PromptHistoryEntry, position: "start" | "end") => {
    const p = entry.prompt
    const length = position === "start" ? 0 : promptLength(p)
    setStore("applyingHistory", true)
    applyHistoryComments(entry.comments)
    prompt.set(p, length)
    requestAnimationFrame(() => {
      editorRef.focus()
      setCursorPosition(editorRef, length)
      setStore("applyingHistory", false)
      queueScroll()
    })
  }

  const getCaretState = () => {
    const selection = window.getSelection()
    const textLength = promptLength(prompt.current())
    if (!selection || selection.rangeCount === 0) {
      return { collapsed: false, cursorPosition: 0, textLength }
    }
    const anchorNode = selection.anchorNode
    if (!anchorNode || !editorRef.contains(anchorNode)) {
      return { collapsed: false, cursorPosition: 0, textLength }
    }
    return {
      collapsed: selection.isCollapsed,
      cursorPosition: getCursorPosition(editorRef),
      textLength,
    }
  }

  const escBlur = () => platform.platform === "desktop" && platform.os === "macos"

  const pick = () => {
    pickAttachmentFiles({
      picker: platform.openAttachmentPickerDialog,
      directory: () => sdk().directory,
      fallback: () => fileInputRef?.click(),
      onFile: addAttachment,
      onError: (error) =>
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: error instanceof Error ? error.message : String(error),
        }),
    })
  }

  const setMode = (mode: "normal" | "shell") => {
    setStore("mode", mode)
    setStore("popover", null)
    requestAnimationFrame(() => editorRef?.focus())
  }

  const shellModeKey = "mod+shift+x"
  const normalModeKey = "mod+shift+e"

  command.register("prompt-input", () => [
    {
      id: "file.attach",
      title: language.t("prompt.action.attachFile"),
      category: language.t("command.category.file"),
      keybind: "mod+u",
      disabled: store.mode !== "normal",
      onSelect: pick,
    },
    {
      id: "prompt.mode.shell",
      title: language.t("command.prompt.mode.shell"),
      category: language.t("command.category.session"),
      keybind: shellModeKey,
      disabled: store.mode === "shell",
      onSelect: () => setMode("shell"),
    },
    {
      id: "prompt.mode.normal",
      title: language.t("command.prompt.mode.normal"),
      category: language.t("command.category.session"),
      keybind: normalModeKey,
      disabled: store.mode === "normal",
      onSelect: () => setMode("normal"),
    },
  ])

  const closePopover = () => setStore("popover", null)

  const resetHistoryNavigation = (force = false) => {
    if (!force && (store.historyIndex < 0 || store.applyingHistory)) return
    setStore("historyIndex", -1)
    setStore("savedPrompt", null)
  }

  const clearEditor = () => {
    editorRef.innerHTML = ""
  }

  const setEditorText = (text: string) => {
    clearEditor()
    editorRef.textContent = text
  }

  const focusEditorEnd = () => {
    requestAnimationFrame(() => {
      editorRef.focus()
      const range = document.createRange()
      const selection = window.getSelection()
      range.selectNodeContents(editorRef)
      range.collapse(false)
      selection?.removeAllRanges()
      selection?.addRange(range)
    })
  }

  const currentCursor = () => {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || !editorRef.contains(selection.anchorNode)) return null
    return getCursorPosition(editorRef)
  }

  const restoreFocus = () => {
    requestAnimationFrame(() => {
      const cursor = prompt.cursor() ?? promptLength(prompt.current())
      editorRef.focus()
      setCursorPosition(editorRef, cursor)
      queueScroll()
    })
  }

  const renderEditorWithCursor = (parts: Prompt) => {
    const cursor = currentCursor()
    renderEditor(parts)
    if (cursor !== null) setCursorPosition(editorRef, cursor)
  }

  createEffect(() => {
    props.controls.session.id
    if (props.controls.session.id) return
    if (!suggest()) return
    const interval = setInterval(() => {
      setStore("placeholder", (prev) => (prev + 1) % EXAMPLES.length)
    }, 6500)
    onCleanup(() => clearInterval(interval))
  })

  const [composing, setComposing] = createSignal(false)
  const isImeComposing = (event: KeyboardEvent) => event.isComposing || composing() || event.keyCode === 229

  const handleBlur = () => {
    closePopover()
    setComposing(false)
  }

  const handleCompositionStart = () => {
    setComposing(true)
  }

  const handleCompositionEnd = () => {
    setComposing(false)
    requestAnimationFrame(() => {
      if (composing()) return
      reconcile(prompt.current().filter((part) => part.type !== "image"))
    })
  }

  const agentList = createMemo(() =>
    props.controls.agents.available
      .filter((agent) => !agent.hidden && agent.mode !== "primary")
      .map((agent): AtOption => ({ type: "agent", name: agent.name, display: agent.name })),
  )

  const [toolList] = createResource(
    () => {
      const model = props.controls.model.selection.current()
      return {
        directory: sdk().directory,
        provider: model?.provider?.id,
        model: model?.id,
      }
    },
    async (input) => {
      const sort = (items: AtOption[]) =>
        items.sort((a, b) => {
          if (a.type !== "tool" || b.type !== "tool") return 0
          const rank = (item: AtOption) => {
            if (item.type !== "tool") return 99
            if (item.source === "swami") return 0
            if (item.source === "browser") return 1
            if (item.source === "preview") return 2
            if (item.source === "terminal") return 3
            if (item.source === "open_design") return 4
            if (item.source === "mac_view") return 5
            if (item.source === "resource") return 6
            if (item.source === "artifact") return 7
            if (item.source === "file_browser") return 8
            if (item.source === "account") return 9
            if (item.source === "routines") return 10
            if (item.source === "mcp") return 11
            return 12
          }
          return rank(a) - rank(b) || a.name.localeCompare(b.name)
        })

      if (input.provider && input.model) {
        try {
          const response = await sdk().client.tool.list({
            directory: input.directory,
            provider: input.provider,
            model: input.model,
          })
          const options = (response.data ?? []).map((tool) =>
            optionForToolMention({
              id: tool.id,
              description: tool.description,
            }),
          )
          return sort(uniqueToolMentions([...SWAMI_TOOL_MENTIONS, ...WORKSPACE_TOOL_MENTIONS, ...options]))
        } catch {
          // Fall through to the model-independent list so @tool mentions still work while models load.
        }
      }

      const response = await sdk().client.tool.ids({ directory: input.directory })
      return sort(
        uniqueToolMentions([
          ...SWAMI_TOOL_MENTIONS,
          ...WORKSPACE_TOOL_MENTIONS,
          ...RESOURCES_SECTION_MENTIONS,
          ...(response.data ?? []).map((id) => optionForToolMention({ id })),
        ]),
      )
    },
  )

  const handleAtSelect = (option: AtOption | undefined) => {
    if (!option) return
    if (option.type === "agent") {
      addPart({ type: "agent", name: option.name, content: "@" + option.name, start: 0, end: 0 })
    } else if (option.type === "tool") {
      const panelTab = workspacePanelTabForTool(option.id, option.source)
      if (panelTab) {
        props.controls.session.reviewPanel.open()
        void props.controls.session.tabs.open(panelTab)
        props.controls.session.tabs.setActive(panelTab)
        if (panelTab === "panel://resources") {
          const section = RESOURCES_SECTION_BY_MENTION[option.id]
          if (section && typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("opencode:resources-section", { detail: { section } }))
          }
        }
      }
      addPart({
        type: "tool",
        id: option.id,
        name: option.name,
        source: option.source,
        description: option.description,
        icon: option.icon,
        content: "@" + option.name,
        start: 0,
        end: 0,
      })
    } else {
      addPart({ type: "file", path: option.path, content: "@" + option.path, start: 0, end: 0 })
    }
  }

  const atKey = (x: AtOption | undefined) => {
    if (!x) return ""
    if (x.type === "agent") return `agent:${x.name}`
    if (x.type === "tool") return `tool:${x.id}`
    return `file:${x.path}`
  }

  const {
    flat: atFlat,
    active: atActive,
    setActive: setAtActive,
    onInput: atOnInput,
    onKeyDown: atOnKeyDown,
  } = useFilteredList<AtOption>({
    items: async (query) => {
      const agents = agentList()
      const tools = toolList() ?? []
      const open = recent()
      const seen = new Set(open)
      const pinned: AtOption[] = open.map((path) => ({ type: "file", path, display: path, recent: true }))
      if (!query.trim()) return [...agents, ...tools, ...pinned]
      const paths = await files.searchFilesAndDirectories(query)
      const fileOptions: AtOption[] = paths
        .filter((path) => !seen.has(path))
        .map((path) => ({ type: "file", path, display: path }))
      return [...agents, ...tools, ...pinned, ...fileOptions]
    },
    key: atKey,
    filterKeys: ["display"],
    skipFilter: (item) => item.type === "file" && !item.recent,
    groupBy: (item) => {
      if (item.type === "agent") return "agent"
      if (item.type === "tool") return "tool"
      if (item.recent) return "recent"
      return "file"
    },
    sortGroupsBy: (a, b) => {
      const rank = (category: string) => {
        if (category === "agent") return 0
        if (category === "tool") return 1
        if (category === "recent") return 2
        return 3
      }
      return rank(a.category) - rank(b.category)
    },
    onSelect: handleAtSelect,
  })

  const slashCommands = createMemo<SlashCommand[]>(() => {
    const builtin = command.options
      .filter((opt) => !opt.disabled && !opt.id.startsWith("suggested.") && opt.slash)
      .map((opt) => ({
        id: opt.id,
        trigger: opt.slash!,
        title: opt.title,
        description: opt.description,
        keybind: opt.keybind,
        type: "builtin" as const,
      }))

    const custom = sync().data.command.map((cmd) => ({
      id: `custom.${cmd.name}`,
      trigger: cmd.name,
      title: cmd.name,
      description: cmd.description,
      type: "custom" as const,
      source: cmd.source,
    }))

    return [...custom, ...builtin]
  })

  const handleSlashSelect = (cmd: SlashCommand | undefined) => {
    if (!cmd) return
    closePopover()
    const images = imageAttachments()

    if (cmd.type === "custom") {
      const text = `/${cmd.trigger} `
      setEditorText(text)
      prompt.set([{ type: "text", content: text, start: 0, end: text.length }, ...images], text.length)
      focusEditorEnd()
      return
    }

    clearEditor()
    prompt.set([...DEFAULT_PROMPT, ...images], 0)
    command.trigger(cmd.id, "slash")
  }

  const {
    flat: slashFlat,
    active: slashActive,
    setActive: setSlashActive,
    onInput: slashOnInput,
    onKeyDown: slashOnKeyDown,
  } = useFilteredList<SlashCommand>({
    items: slashCommands,
    key: (x) => x?.id,
    filterKeys: ["trigger", "title"],
    onSelect: handleSlashSelect,
  })

  const createPill = (part: FileAttachmentPart | AgentPart | ToolPart) => {
    const pill = document.createElement("span")
    pill.textContent = part.content
    pill.setAttribute("data-type", part.type)
    if (part.type === "file") pill.setAttribute("data-path", part.path)
    if (part.type === "agent") pill.setAttribute("data-name", part.name)
    if (part.type === "tool") {
      pill.setAttribute("data-id", part.id)
      pill.setAttribute("data-name", part.name)
      pill.setAttribute("data-source", part.source)
      if (part.description) pill.setAttribute("data-description", part.description)
      if (part.icon) pill.setAttribute("data-icon", part.icon)
      pill.style.color = "#f97316"
    }
    pill.setAttribute("contenteditable", "false")
    pill.style.userSelect = "text"
    pill.style.cursor = "default"
    return pill
  }

  const isNormalizedEditor = () =>
    Array.from(editorRef.childNodes).every((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? ""
        if (!text.includes("\u200B")) return true
        if (text !== "\u200B") return false

        const prev = node.previousSibling
        const next = node.nextSibling
        const prevIsBr = prev?.nodeType === Node.ELEMENT_NODE && (prev as HTMLElement).tagName === "BR"
        return !!prevIsBr && !next
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return false
      const el = node as HTMLElement
      if (el.dataset.type === "file") return true
      if (el.dataset.type === "agent") return true
      if (el.dataset.type === "tool") return true
      return el.tagName === "BR"
    })

  const renderEditor = (parts: Prompt) => {
    clearEditor()
    for (const part of parts) {
      if (part.type === "text") {
        editorRef.appendChild(createTextFragment(part.content))
        continue
      }
      if (part.type === "file" || part.type === "agent" || part.type === "tool") {
        editorRef.appendChild(createPill(part))
      }
    }

    const last = editorRef.lastChild
    if (last?.nodeType === Node.ELEMENT_NODE && (last as HTMLElement).tagName === "BR") {
      editorRef.appendChild(document.createTextNode("\u200B"))
    }
  }

  // Auto-scroll active command into view when navigating with keyboard
  createEffect(() => {
    const activeId = slashActive()
    if (!activeId || !slashPopoverRef) return

    requestAnimationFrame(() => {
      const element = slashPopoverRef.querySelector(`[data-slash-id="${activeId}"]`)
      element?.scrollIntoView({ block: "nearest", behavior: "smooth" })
    })
  })
  const selectPopoverActive = () => {
    if (store.popover === "at") {
      const items = atFlat()
      if (items.length === 0) return
      const active = atActive()
      const item = items.find((entry) => atKey(entry) === active) ?? items[0]
      handleAtSelect(item)
      return
    }

    if (store.popover === "slash") {
      const items = slashFlat()
      if (items.length === 0) return
      const active = slashActive()
      const item = items.find((entry) => entry.id === active) ?? items[0]
      handleSlashSelect(item)
    }
  }

  const reconcile = (input: Prompt) => {
    if (mirror.input) {
      mirror.input = false
      if (isNormalizedEditor()) return

      renderEditorWithCursor(input)
      return
    }

    const dom = parseFromDOM()
    if (isNormalizedEditor() && isPromptEqual(input, dom)) return

    renderEditorWithCursor(input)
  }

  createEffect(
    on(
      () => prompt.current(),
      (parts) => {
        if (composing()) return
        reconcile(parts.filter((part) => part.type !== "image"))
      },
    ),
  )

  const parseFromDOM = (): Prompt => {
    const parts: Prompt = []
    let position = 0
    let buffer = ""

    const flushText = () => {
      let content = buffer
      if (content.includes("\r")) content = content.replace(/\r\n?/g, "\n")
      if (content.includes("\u200B")) content = content.replace(/\u200B/g, "")
      buffer = ""
      if (!content) return
      parts.push({ type: "text", content, start: position, end: position + content.length })
      position += content.length
    }

    const pushFile = (file: HTMLElement) => {
      const content = file.textContent ?? ""
      parts.push({
        type: "file",
        path: file.dataset.path!,
        content,
        start: position,
        end: position + content.length,
      })
      position += content.length
    }

    const pushAgent = (agent: HTMLElement) => {
      const content = agent.textContent ?? ""
      parts.push({
        type: "agent",
        name: agent.dataset.name!,
        content,
        start: position,
        end: position + content.length,
      })
      position += content.length
    }

    const pushTool = (tool: HTMLElement) => {
      const content = tool.textContent ?? ""
      parts.push({
        type: "tool",
        id: tool.dataset.id!,
        name: tool.dataset.name ?? tool.dataset.id!,
        source: (tool.dataset.source as ToolPartSource | undefined) ?? classifyToolMention(tool.dataset.id!),
        description: tool.dataset.description,
        icon: tool.dataset.icon,
        content,
        start: position,
        end: position + content.length,
      })
      position += content.length
    }

    const visit = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        buffer += node.textContent ?? ""
        return
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return

      const el = node as HTMLElement
      if (el.dataset.type === "file") {
        flushText()
        pushFile(el)
        return
      }
      if (el.dataset.type === "agent") {
        flushText()
        pushAgent(el)
        return
      }
      if (el.dataset.type === "tool") {
        flushText()
        pushTool(el)
        return
      }
      if (el.tagName === "BR") {
        buffer += "\n"
        return
      }

      for (const child of Array.from(el.childNodes)) {
        visit(child)
      }
    }

    const children = Array.from(editorRef.childNodes)
    children.forEach((child, index) => {
      const isBlock = child.nodeType === Node.ELEMENT_NODE && ["DIV", "P"].includes((child as HTMLElement).tagName)
      visit(child)
      if (isBlock && index < children.length - 1) {
        buffer += "\n"
      }
    })

    flushText()

    if (parts.length === 0) parts.push(...DEFAULT_PROMPT)
    return parts
  }

  const handleInput = () => {
    const rawParts = parseFromDOM()
    const images = imageAttachments()
    const cursorPosition = getCursorPosition(editorRef)
    const rawText =
      rawParts.length === 1 && rawParts[0]?.type === "text"
        ? rawParts[0].content
        : rawParts.map((p) => ("content" in p ? p.content : "")).join("")
    const hasNonText = rawParts.some((part) => part.type !== "text")
    const textContent = (editorRef.textContent ?? "").replace(/\u200B/g, "")
    const shouldReset =
      textContent.length === 0 && rawText.replace(/\n/g, "").length === 0 && !hasNonText && images.length === 0

    if (shouldReset) {
      closePopover()
      resetHistoryNavigation()
      if (prompt.dirty()) {
        mirror.input = true
        prompt.set(DEFAULT_PROMPT, 0)
      }
      queueScroll()
      return
    }

    const shellMode = store.mode === "shell"

    if (!shellMode) {
      const atMatch = rawText.substring(0, cursorPosition).match(/@(\S*)$/)
      const slashMatch = rawText.match(/^\/(\S*)$/)

      if (atMatch) {
        atOnInput(atMatch[1])
        setStore("popover", "at")
      } else if (slashMatch) {
        slashOnInput(slashMatch[1])
        setStore("popover", "slash")
      } else {
        closePopover()
      }
    } else {
      closePopover()
    }

    resetHistoryNavigation()

    mirror.input = true
    prompt.set([...rawParts, ...images], cursorPosition)
    queueScroll()
  }

  const addPart = (part: ContentPart) => {
    if (part.type === "image") return false

    const selection = window.getSelection()
    if (!selection) return false

    if (selection.rangeCount === 0 || !editorRef.contains(selection.anchorNode)) {
      editorRef.focus()
      const cursor = prompt.cursor() ?? promptLength(prompt.current())
      setCursorPosition(editorRef, cursor)
    }

    if (selection.rangeCount === 0) return false
    const range = selection.getRangeAt(0)
    if (!editorRef.contains(range.startContainer)) return false

    if (part.type === "file" || part.type === "agent" || part.type === "tool") {
      const cursorPosition = getCursorPosition(editorRef)
      const rawText = prompt
        .current()
        .map((p) => ("content" in p ? p.content : ""))
        .join("")
      const textBeforeCursor = rawText.substring(0, cursorPosition)
      const atMatch = textBeforeCursor.match(/@(\S*)$/)
      const pill = createPill(part)
      const gap = document.createTextNode(" ")

      if (atMatch) {
        const start = atMatch.index ?? cursorPosition - atMatch[0].length
        setRangeEdge(editorRef, range, "start", start)
        setRangeEdge(editorRef, range, "end", cursorPosition)
      }

      range.deleteContents()
      range.insertNode(gap)
      range.insertNode(pill)
      range.setStartAfter(gap)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    }

    if (part.type === "text") {
      const fragment = createTextFragment(part.content)
      const last = fragment.lastChild
      range.deleteContents()
      range.insertNode(fragment)
      if (last) {
        if (last.nodeType === Node.TEXT_NODE) {
          const text = last.textContent ?? ""
          if (text === "\u200B") {
            range.setStart(last, 0)
          }
          if (text !== "\u200B") {
            range.setStart(last, text.length)
          }
        }
        if (last.nodeType !== Node.TEXT_NODE) {
          const isBreak = last.nodeType === Node.ELEMENT_NODE && (last as HTMLElement).tagName === "BR"
          const next = last.nextSibling
          const emptyText = next?.nodeType === Node.TEXT_NODE && (next.textContent ?? "") === ""
          if (isBreak && (!next || emptyText)) {
            const placeholder = next && emptyText ? next : document.createTextNode("\u200B")
            if (!next) last.parentNode?.insertBefore(placeholder, null)
            placeholder.textContent = "\u200B"
            range.setStart(placeholder, 0)
          } else {
            range.setStartAfter(last)
          }
        }
      }
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    }

    handleInput()
    closePopover()
    return true
  }

  const addToHistory = (prompt: Prompt, mode: "normal" | "shell") => {
    history.add(prompt, mode, mode === "shell" ? [] : historyComments())
  }

  createEffect(
    on(
      () => props.edit?.id,
      (id) => {
        const edit = props.edit
        if (!id || !edit) return

        for (const item of prompt.context.items()) {
          prompt.context.remove(item.key)
        }

        for (const item of edit.context) {
          prompt.context.add({
            type: item.type,
            path: item.path,
            selection: item.selection,
            comment: item.comment,
            commentID: item.commentID,
            commentOrigin: item.commentOrigin,
            preview: item.preview,
          })
        }

        setStore("mode", "normal")
        setStore("popover", null)
        setStore("historyIndex", -1)
        setStore("savedPrompt", null)
        prompt.set(edit.prompt, promptLength(edit.prompt))
        requestAnimationFrame(() => {
          editorRef.focus()
          setCursorPosition(editorRef, promptLength(edit.prompt))
          queueScroll()
        })
        props.onEditLoaded?.()
      },
      { defer: true },
    ),
  )

  const navigateHistory = (direction: "up" | "down") => {
    const result = navigatePromptHistory({
      direction,
      entries: history.entries(store.mode),
      historyIndex: store.historyIndex,
      currentPrompt: prompt.current(),
      currentComments: historyComments(),
      savedPrompt: store.savedPrompt,
    })
    if (!result.handled) return false
    setStore("historyIndex", result.historyIndex)
    setStore("savedPrompt", result.savedPrompt)
    applyHistoryPrompt(result.entry, result.cursor)
    return true
  }

  const { addAttachment, addAttachments, removeAttachment, handlePaste } = createPromptAttachments({
    prompt,
    editor: () => editorRef,
    isDialogActive: () => !!dialog.active,
    setDraggingType: (type) => setStore("draggingType", type),
    focusEditor: () => {
      editorRef.focus()
      setCursorPosition(editorRef, promptLength(prompt.current()))
    },
    addPart,
    readClipboardImage: platform.readClipboardImage,
    getPathForFile: platform.getPathForFile,
  })

  createEffect(() => {
    const addImageAttachment = (event: Event) => {
      if (!(event instanceof CustomEvent)) return
      const detail = event.detail as Partial<ImageAttachmentPart>
      if (!detail?.dataUrl || !detail?.filename || !detail?.mime) return
      const attachment: ImageAttachmentPart = {
        type: "image",
        id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}`,
        filename: detail.filename,
        sourcePath: detail.sourcePath,
        mime: detail.mime,
        dataUrl: detail.dataUrl,
      }
      prompt.set([...prompt.current(), attachment], prompt.cursor())
      showToast({ title: "Screenshot attached", description: detail.filename })
    }
    window.addEventListener("opencode:add-image-attachment", addImageAttachment)
    onCleanup(() => window.removeEventListener("opencode:add-image-attachment", addImageAttachment))
  })

  const fileAttachmentInput = () => (
    <input
      ref={(el) => (fileInputRef = el)}
      type="file"
      multiple
      accept={ACCEPTED_FILE_TYPES.join(",")}
      class="hidden"
      onChange={(e) => {
        const list = e.currentTarget.files
        if (list) void addAttachments(Array.from(list))
        e.currentTarget.value = ""
      }}
    />
  )

  const variants = createMemo(() => ["default", ...props.controls.model.selection.variant.list()])
  // Check provider variants directly: `variants` also includes the UI-only default option.
  const showVariantControl = createMemo(() => props.controls.model.selection.variant.list().length > 0)
  const accepting = createMemo(() => {
    const id = props.controls.session.id
    if (!id) return permission.isAutoAcceptingDirectory(sdk().directory)
    return permission.isAutoAccepting(id, sdk().directory)
  })

  const { abort, handleSubmit } =
    props.submission ??
    createPromptSubmit({
      prompt,
      info,
      imageAttachments,
      commentCount,
      autoAccept: () => accepting(),
      mode: () => store.mode,
      working,
      editor: () => editorRef,
      queueScroll,
      promptLength,
      addToHistory,
      resetHistoryNavigation: () => {
        resetHistoryNavigation(true)
      },
      setMode: (mode) => setStore("mode", mode),
      setPopover: (popover) => setStore("popover", popover),
      newSessionWorktree: () => props.newSessionWorktree,
      onNewSessionWorktreeReset: props.onNewSessionWorktreeReset,
      shouldQueue: props.shouldQueue,
      onQueue: props.onQueue,
      onAbort: props.onAbort,
      onSubmit: props.onSubmit,
    })

  const handleKeyDown = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "u") {
      event.preventDefault()
      if (store.mode !== "normal") return
      pick()
      return
    }

    if (event.key === "Backspace") {
      const selection = window.getSelection()
      if (selection && selection.isCollapsed) {
        const node = selection.anchorNode
        const offset = selection.anchorOffset
        if (node && node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent ?? ""
          if (/^\u200B+$/.test(text) && offset > 0) {
            const range = document.createRange()
            range.setStart(node, 0)
            range.collapse(true)
            selection.removeAllRanges()
            selection.addRange(range)
          }
        }
      }
    }

    if (event.key === "!" && store.mode === "normal") {
      const cursorPosition = getCursorPosition(editorRef)
      if (cursorPosition === 0) {
        setStore("mode", "shell")
        setStore("popover", null)
        event.preventDefault()
        return
      }
    }

    if (event.key === "Escape") {
      if (store.popover) {
        closePopover()
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (store.mode === "shell") {
        setStore("mode", "normal")
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (working()) {
        void abort()
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (escBlur()) {
        editorRef.blur()
        event.preventDefault()
        event.stopPropagation()
        return
      }
    }

    if (store.mode === "shell") {
      const { collapsed, cursorPosition, textLength } = getCaretState()
      if (event.key === "Backspace" && collapsed && cursorPosition === 0 && textLength === 0) {
        setStore("mode", "normal")
        event.preventDefault()
        return
      }
    }

    // Handle Shift+Enter BEFORE IME check - Shift+Enter is never used for IME input
    // and should always insert a newline regardless of composition state
    if (event.key === "Enter" && event.shiftKey) {
      addPart({ type: "text", content: "\n", start: 0, end: 0 })
      event.preventDefault()
      return
    }

    if (event.key === "Enter" && isImeComposing(event)) {
      return
    }

    const ctrl = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey

    if (store.popover) {
      if (event.key === "Tab") {
        selectPopoverActive()
        event.preventDefault()
        return
      }
      const nav = event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Enter"
      const ctrlNav = ctrl && (event.key === "n" || event.key === "p")
      if (nav || ctrlNav) {
        if (store.popover === "at") {
          atOnKeyDown(event)
          event.preventDefault()
          return
        }
        if (store.popover === "slash") {
          slashOnKeyDown(event)
        }
        event.preventDefault()
        return
      }
    }

    if (ctrl && event.code === "KeyG") {
      if (store.popover) {
        closePopover()
        event.preventDefault()
        return
      }
      if (working()) {
        void abort()
        event.preventDefault()
      }
      return
    }

    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      if (event.altKey || event.ctrlKey || event.metaKey) return
      const { collapsed } = getCaretState()
      if (!collapsed) return

      const cursorPosition = getCursorPosition(editorRef)
      const textContent = prompt
        .current()
        .map((part) => ("content" in part ? part.content : ""))
        .join("")
      const direction = event.key === "ArrowUp" ? "up" : "down"
      if (!canNavigateHistoryAtCursor(direction, textContent, cursorPosition, store.historyIndex >= 0)) return
      if (navigateHistory(direction)) {
        event.preventDefault()
      }
      return
    }

    // Note: Shift+Enter is handled earlier, before IME check
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      if (event.repeat) return
      if (
        working() &&
        prompt
          .current()
          .map((part) => ("content" in part ? part.content : ""))
          .join("")
          .trim().length === 0 &&
        imageAttachments().length === 0 &&
        commentCount() === 0
      ) {
        return
      }
      void handleComposerSubmit(event)
    }
  }

  const agentsLoading = () => props.controls.agents.loading
  const agentsShouldFadeIn = createMemo<boolean>((prev) => prev ?? agentsLoading())
  const providersLoading = () => props.controls.model.loading
  const providersShouldFadeIn = createMemo<boolean>((prev) => prev ?? providersLoading())

  const [promptReady] = createResource(
    () => prompt.ready.promise,
    (p) => p,
  )

  const [openDesignBridgeState, setOpenDesignBridgeState] = createSignal<OpenDesignBridgePromptState | undefined>(
    readOpenDesignBridgeState(),
  )
  if (typeof window !== "undefined") {
    const syncOpenDesignBridgeState = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : readOpenDesignBridgeState()
      if (!detail || typeof detail !== "object") {
        setOpenDesignBridgeState(undefined)
        return
      }
      setOpenDesignBridgeState(detail as OpenDesignBridgePromptState)
    }
    window.addEventListener(OPEN_DESIGN_BRIDGE_EVENT, syncOpenDesignBridgeState)
    onCleanup(() => window.removeEventListener(OPEN_DESIGN_BRIDGE_EVENT, syncOpenDesignBridgeState))
  }

  const designModeBridge = createMemo(() => {
    const state = openDesignBridgeState()
    if (!state?.active) return undefined
    return state
  })

  const designModeTitle = createMemo(() => {
    const state = designModeBridge()
    if (!state) return undefined
    return state.projectName ?? state.projectId ?? "OpenDesign"
  })

  const designModeSubtitle = createMemo(() => {
    const state = designModeBridge()
    if (!state) return undefined
    return state.chatName ?? state.chatId ?? (state.focusMode ? "Focus Mode" : "Project workspace")
  })

  const openDesignPanel = () => {
    props.controls.session.reviewPanel.open()
    const result = props.controls.session.tabs.open("panel://open-design")
    void Promise.resolve(result).finally(() => props.controls.session.tabs.setActive("panel://open-design"))
    restoreFocus()
  }

  // When the embedded Open Design build advertises the inbound prompt bridge,
  // the composer drives the active Open Design chat instead of the OpenCode LLM,
  // so the two chats are not redundant.
  const designBridgeActive = createMemo(() => {
    const state = designModeBridge()
    return !!state && state.acceptsPrompts === true && store.mode !== "shell"
  })

  const composerText = () =>
    prompt
      .current()
      .map((part: any) => ("content" in part ? part.content : ""))
      .join("")

  const submitToOpenDesign = () => {
    const text = composerText().trim()
    if (!text || typeof window === "undefined") return false
    window.dispatchEvent(new CustomEvent("opencode:open-design-submit", { detail: { prompt: text } }))
    prompt.reset()
    openDesignPanel()
    return true
  }

  const handleComposerSubmit = (event: Event) => {
    if (designBridgeActive()) {
      event.preventDefault()
      submitToOpenDesign()
      return
    }
    return handleSubmit(event)
  }

  const designConversations = createMemo(() => {
    const list = designModeBridge()?.conversations
    return Array.isArray(list) ? list : []
  })
  const designActiveChatId = createMemo(() => designModeBridge()?.activeConversationId ?? designModeBridge()?.chatId ?? null)
  const designModelLabel = createMemo(() => {
    const state = designModeBridge()
    if (!state?.model) return undefined
    return state.apiProtocol ? `${state.model} · ${state.apiProtocol}` : state.model
  })
  const switchDesignChat = (chatId: string) => {
    if (!chatId || chatId === designActiveChatId() || typeof window === "undefined") return
    window.dispatchEvent(new CustomEvent("opencode:open-design-switch-chat", { detail: { chatId } }))
  }
  const newDesignChat = () => {
    if (typeof window === "undefined") return
    window.dispatchEvent(new CustomEvent("opencode:open-design-new-chat"))
    openDesignPanel()
  }
  const designSlashCommands = createMemo(() => {
    const list = designModeBridge()?.slashCommands
    return Array.isArray(list) && list.length > 0 ? list : DEFAULT_OPEN_DESIGN_COMMANDS
  })
  const designModelTooltip = createMemo(() => {
    const state = designModeBridge()
    if (!state?.model) return undefined
    return `This Open Design chat runs on ${state.model}${state.apiProtocol ? ` (${state.apiProtocol})` : ""} — Open Design's own provider, not the OpenCode-selected model. Change it in the Open Design tab → Settings.`
  })
  // Insert an Open Design slash-command into the composer (which routes it to the
  // OD chat). Mirrors handleSlashSelect: sync the editor DOM + the prompt store.
  const insertDesignCommand = (label: string) => {
    const text = `${label} `
    setEditorText(text)
    prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
    focusEditorEnd()
  }

  const designPlaceholder = () => {
    if (store.mode === "shell") return placeholder()
    const title = designModeTitle()
    if (title) return designBridgeActive() ? `Message Open Design: ${title}` : `Design Mode: ${title}`
    return "Ask anything, / for commands, @ for context..."
  }

  const modelControlState = createMemo<ComposerModelControlState>(() => ({
    loading: providersLoading(),
    shouldAnimate: providersShouldFadeIn(),
    paid: props.controls.model.paid,
    title: language.t("command.model.choose"),
    keybind: command.keybindParts("model.choose"),
    model: props.controls.model.selection,
    providerID: props.controls.model.selection.current()?.provider?.id,
    modelName: props.controls.model.selection.current()?.name ?? language.t("dialog.model.select.title"),
    style: control(),
    onClose: restoreFocus,
    onUnpaidClick: () => {
      void import("@/components/dialog-select-model-unpaid").then((x) => {
        dialog.show(() => <x.DialogSelectModelUnpaid model={props.controls.model.selection} />)
      })
    },
  }))
  const codexMultiAuthActive = createMemo(
    () => props.controls.model.selection.current()?.provider?.id === CODEX_MULTI_AUTH_PROVIDER_ID,
  )
  const openCodexAccountsPanel = () => {
    const tab = "panel://resources"
    props.controls.session.tabs.open(tab)
    props.controls.session.tabs.setActive(tab)
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("opencode:resources-section", { detail: { section: "codex" } }))
    }
  }

  const newSession = () => props.variant === "new-session"
  const showAgentControl = createMemo(() => props.controls.agents.visible && props.controls.agents.options.length > 0)
  const agentControlState = createMemo<ComposerAgentControlState>(() => ({
    title: language.t("command.agent.cycle"),
    keybind: command.keybindParts("agent.cycle"),
    options: props.controls.agents.options,
    current: props.controls.agents.current,
    style: control(),
    onSelect: (value) => {
      props.controls.agents.select(value)
      restoreFocus()
    },
  }))
  return (
    <div class="relative size-full flex flex-col gap-0">
      {(promptReady(), null)}
      <PromptPopover
        popover={store.popover}
        setSlashPopoverRef={(el) => (slashPopoverRef = el)}
        atFlat={atFlat()}
        atActive={atActive() ?? undefined}
        atKey={atKey}
        setAtActive={setAtActive}
        onAtSelect={handleAtSelect}
        slashFlat={slashFlat()}
        slashActive={slashActive() ?? undefined}
        setSlashActive={setSlashActive}
        onSlashSelect={handleSlashSelect}
        commandKeybind={command.keybind}
        t={(key) => language.t(key as Parameters<typeof language.t>[0])}
      />
      <Switch>
        <Match when={props.controls.newLayoutDesigns}>
          <div class="flex flex-col gap-3">
            <DockShellForm
              data-component={newSession() ? "session-new-composer" : "session-composer"}
              onSubmit={handleComposerSubmit}
              classList={{
                "group/prompt-input min-h-[96px] w-full rounded-xl bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]": true,
                "ring-1 ring-blue-400/45 shadow-[0_0_0_1px_rgba(96,165,250,0.24),0_18px_48px_rgba(37,99,235,0.20)]":
                  !!designModeBridge(),
                "border-icon-info-active border-dashed": store.draggingType !== null,
                [props.class ?? ""]: !!props.class,
              }}
            >
              <PromptDragOverlay
                type={store.draggingType}
                label={language.t(
                  store.draggingType === "@mention" ? "prompt.dropzone.file.label" : "prompt.dropzone.label",
                )}
              />
              <Show when={designModeBridge()}>
                {(bridge) => (
                  <div class="mx-2 mt-2 flex max-w-[calc(100%-1rem)] flex-wrap items-center gap-0.5 rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-02 p-1 text-[12px] leading-4">
                    <button
                      type="button"
                      data-action="prompt-design-mode"
                      class="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-v2-text-text-base transition-colors hover:bg-v2-background-bg-base"
                      onClick={openDesignPanel}
                      title="Open the Open Design tab"
                    >
                      <span class="flex size-[15px] shrink-0 items-center justify-center rounded bg-[#f97316]/15 text-[7px] font-semibold tracking-tight text-[#f97316]">
                        OD
                      </span>
                      <span class="font-[560] text-v2-text-text-faint">Design</span>
                      <span class="min-w-0 truncate">{bridge().projectName ?? bridge().projectId ?? "OpenDesign"}</span>
                    </button>
                    <Show when={designBridgeActive()}>
                      <span class="mx-0.5 h-4 w-px shrink-0 bg-v2-border-border-base" />
                      <Show
                        when={designConversations().length > 0}
                        fallback={
                          <Show when={bridge().chatName ?? bridge().chatId}>
                            {(chat) => (
                              <span class="min-w-0 max-w-[140px] truncate rounded-md px-1.5 py-1 text-v2-text-text-muted">
                                {chat()}
                              </span>
                            )}
                          </Show>
                        }
                      >
                        <select
                          data-action="prompt-design-chat"
                          class="max-w-[150px] cursor-pointer rounded-md bg-transparent px-1.5 py-1 text-v2-text-text-base outline-none transition-colors hover:bg-v2-background-bg-base"
                          value={designActiveChatId() ?? ""}
                          onChange={(event) => switchDesignChat(event.currentTarget.value)}
                          title="Switch Open Design chat"
                        >
                          <For each={designConversations()}>
                            {(conversation: { id: string; title?: string | null }) => (
                              <option value={conversation.id}>{conversation.title || "Untitled chat"}</option>
                            )}
                          </For>
                        </select>
                      </Show>
                      <button
                        type="button"
                        data-action="prompt-design-new-chat"
                        class="flex size-6 shrink-0 items-center justify-center rounded-md text-v2-text-text-muted transition-colors hover:bg-v2-background-bg-base hover:text-v2-text-text-base"
                        onClick={newDesignChat}
                        title="Start a new Open Design chat"
                        aria-label="Start a new Open Design chat"
                      >
                        <Icon name="plus-small" size="small" />
                      </button>
                      <details class="group relative shrink-0" data-action="prompt-design-commands">
                        <summary
                          class="flex h-6 cursor-pointer list-none items-center rounded-md px-1.5 text-[12px] text-v2-text-text-muted transition-colors hover:bg-v2-background-bg-base hover:text-v2-text-text-base [&::-webkit-details-marker]:hidden"
                          title="Open Design chat commands"
                        >
                          /
                        </summary>
                        <div class="absolute bottom-8 left-0 z-30 w-64 rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-01 p-1 shadow-[var(--v2-elevation-floating)]">
                          <div class="px-2 py-1 text-[10px] uppercase tracking-wide text-v2-text-text-faint">
                            Open Design commands
                          </div>
                          <For each={designSlashCommands()}>
                            {(command: { label: string; hint?: string | null }) => (
                              <button
                                type="button"
                                data-action="prompt-design-command-item"
                                class="flex w-full flex-col items-start rounded-md px-2 py-1 text-left transition-colors hover:bg-v2-background-bg-base"
                                onClick={() => insertDesignCommand(command.label)}
                              >
                                <span class="text-[12px] font-[540] text-v2-text-text-base">{command.label}</span>
                                <Show when={command.hint}>
                                  <span class="text-[11px] text-v2-text-text-muted">{command.hint}</span>
                                </Show>
                              </button>
                            )}
                          </For>
                        </div>
                      </details>
                      <Show when={designModelLabel()}>
                        {(model) => (
                          <span
                            data-action="prompt-design-model"
                            class="ml-auto min-w-0 max-w-[190px] truncate rounded-md bg-v2-background-bg-base px-1.5 py-1 text-[11px] text-v2-text-text-muted"
                            title={designModelTooltip()}
                          >
                            {model()}
                          </span>
                        )}
                      </Show>
                    </Show>
                  </div>
                )}
              </Show>
              <PromptContextItems
                items={contextItems()}
                active={(item) => {
                  const active = comments.active()
                  return !!item.commentID && item.commentID === active?.id && item.path === active?.file
                }}
                openComment={openComment}
                remove={(item) => {
                  if (item.commentID) comments.remove(item.path, item.commentID)
                  prompt.context.remove(item.key)
                }}
                t={(key) => language.t(key as Parameters<typeof language.t>[0])}
              />
              <PromptImageAttachments
                attachments={imageAttachments()}
                onOpen={(attachment) =>
                  dialog.show(() => <ImagePreview src={attachment.dataUrl} alt={attachment.filename} />)
                }
                onRemove={removeAttachment}
                removeLabel={language.t("prompt.attachment.remove")}
              />
              <div
                class="relative min-h-[52px]"
                onMouseDown={(e) => {
                  const target = e.target
                  if (!(target instanceof HTMLElement)) return
                  if (target.closest('[data-action^="prompt-"]')) return
                  editorRef?.focus()
                }}
              >
                <div class="relative max-h-[180px] overflow-y-auto no-scrollbar" ref={(el) => (scrollRef = el)}>
                  <div
                    data-component="prompt-input"
                    ref={(el) => {
                      editorRef = el
                      props.ref?.(el)
                    }}
                    role="textbox"
                    aria-multiline="true"
                    aria-label={designPlaceholder()}
                    contenteditable="true"
                    autocapitalize={store.mode === "normal" ? "sentences" : "off"}
                    autocorrect={store.mode === "normal" ? "on" : "off"}
                    spellcheck={store.mode === "normal"}
                    inputMode="text"
                    // @ts-expect-error
                    autocomplete="off"
                    onInput={handleInput}
                    onPaste={handlePaste}
                    onCompositionStart={handleCompositionStart}
                    onCompositionEnd={handleCompositionEnd}
                    onBlur={handleBlur}
                    onKeyDown={handleKeyDown}
                    classList={{
                      "select-text": true,
                      "min-h-[52px] w-full px-4 pt-4 pb-2 focus:outline-none whitespace-pre-wrap leading-5 text-[13px] font-[440] text-v2-text-text-base": true,
                      "[&_[data-type=file]]:text-syntax-property": true,
                      "[&_[data-type=agent]]:text-syntax-type": true,
                      "font-mono!": store.mode === "shell",
                    }}
                  />
                  <div
                    data-component={newSession() ? "session-new-design-text" : "session-composer-text"}
                    class="absolute top-0 inset-x-0 px-4 pt-4 pointer-events-none whitespace-nowrap truncate leading-5 text-[13px] font-[440] text-v2-text-text-faint [font-family:Inter,var(--font-family-sans)]"
                    classList={{ "font-mono!": store.mode === "shell", hidden: prompt.dirty() }}
                  >
                    {designPlaceholder()}
                  </div>
                </div>
              </div>
              <div class="flex h-11 items-center px-2">
                <div class="flex min-w-0 flex-1 items-center gap-0">
                  {fileAttachmentInput()}
                  <TooltipV2
                    placement="top"
                    value={
                      <>
                        {language.t("prompt.action.attachFile")}
                        <KeybindV2 keys={command.keybindParts("file.attach")} variant="neutral" />
                      </>
                    }
                  >
                    <IconButton
                      data-action="prompt-attach"
                      type="button"
                      icon="plus"
                      variant="ghost"
                      class="size-7 rounded-md p-[6px] text-v2-icon-icon-muted"
                      style={buttons()}
                      onClick={pick}
                      disabled={store.mode !== "normal"}
                      tabIndex={store.mode === "normal" ? undefined : -1}
                      aria-label={language.t("prompt.action.attachFile")}
                    />
                  </TooltipV2>
                  <Show when={showAgentControl()}>
                    <ComposerAgentControl state={agentControlState()} />
                  </Show>
                  {props.toolbar}
                  <ComposerModelControl state={modelControlState()} />
                  <Show when={!providersLoading() && store.mode !== "shell"}>
                    <CodexMultiAuthChip
                      active={codexMultiAuthActive()}
                      currentModelName={props.controls.model.selection.current()?.name ?? "model"}
                      openAccounts={openCodexAccountsPanel}
                    />
                  </Show>
                  <Show when={!providersLoading() && store.mode !== "shell" && showVariantControl()}>
                    <div
                      data-component="prompt-variant-control"
                      classList={{
                        "animate-in fade-in": providersShouldFadeIn(),
                        "hidden group-hover/prompt-input:block group-focus-within/prompt-input:block":
                          !props.controls.model.selection.variant.current() && !store.variantOpen,
                      }}
                    >
                      <TooltipV2
                        placement="top"
                        gutter={4}
                        value={
                          <>
                            {language.t("command.model.variant.cycle")}
                            <KeybindV2 keys={command.keybindParts("model.variant.cycle")} variant="neutral" />
                          </>
                        }
                      >
                        <Select
                          size="normal"
                          options={variants()}
                          current={props.controls.model.selection.variant.current() ?? "default"}
                          label={(x) => (x === "default" ? language.t("common.default") : x)}
                          onOpenChange={(open) => setStore("variantOpen", open)}
                          onSelect={(value) => {
                            props.controls.model.selection.variant.set(value === "default" ? undefined : value)
                            restoreFocus()
                          }}
                          class="capitalize max-w-[160px] justify-start text-v2-text-text-faint"
                          valueClass="truncate text-[13px] font-[440] leading-5 text-v2-text-text-faint"
                          triggerStyle={control()}
                          triggerProps={{ "data-action": "prompt-model-variant" }}
                          variant="ghost"
                        />
                      </TooltipV2>
                    </div>
                  </Show>
                </div>
                <TooltipV2 placement="top" inactive={!working() && blank()} value={tip()}>
                  <IconButton
                    data-action="prompt-submit"
                    type="submit"
                    disabled={!working() && blank()}
                    tabIndex={store.mode === "normal" ? undefined : -1}
                    icon={stopping() ? "stop" : store.mode === "shell" ? "arrow-undo-down" : "arrow-up"}
                    variant="primary"
                    class="size-7 rounded-md p-[6px] text-v2-icon-icon-muted shadow-[var(--v2-elevation-button-contrast)] disabled:opacity-50"
                    style={{
                      "background-image":
                        "linear-gradient(180deg,var(--v2-alpha-light-20) 0%,var(--v2-alpha-light-0) 100%),linear-gradient(90deg,var(--v2-background-bg-contrast) 0%,var(--v2-background-bg-contrast) 100%)",
                    }}
                    aria-label={stopping() ? language.t("prompt.action.stop") : language.t("prompt.action.send")}
                  />
                </TooltipV2>
              </div>
            </DockShellForm>
          </div>
        </Match>
        <Match when>
          <DockShellForm
            onSubmit={handleComposerSubmit}
            classList={{
              "group/prompt-input": true,
              "focus-within:shadow-xs-border": true,
              "border-icon-info-active border-dashed": store.draggingType !== null,
              [props.class ?? ""]: !!props.class,
            }}
          >
            <PromptDragOverlay
              type={store.draggingType}
              label={language.t(
                store.draggingType === "@mention" ? "prompt.dropzone.file.label" : "prompt.dropzone.label",
              )}
            />
            <PromptContextItems
              items={contextItems()}
              active={(item) => {
                const active = comments.active()
                return !!item.commentID && item.commentID === active?.id && item.path === active?.file
              }}
              openComment={openComment}
              remove={(item) => {
                if (item.commentID) comments.remove(item.path, item.commentID)
                prompt.context.remove(item.key)
              }}
              t={(key) => language.t(key as Parameters<typeof language.t>[0])}
            />
            <PromptImageAttachments
              attachments={imageAttachments()}
              onOpen={(attachment) =>
                dialog.show(() => <ImagePreview src={attachment.dataUrl} alt={attachment.filename} />)
              }
              onRemove={removeAttachment}
              removeLabel={language.t("prompt.attachment.remove")}
            />
            <div
              class="relative"
              onMouseDown={(e) => {
                const target = e.target
                if (!(target instanceof HTMLElement)) return
                if (target.closest('[data-action="prompt-attach"], [data-action="prompt-submit"]')) {
                  return
                }
                editorRef?.focus()
              }}
            >
              <div
                class="relative max-h-[240px] overflow-y-auto no-scrollbar"
                ref={(el) => (scrollRef = el)}
                style={{ "scroll-padding-bottom": space }}
              >
                <div
                  data-component="prompt-input"
                  ref={(el) => {
                    editorRef = el
                    props.ref?.(el)
                  }}
                  role="textbox"
                  aria-multiline="true"
                  aria-label={placeholder()}
                  contenteditable="true"
                  autocapitalize={store.mode === "normal" ? "sentences" : "off"}
                  autocorrect={store.mode === "normal" ? "on" : "off"}
                  spellcheck={store.mode === "normal"}
                  inputMode="text"
                  // @ts-expect-error
                  autocomplete="off"
                  onInput={handleInput}
                  onPaste={handlePaste}
                  onCompositionStart={handleCompositionStart}
                  onCompositionEnd={handleCompositionEnd}
                  onBlur={handleBlur}
                  onKeyDown={handleKeyDown}
                  classList={{
                    "select-text": true,
                    "w-full pl-3 pr-2 pt-2 text-14-regular text-text-strong focus:outline-none whitespace-pre-wrap": true,
                    "[&_[data-type=file]]:text-syntax-property": true,
                    "[&_[data-type=agent]]:text-syntax-type": true,
                    "font-mono!": store.mode === "shell",
                  }}
                  style={{ "padding-bottom": space }}
                />
                <div
                  class="absolute top-0 inset-x-0 pl-3 pr-2 pt-2 text-14-regular text-text-weak pointer-events-none whitespace-nowrap truncate"
                  classList={{ "font-mono!": store.mode === "shell" }}
                  style={{ "padding-bottom": space, display: prompt.dirty() ? "none" : undefined }}
                >
                  {placeholder()}
                </div>
              </div>

              <div
                aria-hidden="true"
                class="pointer-events-none absolute inset-x-0 bottom-0"
                style={{
                  height: space,
                  background:
                    "linear-gradient(to top, var(--surface-raised-stronger-non-alpha) calc(100% - 20px), transparent)",
                }}
              />

              <div class="pointer-events-none absolute bottom-2 right-2 flex items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept={ACCEPTED_FILE_TYPES.join(",")}
                  class="hidden"
                  onChange={(e) => {
                    const list = e.currentTarget.files
                    if (list) void addAttachments(Array.from(list))
                    e.currentTarget.value = ""
                  }}
                />

                <div class="flex items-center gap-1 pointer-events-auto">
                  <Tooltip placement="top" inactive={!working() && blank()} value={tip()}>
                    <IconButton
                      data-action="prompt-submit"
                      type="submit"
                      disabled={!working() && blank()}
                      tabIndex={store.mode === "normal" ? undefined : -1}
                      icon={stopping() ? "stop" : store.mode === "shell" ? "arrow-undo-down" : "arrow-up"}
                      variant="primary"
                      class="size-8"
                      aria-label={stopping() ? language.t("prompt.action.stop") : language.t("prompt.action.send")}
                    />
                  </Tooltip>
                </div>
              </div>

              <div class="pointer-events-none absolute bottom-2 left-2">
                <div
                  aria-hidden={store.mode !== "normal"}
                  class="pointer-events-auto"
                  style={{
                    "pointer-events": buttonsSpring() > 0.5 ? "auto" : "none",
                  }}
                >
                  <TooltipKeybind
                    placement="top"
                    title={language.t("prompt.action.attachFile")}
                    keybind={command.keybind("file.attach")}
                  >
                    <Button
                      data-action="prompt-attach"
                      type="button"
                      variant="ghost"
                      class="size-8 p-0"
                      style={buttons()}
                      onClick={pick}
                      disabled={store.mode !== "normal"}
                      tabIndex={store.mode === "normal" ? undefined : -1}
                      aria-label={language.t("prompt.action.attachFile")}
                    >
                      <Icon name="plus" class="size-4.5" />
                    </Button>
                  </TooltipKeybind>
                </div>
              </div>
            </div>
          </DockShellForm>
          <Show when={store.mode === "normal" || store.mode === "shell"}>
            <DockTray attach="top">
              <div class="px-1.75 pt-5.5 pb-2 flex items-center gap-2 min-w-0">
                <div class="flex items-center gap-1.5 min-w-0 flex-1 relative">
                  <div
                    class="h-7 flex items-center gap-1.5 min-w-0 absolute inset-0"
                    style={{
                      padding: "0 0px 0 8px",
                      ...shell(),
                    }}
                  >
                    <Icon name="console" />
                    <span class="truncate text-13-medium text-text-base">{language.t("prompt.mode.shell")}</span>
                    <div class="flex-1" />
                    <Button
                      variant="ghost"
                      class="text-text-base"
                      onClick={() => {
                        setStore("mode", "normal")
                      }}
                    >
                      {language.t("common.cancel")}
                    </Button>
                  </div>
                  <div class="flex items-center gap-1.5 min-w-0 flex-1 h-7">
                    <Show when={!agentsLoading()}>
                      <div
                        data-component="prompt-agent-control"
                        classList={{ "animate-in fade-in duration-300": agentsShouldFadeIn() }}
                      >
                        <TooltipKeybind
                          placement="top"
                          gutter={4}
                          title={language.t("command.agent.cycle")}
                          keybind={command.keybind("agent.cycle")}
                        >
                          <Select
                            size="normal"
                            options={props.controls.agents.options}
                            current={props.controls.agents.current}
                            onSelect={(value) => {
                              props.controls.agents.select(value)
                              restoreFocus()
                            }}
                            class="capitalize max-w-[160px] text-text-base"
                            valueClass="truncate text-13-regular text-text-base"
                            triggerStyle={control()}
                            triggerProps={{ "data-action": "prompt-agent" }}
                            variant="ghost"
                          />
                        </TooltipKeybind>
                      </div>
                    </Show>
                    <Show when={!providersLoading()}>
                      <Show when={store.mode !== "shell"}>
                        <div
                          data-component="prompt-model-control"
                          classList={{ "animate-in fade-in duration-300": providersShouldFadeIn() }}
                        >
                          <Show
                            when={props.controls.model.paid}
                            fallback={
                              <TooltipKeybind
                                placement="top"
                                gutter={4}
                                title={language.t("command.model.choose")}
                                keybind={command.keybind("model.choose")}
                              >
                                <Button
                                  data-action="prompt-model"
                                  as="div"
                                  variant="ghost"
                                  size="normal"
                                  class="min-w-0 max-w-[320px] text-13-regular text-text-base group"
                                  style={control()}
                                  onClick={() => {
                                    void import("@/components/dialog-select-model-unpaid").then((x) => {
                                      dialog.show(() => (
                                        <x.DialogSelectModelUnpaid model={props.controls.model.selection} />
                                      ))
                                    })
                                  }}
                                >
                                  <Show when={props.controls.model.selection.current()?.provider?.id}>
                                    <ProviderIcon
                                      id={props.controls.model.selection.current()?.provider?.id ?? ""}
                                      class="size-4 shrink-0 opacity-40 group-hover:opacity-100 transition-opacity duration-150"
                                      style={{ "will-change": "opacity", transform: "translateZ(0)" }}
                                    />
                                  </Show>
                                  <span class="truncate">
                                    {props.controls.model.selection.current()?.name ??
                                      language.t("dialog.model.select.title")}
                                  </span>
                                  <Icon name="chevron-down" size="small" class="shrink-0" />
                                </Button>
                              </TooltipKeybind>
                            }
                          >
                            <TooltipKeybind
                              placement="top"
                              gutter={4}
                              title={language.t("command.model.choose")}
                              keybind={command.keybind("model.choose")}
                            >
                              <ModelSelectorPopover
                                model={props.controls.model.selection}
                                triggerAs={Button}
                                triggerProps={{
                                  variant: "ghost",
                                  size: "normal",
                                  style: control(),
                                  class: "min-w-0 max-w-[320px] text-13-regular text-text-base group",
                                  "data-action": "prompt-model",
                                }}
                                onClose={restoreFocus}
                              >
                                <Show when={props.controls.model.selection.current()?.provider?.id}>
                                  <ProviderIcon
                                    id={props.controls.model.selection.current()?.provider?.id ?? ""}
                                    class="size-4 shrink-0 opacity-40 group-hover:opacity-100 transition-opacity duration-150"
                                    style={{ "will-change": "opacity", transform: "translateZ(0)" }}
                                  />
                                </Show>
                                <span class="truncate">
                                  {props.controls.model.selection.current()?.name ??
                                    language.t("dialog.model.select.title")}
                                </span>
                                <Icon name="chevron-down" size="small" class="shrink-0" />
                              </ModelSelectorPopover>
                            </TooltipKeybind>
                          </Show>
                        </div>
                        <CodexMultiAuthChip
                          active={codexMultiAuthActive()}
                          currentModelName={props.controls.model.selection.current()?.name ?? "model"}
                          openAccounts={openCodexAccountsPanel}
                        />
                        <Show when={showVariantControl()}>
                          <div
                            data-component="prompt-variant-control"
                            classList={{ "animate-in fade-in duration-300": providersShouldFadeIn() }}
                          >
                            <TooltipKeybind
                              placement="top"
                              gutter={4}
                              title={language.t("command.model.variant.cycle")}
                              keybind={command.keybind("model.variant.cycle")}
                            >
                              <Select
                                size="normal"
                                options={variants()}
                                current={props.controls.model.selection.variant.current() ?? "default"}
                                label={(x) => (x === "default" ? language.t("common.default") : x)}
                                onSelect={(value) => {
                                  props.controls.model.selection.variant.set(value === "default" ? undefined : value)
                                  restoreFocus()
                                }}
                                class="capitalize max-w-[160px] text-text-base"
                                valueClass="truncate text-13-regular text-text-base"
                                triggerStyle={control()}
                                triggerProps={{ "data-action": "prompt-model-variant" }}
                                variant="ghost"
                              />
                            </TooltipKeybind>
                          </div>
                        </Show>
                      </Show>
                    </Show>
                  </div>
                </div>
              </div>
            </DockTray>
          </Show>
        </Match>
      </Switch>
    </div>
  )
}

type ComposerAgentControlState = {
  title: string
  keybind: string[]
  options: string[]
  current: string
  style: JSX.CSSProperties | undefined
  onSelect: (value: string | undefined) => void
}

type ComposerModelControlState = {
  loading: boolean
  shouldAnimate: boolean
  paid: boolean
  title: string
  keybind: string[]
  model: ReturnType<typeof useLocal>["model"]
  providerID?: string
  modelName: string
  style: JSX.CSSProperties | undefined
  onClose: () => void
  onUnpaidClick: () => void
}

function ComposerAgentControl(props: { state: ComposerAgentControlState }) {
  return (
    <div class="relative">
      <div class="pointer-events-none absolute left-2 top-1/2 z-10 flex size-4 -translate-y-1/2 items-center justify-center text-v2-icon-icon-muted">
        <Icon name="sliders" size="small" />
      </div>
      <TooltipV2
        placement="top"
        gutter={4}
        value={
          <>
            {props.state.title}
            <KeybindV2 keys={props.state.keybind} variant="neutral" />
          </>
        }
      >
        <Select
          size="normal"
          options={props.state.options}
          current={props.state.current}
          onSelect={props.state.onSelect}
          class="max-w-[175px] justify-start text-v2-text-text-faint [&_[data-component=icon]]:text-v2-icon-icon-muted"
          valueClass="truncate pl-5 text-[13px] font-[440] leading-5 text-v2-text-text-faint"
          triggerStyle={props.state.style}
          triggerProps={{ "data-action": "prompt-agent" }}
          variant="ghost"
        />
      </TooltipV2>
    </div>
  )
}

type CodexMultiAuthStatus = {
  ok?: boolean
  configured?: boolean
  accountCount?: number
  accounts?: CodexMultiAuthAccount[]
  accountsConfigured?: boolean
  activeAccount?: string | null
  forcedAccount?: string | null
  forcedUntil?: string | null
  rotationStrategy?: string | null
  sendRouting?: string | null
  runtimeReady?: boolean
  sendBlocked?: boolean
  sendBlockReason?: string | null
  statusPhase?: string | null
  loginAttempt?: string | null
  warning?: string | null
  usageSummary?: string | null
  output?: string
  limitsOutput?: string
  error?: string
}

type CodexMultiAuthAccount = {
  alias?: string
  email?: string
  label?: string
  enabled?: boolean
  active?: boolean
  reauthNeeded?: boolean
  disabledReason?: string | null
  planType?: string | null
  usageCount?: number
  lastUsed?: string | null
}

function readAccountCount(status: CodexMultiAuthStatus | undefined) {
  if (typeof status?.accountCount === "number") return status.accountCount
  const text = [status?.output, status?.limitsOutput].filter(Boolean).join("\n")
  const match = text.match(/Accounts:\s*(\d+)/i)
  return match ? Number(match[1]) : 0
}

function readUsageSummary(status: CodexMultiAuthStatus | undefined) {
  if (status?.usageSummary) return status.usageSummary
  const limits = status?.limitsOutput ?? ""
  const weekly = limits.match(/weekly[^\n]*/i)?.[0]
  const remaining = limits.match(/remaining[^\n]*/i)?.[0]
  if (weekly && remaining && weekly !== remaining) return `${weekly} · ${remaining}`
  return weekly ?? remaining ?? undefined
}

function CodexMultiAuthChip(props: {
  active: boolean
  currentModelName: string
  openAccounts: () => void | Promise<void>
}) {
  const [popoverOpen, setPopoverOpen] = createSignal(false)
  const [tick, setTick] = createSignal(0)
  const [pendingAction, setPendingAction] = createSignal<string | undefined>()
  const [actionError, setActionError] = createSignal<string | undefined>()
  const [actionNote, setActionNote] = createSignal<string | undefined>()
  const [status, actions] = createResource(tick, async () => {
    const response = await fetch("/experimental/codex-multi-auth/status", { cache: "no-store" })
    if (!response.ok) throw new Error(`status ${response.status}`)
    const body = await response.json()
    return body as CodexMultiAuthStatus
  })

  const timer = window.setInterval(() => setTick((value) => value + 1), 20_000)
  onCleanup(() => window.clearInterval(timer))

  const accountCount = createMemo(() => readAccountCount(status()))
  const accountList = createMemo(() => status()?.accounts ?? [])
  const activeAlias = createMemo(() => status()?.activeAccount ?? accountList().find((account) => account.active)?.alias)
  const forcedAlias = createMemo(() => status()?.forcedAccount)
  const sendBlocked = createMemo(() => status()?.sendBlocked !== false)
  const runtimeReady = createMemo(() => status()?.runtimeReady === true)
  const usage = createMemo(() => readUsageSummary(status()))
  const label = createMemo(() => {
    if (!status()?.configured) return "Codex setup"
    if (sendBlocked()) return "Codex blocked"
    if (props.active) return runtimeReady() ? "Codex auto" : "Codex blocked"
    return accountCount() > 0 ? (runtimeReady() ? "Codex ready" : "Codex pending") : "Codex"
  })
  const detail = createMemo(() => {
    if (status.loading) return "checking"
    if (status.error || status()?.error) return "status error"
    if (sendBlocked() && accountCount() > 0) return "runtime blocked"
    const count = accountCount() === 1 ? "1 account" : `${accountCount()} accounts`
    // Show which lane/account a send would use: the forced account wins over
    // the rotation-active one.
    const alias = forcedAlias() ?? activeAlias()
    if (alias) return `${forcedAlias() ? "forced " : ""}${alias} · ${count}`
    return count
  })
  const tooltip = createMemo(() => {
    const accountLine = accountCount() === 1 ? "1 account configured" : `${accountCount()} accounts configured`
    const mode = props.active
      ? runtimeReady()
        ? `Active for ${props.currentModelName}`
        : `Selected for ${props.currentModelName}, but prompt sends are blocked until the multi-auth runtime adapter is verified`
      : "Select Codex Multi-Auth in the model picker to inspect this lane"
    const usageLine = usage() ? `\n${usage()}` : ""
    const strategy = status()?.rotationStrategy ? `\nStrategy: ${status()?.rotationStrategy}` : ""
    const routing = status()?.sendRouting ? `\nRouting: ${status()?.sendRouting}` : ""
    const warning = status()?.warning ? `\n${status()?.warning}` : ""
    return `${mode}\n${accountLine}${usageLine}${strategy}${routing}${warning}\nClick to open the Codex accounts panel.`
  })

  const runAccountAction = async (payload: Record<string, unknown>, pendingLabel: string, successLabel: string) => {
    setPendingAction(pendingLabel)
    setActionError(undefined)
    setActionNote(undefined)
    try {
      const response = await fetch("/experimental/codex-multi-auth/account", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body?.ok === false) throw new Error(body?.error ?? "Could not update Codex account")
      const nextStatus = body?.status ?? body
      if (nextStatus?.ok !== false) actions.mutate(nextStatus as CodexMultiAuthStatus)
      setActionNote(successLabel)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setPendingAction(undefined)
    }
  }

  const setActive = (alias: string) =>
    runAccountAction({ action: "set-active", alias }, `set-active:${alias}`, `Active account set to ${alias}`)
  const forceAccount = (alias: string) =>
    runAccountAction(
      { action: "force-account", alias, durationMinutes: 120 },
      `force-account:${alias}`,
      `Forced ${alias} for 2 hours`,
    )
  const clearForce = () => runAccountAction({ action: "clear-force" }, "clear-force", "Forced account cleared")

  const accountStatusLabel = (account: CodexMultiAuthAccount) => {
    if (account.reauthNeeded) return "re-auth needed"
    if (forcedAlias() === account.alias) return "forced"
    if (account.active || activeAlias() === account.alias) return "active"
    if (account.enabled === false) return "disabled"
    return "ready"
  }

  return (
    <KobaltePopover
      open={popoverOpen()}
      onOpenChange={(open) => {
        setPopoverOpen(open)
        if (open) void actions.refetch()
      }}
      modal={false}
      placement="top-start"
      gutter={6}
    >
      <KobaltePopover.Trigger
        as={Button}
        type="button"
        variant="ghost"
        size="normal"
        data-action="prompt-codex-account"
        data-codex-active={activeAlias() ?? ""}
        data-codex-forced={forcedAlias() ?? ""}
        title={tooltip()}
        class="min-w-0 max-w-[230px] justify-start gap-1.5 rounded-md px-2 text-[12px] font-[440] leading-5 text-v2-text-text-faint"
        classList={{
          "text-v2-text-text-base bg-v2-background-bg-layer-02": props.active,
          "opacity-70": !props.active && accountCount() === 0,
        }}
      >
        <span class="flex size-4 shrink-0 items-center justify-center rounded bg-orange-500/20 text-[9px] font-semibold text-orange-300">
          CA
        </span>
        <span class="truncate">{label()}</span>
        <span class="truncate text-v2-text-text-muted">{detail()}</span>
      </KobaltePopover.Trigger>
      <KobaltePopover.Portal>
        <KobaltePopover.Content class="z-50 w-[390px] rounded-xl border border-v2-border-border-base bg-v2-background-bg-layer-01 p-3 text-[12px] leading-5 text-v2-text-text-base shadow-[var(--v2-elevation-floating)] outline-none">
          <KobaltePopover.Title class="mb-2 flex items-center gap-2 text-[13px] font-[560]">
            <span class="flex size-5 items-center justify-center rounded bg-orange-500/20 text-[10px] font-semibold text-orange-300">
              CA
            </span>
            <span class="min-w-0 flex-1 truncate">Codex Multi-Auth</span>
            <span class="rounded-md bg-v2-background-bg-layer-02 px-2 py-0.5 text-[11px] font-[450] text-v2-text-text-muted">
              {accountCount()} accounts
            </span>
          </KobaltePopover.Title>
          <div class="space-y-2 text-v2-text-text-muted">
            <div class="grid gap-1.5">
              <Show
                when={accountList().length > 0}
                fallback={
                  <div class="rounded-lg border border-v2-border-border-base bg-v2-background-bg-base px-3 py-2 text-v2-text-text-muted">
                    No Codex accounts are configured yet.
                  </div>
                }
              >
                {accountList().map((account) => {
                  const alias = account.alias ?? ""
                  const accountActive = () => account.active || activeAlias() === alias
                  const accountForced = () => forcedAlias() === alias
                  const disabled = () => account.enabled === false || account.reauthNeeded === true
                  const pending = (action: string) => pendingAction() === `${action}:${alias}`
                  return (
                    <div
                      data-codex-account={alias}
                      class="rounded-lg border border-v2-border-border-base bg-v2-background-bg-base px-2.5 py-2"
                      classList={{
                        "border-green-500/30 bg-green-500/5": accountActive(),
                        "border-orange-500/30 bg-orange-500/5": accountForced(),
                        "opacity-70": disabled(),
                      }}
                    >
                      <div class="flex items-start gap-2">
                        <span
                          class="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md text-[10px] font-semibold"
                          classList={{
                            "bg-green-500/15 text-green-200": accountActive(),
                            "bg-orange-500/15 text-orange-200": accountForced(),
                            "bg-v2-background-bg-layer-02 text-v2-text-text-muted": !accountActive() && !accountForced(),
                          }}
                        >
                          {(alias || "CA").slice(0, 2).toUpperCase()}
                        </span>
                        <div class="min-w-0 flex-1">
                          <div class="flex min-w-0 items-center gap-2">
                            <span class="truncate text-[12px] font-[560] text-v2-text-text-base">{alias || "account"}</span>
                            <span class="shrink-0 rounded-full bg-v2-background-bg-layer-02 px-1.5 py-0.5 text-[10px] text-v2-text-text-muted">
                              {accountStatusLabel(account)}
                            </span>
                            <Show when={account.planType}>
                              {(plan) => (
                                <span class="shrink-0 rounded-full bg-v2-background-bg-layer-02 px-1.5 py-0.5 text-[10px] text-v2-text-text-muted">
                                  {plan()}
                                </span>
                              )}
                            </Show>
                          </div>
                          <div class="truncate text-[11px] text-v2-text-text-muted">{account.email ?? account.label ?? "email not reported"}</div>
                        </div>
                      </div>
                      <div class="mt-2 flex flex-wrap justify-end gap-1.5">
                        <Show when={!accountActive() && !disabled()}>
                          <Button
                            type="button"
                            variant="ghost"
                            size="normal"
                            data-action="codex-popup-set-active"
                            data-account-alias={alias}
                            class="h-6 px-2 text-[11px]"
                            disabled={!!pendingAction()}
                            onClick={(event: MouseEvent) => {
                              event.stopPropagation()
                              void setActive(alias)
                            }}
                          >
                            {pending("set-active") ? "Setting..." : "Set active"}
                          </Button>
                        </Show>
                        <Show when={!accountForced() && !disabled()}>
                          <Button
                            type="button"
                            variant="ghost"
                            size="normal"
                            data-action="codex-popup-force"
                            data-account-alias={alias}
                            class="h-6 px-2 text-[11px]"
                            disabled={!!pendingAction()}
                            onClick={(event: MouseEvent) => {
                              event.stopPropagation()
                              void forceAccount(alias)
                            }}
                          >
                            {pending("force-account") ? "Forcing..." : "Force 2h"}
                          </Button>
                        </Show>
                        <Show when={accountForced()}>
                          <Button
                            type="button"
                            variant="ghost"
                            size="normal"
                            data-action="codex-popup-clear-force"
                            data-account-alias={alias}
                            class="h-6 px-2 text-[11px]"
                            disabled={!!pendingAction()}
                            onClick={(event: MouseEvent) => {
                              event.stopPropagation()
                              void clearForce()
                            }}
                          >
                            {pendingAction() === "clear-force" ? "Clearing..." : "Clear force"}
                          </Button>
                        </Show>
                      </div>
                    </div>
                  )
                })}
              </Show>
            </div>
            <div class="grid grid-cols-2 gap-2 rounded-lg border border-v2-border-border-base bg-v2-background-bg-base px-2.5 py-2">
              <div>
                <div class="text-[10px] uppercase tracking-wide text-v2-text-text-faint">Routing</div>
                <div class="truncate text-v2-text-text-base">{status()?.rotationStrategy ?? "auto"}</div>
              </div>
              <div>
                <div class="text-[10px] uppercase tracking-wide text-v2-text-text-faint">Status</div>
                <div class="truncate text-v2-text-text-base">
                  {status.loading ? "checking" : sendBlocked() ? "runtime blocked" : (status()?.statusPhase ?? "ready")}
                </div>
              </div>
            </div>
            <Show when={usage()}>
              {(line) => (
                <div class="rounded-lg border border-v2-border-border-base bg-v2-background-bg-base px-2 py-1 text-v2-text-text-base">
                  {line()}
                </div>
              )}
            </Show>
            <Show when={props.active && sendBlocked()}>
              <div class="rounded-lg border border-orange-500/20 bg-orange-500/10 px-2 py-1 text-orange-200">
                This lane is selected, but sends are blocked until the multi-auth runtime adapter is verified.
                <Show when={status()?.sendBlockReason}>{(reason) => <span> {reason()}</span>}</Show>
              </div>
            </Show>
            <Show when={actionNote()}>
              {(note) => <div class="rounded-lg border border-green-500/20 bg-green-500/10 px-2 py-1 text-green-200">{note()}</div>}
            </Show>
            <Show when={actionError()}>
              {(error) => <div class="rounded-lg border border-red-500/25 bg-red-500/10 px-2 py-1 text-red-200">{error()}</div>}
            </Show>
            <Show when={status()?.warning}>
              {(warning) => (
                <div class="rounded-lg border border-v2-border-border-base bg-v2-background-bg-base px-2 py-1 text-v2-text-text-muted">
                  {warning()}
                </div>
              )}
            </Show>
          </div>
          <div class="mt-3 flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="normal"
              class="h-7 px-2 text-[12px]"
              onClick={(event: MouseEvent) => {
                event.stopPropagation()
                void actions.refetch()
              }}
            >
              Refresh
            </Button>
            <Button
              type="button"
              variant="primary"
              size="normal"
              class="h-7 px-2 text-[12px]"
              onClick={(event: MouseEvent) => {
                event.stopPropagation()
                setPopoverOpen(false)
                void props.openAccounts()
              }}
            >
              Open Accounts
            </Button>
          </div>
        </KobaltePopover.Content>
      </KobaltePopover.Portal>
    </KobaltePopover>
  )
}

function ComposerModelControl(props: { state: ComposerModelControlState }) {
  return (
    <Show when={!props.state.loading}>
      <Show
        when={props.state.paid}
        fallback={
          <TooltipV2
            placement="top"
            gutter={4}
            value={
              <>
                {props.state.title}
                <KeybindV2 keys={props.state.keybind} variant="neutral" />
              </>
            }
          >
            <Button
              data-action="prompt-model"
              as="div"
              variant="ghost"
              size="normal"
              class="min-w-0 max-w-[220px] justify-start text-[13px] font-[440] leading-5 text-v2-text-text-faint group"
              classList={{ "animate-in fade-in": props.state.shouldAnimate }}
              style={props.state.style}
              onClick={props.state.onUnpaidClick}
            >
              <Show when={props.state.providerID}>
                {(providerID) => (
                  <ProviderIcon
                    id={providerID()}
                    class="size-4 shrink-0 opacity-40 group-hover:opacity-100 transition-opacity duration-150"
                    style={{ "will-change": "opacity", transform: "translateZ(0)" }}
                  />
                )}
              </Show>
              <span class="truncate">{props.state.modelName}</span>
              <span class="-ml-1 shrink-0 flex size-fit">
                <Icon name="chevron-down" size="small" class="text-v2-icon-icon-muted" />
              </span>
            </Button>
          </TooltipV2>
        }
      >
        <TooltipV2
          placement="top"
          gutter={4}
          value={
            <>
              {props.state.title}
              <KeybindV2 keys={props.state.keybind} variant="neutral" />
            </>
          }
        >
          <ModelSelectorPopover
            model={props.state.model}
            triggerAs={Button}
            triggerProps={{
              variant: "ghost",
              size: "normal",
              style: props.state.style,
              class:
                "min-w-0 max-w-[220px] justify-start text-[13px] font-[440] leading-5 text-v2-text-text-faint group",
              classList: { "animate-in fade-in": props.state.shouldAnimate },
              "data-action": "prompt-model",
            }}
            onClose={props.state.onClose}
          >
            <Show when={props.state.providerID}>
              {(providerID) => (
                <ProviderIcon
                  id={providerID()}
                  class="size-4 shrink-0 opacity-40 group-hover:opacity-100 transition-opacity duration-150"
                  style={{ "will-change": "opacity", transform: "translateZ(0)" }}
                />
              )}
            </Show>
            <span class="truncate">{props.state.modelName}</span>
            <span class="-ml-1 shrink-0 flex size-fit">
              <Icon name="chevron-down" size="small" class="text-v2-icon-icon-muted" />
            </span>
          </ModelSelectorPopover>
        </TooltipV2>
      </Show>
    </Show>
  )
}
