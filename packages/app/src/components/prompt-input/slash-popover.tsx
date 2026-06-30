import { Component, For, Match, Show, Switch } from "solid-js"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { getDirectory, getFilename } from "@opencode-ai/core/util/path"
import type { ToolPartSource } from "@/context/prompt"

export type AtOption =
  | { type: "agent"; name: string; display: string }
  | { type: "file"; path: string; display: string; recent?: boolean }
  | {
      type: "tool"
      id: string
      name: string
      display: string
      source: ToolPartSource
      description?: string
      icon?: string
    }

export interface SlashCommand {
  id: string
  trigger: string
  title: string
  description?: string
  keybind?: string
  type: "builtin" | "custom"
  source?: "command" | "mcp" | "skill"
}

type PromptPopoverProps = {
  popover: "at" | "slash" | null
  setSlashPopoverRef: (el: HTMLDivElement) => void
  atFlat: AtOption[]
  atActive?: string
  atKey: (item: AtOption) => string
  setAtActive: (id: string) => void
  onAtSelect: (item: AtOption) => void
  slashFlat: SlashCommand[]
  slashActive?: string
  setSlashActive: (id: string) => void
  onSlashSelect: (item: SlashCommand) => void
  commandKeybind: (id: string) => string | undefined
  t: (key: string) => string
}

export const ToolMentionIcon: Component<{ source: ToolPartSource; icon?: string }> = (props) => {
  const orange = "#f97316"

  return (
    <span
      class="size-4 shrink-0 inline-flex items-center justify-center overflow-hidden rounded-[4px]"
      style={{ color: orange }}
    >
      <Show
        when={props.icon}
        fallback={
          <Switch>
            <Match when={props.source === "swami"}>
              <span class="text-[8px] leading-none font-semibold tracking-[0]">SW</span>
            </Match>
            <Match when={props.source === "browser"}>
              <Icon name="window-cursor" size="small" />
            </Match>
            <Match when={props.source === "preview"}>
              <Icon name="window-cursor" size="small" />
            </Match>
            <Match when={props.source === "terminal"}>
              <Icon name="terminal" size="small" />
            </Match>
            <Match when={props.source === "open_design"}>
              <span class="text-[8px] leading-none font-semibold tracking-[0]">OD</span>
            </Match>
            <Match when={props.source === "mac_view"}>
              <Icon name="eye" size="small" />
            </Match>
            <Match when={props.source === "resource"}>
              <span class="text-[8px] leading-none font-semibold tracking-[0]">CPU</span>
            </Match>
            <Match when={props.source === "artifact"}>
              <Icon name="photo" size="small" />
            </Match>
            <Match when={props.source === "file_browser"}>
              <Icon name="folder" size="small" />
            </Match>
            <Match when={props.source === "account"}>
              <Icon name="providers" size="small" />
            </Match>
            <Match when={props.source === "routines"}>
              <Icon name="checklist" size="small" />
            </Match>
            <Match when={props.source === "mcp"}>
              <span class="text-[8px] leading-none font-semibold tracking-[0]">MCP</span>
            </Match>
            <Match when={true}>
              <Icon name="mcp" size="small" />
            </Match>
          </Switch>
        }
      >
        {(icon) => <img src={icon()} alt="" class="size-4 object-contain" />}
      </Show>
    </span>
  )
}

export const PromptPopover: Component<PromptPopoverProps> = (props) => {
  return (
    <Show when={props.popover}>
      <div
        ref={(el) => {
          if (props.popover === "slash") props.setSlashPopoverRef(el)
        }}
        class="absolute inset-x-0 -top-2 -translate-y-full origin-bottom-left max-h-80 min-h-10
                 overflow-auto no-scrollbar flex flex-col p-2 rounded-[12px]
                 bg-surface-raised-stronger-non-alpha shadow-[var(--shadow-lg-border-base)]"
        onMouseDown={(e) => e.preventDefault()}
      >
        <Switch>
          <Match when={props.popover === "at"}>
            <Show
              when={props.atFlat.length > 0}
              fallback={<div class="text-text-weak px-2 py-1">{props.t("prompt.popover.emptyResults")}</div>}
            >
              <For each={props.atFlat.slice(0, 10)}>
                {(item) => {
                  const key = props.atKey(item)

                  if (item.type === "agent") {
                    return (
                      <button
                        class="w-full flex items-center gap-x-2 rounded-md px-2 py-0.5"
                        classList={{ "bg-surface-raised-base-hover": props.atActive === key }}
                        onClick={() => props.onAtSelect(item)}
                        onMouseEnter={() => props.setAtActive(key)}
                      >
                        <Icon name="brain" size="small" class="text-icon-info-active shrink-0" />
                        <span class="text-14-regular text-text-strong whitespace-nowrap">@{item.name}</span>
                      </button>
                    )
                  }

                  if (item.type === "tool") {
                    return (
                      <button
                        class="w-full flex items-center gap-x-2 rounded-md px-2 py-0.5"
                        classList={{ "bg-surface-raised-base-hover": props.atActive === key }}
                        onClick={() => props.onAtSelect(item)}
                        onMouseEnter={() => props.setAtActive(key)}
                      >
                        <ToolMentionIcon source={item.source} icon={item.icon} />
                        <div class="flex items-center gap-2 min-w-0">
                          <span class="text-14-regular text-text-strong whitespace-nowrap">@{item.name}</span>
                          <Show when={item.description}>
                            <span class="text-14-regular text-text-weak truncate">{item.description}</span>
                          </Show>
                        </div>
                      </button>
                    )
                  }

                  const isDirectory = item.path.endsWith("/")
                  const directory = isDirectory ? item.path : getDirectory(item.path)
                  const filename = isDirectory ? "" : getFilename(item.path)

                  return (
                    <button
                      class="w-full flex items-center gap-x-2 rounded-md px-2 py-0.5"
                      classList={{ "bg-surface-raised-base-hover": props.atActive === key }}
                      onClick={() => props.onAtSelect(item)}
                      onMouseEnter={() => props.setAtActive(key)}
                    >
                      <FileIcon node={{ path: item.path, type: "file" }} class="shrink-0 size-4" />
                      <div class="flex items-center text-14-regular min-w-0">
                        <span class="text-text-weak whitespace-nowrap truncate min-w-0">{directory}</span>
                        <Show when={!isDirectory}>
                          <span class="text-text-strong whitespace-nowrap">{filename}</span>
                        </Show>
                      </div>
                    </button>
                  )
                }}
              </For>
            </Show>
          </Match>
          <Match when={props.popover === "slash"}>
            <Show
              when={props.slashFlat.length > 0}
              fallback={<div class="text-text-weak px-2 py-1">{props.t("prompt.popover.emptyCommands")}</div>}
            >
              <For each={props.slashFlat}>
                {(cmd) => (
                  <button
                    data-slash-id={cmd.id}
                    classList={{
                      "w-full flex items-center justify-between gap-4 rounded-md px-2 py-1": true,
                      "bg-surface-raised-base-hover": props.slashActive === cmd.id,
                    }}
                    onClick={() => props.onSlashSelect(cmd)}
                    onMouseEnter={() => props.setSlashActive(cmd.id)}
                  >
                    <div class="flex items-center gap-2 min-w-0">
                      <span class="text-14-regular text-text-strong whitespace-nowrap">/{cmd.trigger}</span>
                      <Show when={cmd.description}>
                        <span class="text-14-regular text-text-weak truncate">{cmd.description}</span>
                      </Show>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                      <Show when={cmd.type === "custom" && cmd.source !== "command"}>
                        <span class="text-11-regular text-text-subtle px-1.5 py-0.5 bg-surface-base rounded">
                          {cmd.source === "skill"
                            ? props.t("prompt.slash.badge.skill")
                            : cmd.source === "mcp"
                              ? props.t("prompt.slash.badge.mcp")
                              : props.t("prompt.slash.badge.custom")}
                        </span>
                      </Show>
                      <Show when={props.commandKeybind(cmd.id)}>
                        <span class="text-12-regular text-text-subtle">{props.commandKeybind(cmd.id)}</span>
                      </Show>
                    </div>
                  </button>
                )}
              </For>
            </Show>
          </Match>
        </Switch>
      </div>
    </Show>
  )
}
