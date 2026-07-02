import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"

type CodexAccount = {
  alias?: string
  email?: string
  accountId?: string
  enabled?: boolean
  active?: boolean
  source?: string
}

type CodexStatus = {
  ok?: boolean
  configured?: boolean
  accountCount?: number
  accounts?: CodexAccount[]
  activeAccount?: string | null
  forcedAccount?: string | null
  forcedUntil?: number | null
  rotationStrategy?: string | null
  runtimeReady?: boolean
  sendBlocked?: boolean
  sendRouting?: string
  warning?: string
  usageSummary?: string | null
  limitsOutput?: string | null
  baseProviderVisibility?: { hidden?: boolean; restoreEnv?: string }
}

function text(value: unknown) {
  return typeof value === "string" ? value : undefined
}

export function DialogCodexMultiAuthProvider() {
  const dialog = useDialog()
  const [status, setStatus] = createSignal<CodexStatus>()
  const [statusError, setStatusError] = createSignal<string>()
  const [auth, setAuth] = createSignal<Record<string, any>>()
  const [pending, setPending] = createSignal<string>()
  const [notice, setNotice] = createSignal<string>()
  const [error, setError] = createSignal<string>()
  let refreshTimer: ReturnType<typeof setInterval> | undefined

  const accounts = createMemo(() => (Array.isArray(status()?.accounts) ? status()!.accounts! : []))
  const accountCount = createMemo(() => status()?.accountCount ?? accounts().length)
  const activeAlias = createMemo(() => status()?.activeAccount ?? accounts().find((account) => account.active)?.alias ?? null)
  const forcedUntilLabel = createMemo(() => {
    const forcedUntil = status()?.forcedUntil
    if (typeof forcedUntil !== "number") return undefined
    return new Date(forcedUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  })
  const authURL = createMemo(() => text(auth()?.authorizationURL) ?? text(auth()?.authURL))
  const authCode = createMemo(() => text(auth()?.userCode) ?? text(auth()?.code))
  const authPhase = createMemo(() => text(auth()?.phase) ?? text(auth()?.statusPhase))
  const authCommand = createMemo(() => text(auth()?.terminalCommand) ?? text(auth()?.command))

  async function refreshStatus() {
    try {
      const response = await fetch("/experimental/codex-multi-auth/status")
      const body = await response.json()
      if (!response.ok || body?.ok === false) {
        setStatusError(body?.error ?? "Could not load Codex multi-auth status")
        return
      }
      setStatus(body)
      setStatusError(undefined)
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err))
    }
  }

  async function startLogin() {
    setPending("login")
    setError(undefined)
    setNotice(undefined)
    try {
      const response = await fetch("/experimental/codex-multi-auth/login", { method: "POST" })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body?.ok === false) throw new Error(body?.error ?? "Could not start Codex account login")
      setAuth(body)
      setNotice("Approve the newest auth link, then this dialog will refresh account status.")
      await refreshStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(undefined)
    }
  }

  async function accountAction(payload: Record<string, unknown>, label: string) {
    setPending(label)
    setError(undefined)
    setNotice(undefined)
    try {
      const response = await fetch("/experimental/codex-multi-auth/account", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body?.ok === false) throw new Error(body?.error ?? "Could not update Codex account")
      setNotice("Codex account state updated.")
      await refreshStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(undefined)
    }
  }

  async function copy(value: string | undefined) {
    if (!value || !navigator.clipboard) return
    await navigator.clipboard.writeText(value)
  }

  async function openInAgentBrowser(url: string) {
    setPending("agent-browser")
    setError(undefined)
    try {
      const response = await fetch("/experimental/browser/live/input", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "goto", url }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body?.ok === false) throw new Error(body?.error ?? "Could not open auth link in Agent Browser")
      window.dispatchEvent(
        new CustomEvent("opencode:workspace-tab-action", {
          detail: {
            type: "workspace_tab",
            action: "open",
            tab: "panel://browser",
            source: "codex-multi-auth-settings",
            actionID: `codex-auth-settings-${Date.now()}`,
          },
        }),
      )
      setNotice("Opened the auth link in Agent Browser. Complete approval there, then refresh status.")
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(undefined)
    }
  }

  onMount(() => {
    void refreshStatus()
    refreshTimer = setInterval(() => {
      void refreshStatus()
    }, 5000)
  })

  onCleanup(() => {
    if (refreshTimer) clearInterval(refreshTimer)
  })

  return (
    <Dialog
      title={
        <IconButton
          tabIndex={-1}
          icon="arrow-left"
          variant="ghost"
          onClick={() => dialog.close()}
          aria-label="Close"
        />
      }
    >
      <div class="flex flex-col gap-6 px-2.5 pb-3">
        <div class="px-2.5 flex gap-4 items-center">
          <ProviderIcon id="codex-multi-auth" class="size-5 shrink-0 icon-strong-base" />
          <div>
            <div class="text-16-medium text-text-strong">Manage Codex Multi-Auth</div>
            <div class="mt-1 text-12-regular text-text-weak">
              Add, remove, switch, and force isolated Codex accounts.
            </div>
          </div>
        </div>

        <div class="px-2.5 pb-10 flex flex-col gap-4">
          <Show when={statusError()}>
            {(value) => (
              <div class="rounded-md border border-orange-500/20 bg-orange-500/10 px-3 py-2 text-12-regular text-orange-100">
                {value()}
              </div>
            )}
          </Show>

          <div class="rounded-md border border-border-weaker-base bg-background-base p-3">
            <div class="mb-3 grid gap-2 sm:grid-cols-2">
              <Metric label="Accounts" value={String(accountCount())} />
              <Metric label="Active" value={activeAlias() ?? "none"} />
              <Metric label="Forced" value={status()?.forcedAccount ? `${status()?.forcedAccount}${forcedUntilLabel() ? ` until ${forcedUntilLabel()}` : ""}` : "none"} />
              <Metric label="Rotation" value={status()?.rotationStrategy ?? "round-robin"} />
              <Metric label="Runtime" value={status()?.runtimeReady ? "ready" : "not verified"} />
              <Metric label="Routing" value={status()?.sendRouting ?? "unknown"} />
            </div>
            <Show when={status()?.baseProviderVisibility?.hidden}>
              <div class="rounded-md border border-green-500/20 bg-green-500/10 px-3 py-2 text-12-regular text-green-100">
                Base OpenAI is hidden while Codex Multi-Auth is ready.
              </div>
            </Show>
            <Show when={status()?.warning}>
              {(value) => <div class="mt-2 text-12-regular text-text-weak">{value()}</div>}
            </Show>
          </div>

          <div class="flex flex-wrap gap-2">
            <Button size="large" variant="primary" disabled={pending() === "login"} onClick={() => void startLogin()}>
              {pending() === "login" ? "Starting..." : "Add Codex account"}
            </Button>
            <Button size="large" variant="secondary" onClick={() => void refreshStatus()}>
              Refresh
            </Button>
          </div>

          <Show when={auth()}>
            <div class="rounded-md border border-border-weaker-base bg-background-base p-3">
              <div class="mb-3 flex items-center gap-2 text-14-regular text-text-base">
                <Spinner />
                <span>{authPhase() ?? "Waiting for authorization..."}</span>
              </div>
              <Show when={authURL()}>
                {(url) => (
                  <div class="mb-3">
                    <div class="mb-1 text-11-medium text-text-weak">Auth link</div>
                    <div class="flex flex-wrap items-center gap-2">
                      <a href={url()} target="_blank" rel="noreferrer" class="break-all text-12-regular text-[#f97316] hover:underline">
                        {url()}
                      </a>
                      <Button size="small" variant="ghost" onClick={() => void copy(url())}>Copy link</Button>
                      <Button size="small" variant="secondary" disabled={pending() === "agent-browser"} onClick={() => void openInAgentBrowser(url())}>
                        {pending() === "agent-browser" ? "Opening..." : "Open in Agent Browser"}
                      </Button>
                    </div>
                  </div>
                )}
              </Show>
              <Show when={authCode()}>
                {(code) => (
                  <div class="mb-3">
                    <div class="mb-1 text-11-medium text-text-weak">Confirmation code</div>
                    <div class="flex flex-wrap items-center gap-2">
                      <div class="rounded bg-background-stronger px-2 py-1.5 font-mono text-14-medium text-text-strong">{code()}</div>
                      <Button size="small" variant="ghost" onClick={() => void copy(code())}>Copy code</Button>
                    </div>
                  </div>
                )}
              </Show>
              <Show when={authCommand()}>
                {(command) => (
                  <div>
                    <div class="mb-1 text-11-medium text-text-weak">Command</div>
                    <div class="break-all rounded bg-background-stronger px-2 py-1.5 font-mono text-11-regular text-text-strong">{command()}</div>
                  </div>
                )}
              </Show>
            </div>
          </Show>

          <Show when={notice()}>
            {(value) => <div class="rounded-md border border-green-500/20 bg-green-500/10 px-3 py-2 text-12-regular text-green-100">{value()}</div>}
          </Show>
          <Show when={error()}>
            {(value) => <div class="rounded-md border border-orange-500/20 bg-orange-500/10 px-3 py-2 text-12-regular text-orange-100">{value()}</div>}
          </Show>

          <div class="rounded-md border border-border-weaker-base bg-background-base">
            <Show
              when={accounts().length > 0}
              fallback={<div class="px-3 py-4 text-14-regular text-text-weak">No Codex multi-auth accounts have been added yet.</div>}
            >
              <For each={accounts()}>
                {(account) => {
                  const alias = () => account.alias ?? ""
                  return (
                    <div class="border-b border-border-weaker-base px-3 py-3 last:border-b-0">
                      <div class="flex flex-wrap items-start justify-between gap-3">
                        <div class="min-w-0">
                          <div class="truncate text-14-medium text-text-strong">{alias() || "Codex account"}</div>
                          <div class="truncate text-12-regular text-text-weak">{account.email ?? "email not reported"}</div>
                          <div class="truncate text-11-regular text-text-weak">{account.accountId ?? account.source ?? "account id hidden"}</div>
                        </div>
                        <div class="flex flex-wrap justify-end gap-2">
                          <span class="rounded bg-background-stronger px-2 py-1 text-11-regular text-text-weak">
                            {account.enabled === false ? "disabled" : "enabled"}
                          </span>
                          <Show when={account.active}>
                            <span class="rounded bg-green-500/10 px-2 py-1 text-11-regular text-green-200">active</span>
                          </Show>
                          <Show when={status()?.forcedAccount === alias()}>
                            <span class="rounded bg-orange-500/10 px-2 py-1 text-11-regular text-orange-100">forced</span>
                          </Show>
                        </div>
                      </div>
                      <div class="mt-3 flex flex-wrap gap-2">
                        <Button size="small" variant="secondary" disabled={!alias() || account.active || pending() === `active:${alias()}`} onClick={() => void accountAction({ action: "set-active", alias: alias() }, `active:${alias()}`)}>
                          Set active
                        </Button>
                        <Button size="small" variant="secondary" disabled={!alias() || pending() === `force:${alias()}`} onClick={() => void accountAction({ action: "force-account", alias: alias(), durationMinutes: 120 }, `force:${alias()}`)}>
                          Force 2h
                        </Button>
                        <Button size="small" variant="ghost" disabled={!alias() || pending() === `enabled:${alias()}`} onClick={() => void accountAction({ action: "set-enabled", alias: alias(), enabled: account.enabled === false }, `enabled:${alias()}`)}>
                          {account.enabled === false ? "Enable" : "Disable"}
                        </Button>
                        <Button
                          size="small"
                          variant="ghost"
                          disabled={!alias() || pending() === `remove:${alias()}`}
                          onClick={() => {
                            if (!window.confirm(`Remove Codex account ${alias()} from this isolated profile?`)) return
                            void accountAction({ action: "remove-account", alias: alias() }, `remove:${alias()}`)
                          }}
                        >
                          Remove
                        </Button>
                      </div>
                    </div>
                  )
                }}
              </For>
            </Show>
          </div>

          <div class="rounded-md border border-border-weaker-base bg-background-base p-3">
            <div class="mb-2 text-12-medium text-text-strong">Rotation</div>
            <div class="flex flex-wrap gap-2">
              <For each={["round-robin", "least-used", "random", "weighted-round-robin"]}>
                {(strategy) => (
                  <Button
                    size="small"
                    variant={status()?.rotationStrategy === strategy ? "primary" : "secondary"}
                    disabled={pending() === `rotation:${strategy}`}
                    onClick={() => void accountAction({ action: "set-rotation", strategy }, `rotation:${strategy}`)}
                  >
                    {strategy}
                  </Button>
                )}
              </For>
              <Button size="small" variant="ghost" disabled={!status()?.forcedAccount || pending() === "clear-force"} onClick={() => void accountAction({ action: "clear-force" }, "clear-force")}>
                Clear force
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  )
}

function Metric(props: { label: string; value: string }) {
  return (
    <div class="rounded bg-background-stronger px-3 py-2">
      <div class="text-11-regular text-text-weak">{props.label}</div>
      <div class="mt-1 truncate text-12-regular text-text-strong">{props.value}</div>
    </div>
  )
}
