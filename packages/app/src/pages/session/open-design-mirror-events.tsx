import { createSignal, For, Show, Switch, Match, type JSX } from "solid-js"
import type { ODEvent } from "./open-design-mirror-types"

// The answer produced when the user responds to an Open Design question card.
// The coordinator wires `text` to be sent back to the OD chat (via the bridge /
// sub-agent C's action module); `answers` is the structured form map.
export type ODAnswer = {
  toolUseId: string
  text: string
  answers: Record<string, string | string[]>
}

const OD_ACCENT = "#f97316"

type ODOption = { label: string; value: string; description?: string }
type ODQuestion = {
  id: string
  question: string
  header?: string
  options: ODOption[]
  multiSelect: boolean
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {}
}

// Normalize an AskUserQuestion tool_use input into a flat question list. OD's
// question objects carry `question`, optional `header`, and either `options`
// (label/value) or `cards` (label + preview); multi-select is signalled by
// `multiSelect` or `maxSelections > 1`.
function parseQuestions(input: unknown): ODQuestion[] {
  const root = asRecord(input)
  const raw = Array.isArray(root.questions) ? root.questions : Array.isArray(input) ? (input as unknown[]) : []
  return raw.map((q, i): ODQuestion => {
    const qr = asRecord(q)
    const optsRaw = Array.isArray(qr.options) ? qr.options : Array.isArray(qr.cards) ? qr.cards : []
    const options: ODOption[] = optsRaw.map((o) => {
      const or = asRecord(o)
      const label = String(or.label ?? or.title ?? or.value ?? "")
      return { label, value: String(or.value ?? label), description: or.description ? String(or.description) : undefined }
    })
    const multiSelect = qr.multiSelect === true || (typeof qr.maxSelections === "number" && qr.maxSelections > 1)
    return {
      id: String(qr.id ?? qr.key ?? qr.header ?? i),
      question: String(qr.question ?? qr.prompt ?? qr.header ?? ""),
      header: qr.header ? String(qr.header) : undefined,
      options,
      multiSelect,
    }
  })
}

const toolIs = (name: string, ...needles: string[]) => {
  const n = name.toLowerCase()
  return needles.some((s) => n.includes(s))
}

function firstString(rec: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) if (typeof rec[k] === "string" && rec[k]) return rec[k] as string
  return undefined
}

// A single AskUserQuestion card: renders each question with its options as
// selectable chips (single or multi), plus an optional free-text field, and a
// Send button that produces an ODAnswer.
function QuestionCard(props: { toolUseId: string; questions: ODQuestion[]; onAnswer?: (a: ODAnswer) => void }) {
  const [answers, setAnswers] = createSignal<Record<string, string | string[]>>({})
  const [extra, setExtra] = createSignal("")
  const [sent, setSent] = createSignal(false)

  const pick = (q: ODQuestion, value: string) => {
    setAnswers((prev) => {
      if (!q.multiSelect) return { ...prev, [q.id]: value }
      const cur = Array.isArray(prev[q.id]) ? (prev[q.id] as string[]) : []
      return { ...prev, [q.id]: cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value] }
    })
  }
  const isOn = (q: ODQuestion, value: string) => {
    const a = answers()[q.id]
    return q.multiSelect ? Array.isArray(a) && a.includes(value) : a === value
  }
  const labelFor = (q: ODQuestion, value: string) => q.options.find((o) => o.value === value)?.label ?? value

  const send = () => {
    if (props.onAnswer && !sent()) {
      const map = { ...answers() }
      const lines = props.questions
        .map((q) => {
          const a = map[q.id]
          if (a === undefined || (Array.isArray(a) && a.length === 0)) return null
          const val = Array.isArray(a) ? a.map((v) => labelFor(q, v)).join(", ") : labelFor(q, a)
          return `${q.header ?? q.question}: ${val}`
        })
        .filter(Boolean) as string[]
      if (extra().trim()) lines.push(extra().trim())
      const text = lines.join("\n")
      if (text) props.onAnswer({ toolUseId: props.toolUseId, text, answers: map })
    }
    setSent(true)
  }

  return (
    <div
      class="my-1 rounded-lg border p-2.5 text-[12px] leading-4"
      style={{ "border-color": `${OD_ACCENT}40`, background: `${OD_ACCENT}0d` }}
    >
      <div class="mb-1.5 flex items-center gap-1.5 text-[11px] font-[560] uppercase tracking-wide" style={{ color: OD_ACCENT }}>
        <span class="flex size-[14px] items-center justify-center rounded text-[7px] font-semibold" style={{ background: `${OD_ACCENT}26`, color: OD_ACCENT }}>?</span>
        Open Design needs input
      </div>
      <For each={props.questions}>
        {(q) => (
          <div class="mb-2 last:mb-0">
            <Show when={q.header || q.question}>
              <div class="mb-1 text-v2-text-text-base">
                <Show when={q.header}>
                  <span class="font-[560]">{q.header}</span>
                </Show>
                <Show when={q.question && q.question !== q.header}>
                  <span class="text-v2-text-text-muted"> {q.question}</span>
                </Show>
              </div>
            </Show>
            <div class="flex flex-wrap gap-1">
              <For each={q.options}>
                {(opt) => (
                  <button
                    type="button"
                    disabled={sent()}
                    class="rounded-md border px-2 py-1 text-[11px] transition-colors disabled:opacity-60"
                    classList={{
                      "text-v2-text-text-muted border-v2-border-border-base hover:bg-v2-background-bg-base": !isOn(q, opt.value),
                    }}
                    style={
                      isOn(q, opt.value)
                        ? { "border-color": OD_ACCENT, background: `${OD_ACCENT}26`, color: OD_ACCENT }
                        : undefined
                    }
                    title={opt.description}
                    onClick={() => pick(q, opt.value)}
                  >
                    {opt.label}
                  </button>
                )}
              </For>
            </div>
          </div>
        )}
      </For>
      <Show when={!sent()}>
        <div class="mt-2 flex items-center gap-1.5">
          <input
            type="text"
            value={extra()}
            onInput={(e) => setExtra(e.currentTarget.value)}
            placeholder="Add a note (optional)"
            class="min-w-0 flex-1 rounded-md border border-v2-border-border-base bg-v2-background-bg-base px-2 py-1 text-[11px] text-v2-text-text-base outline-none"
          />
          <button
            type="button"
            class="shrink-0 rounded-md px-2.5 py-1 text-[11px] font-[560] text-white"
            style={{ background: OD_ACCENT }}
            onClick={send}
          >
            Send
          </button>
        </div>
      </Show>
      <Show when={sent()}>
        <div class="mt-1.5 text-[11px] text-v2-text-text-faint">Answer sent to Open Design.</div>
      </Show>
    </div>
  )
}

function Chip(props: { icon: string; label: string; tone?: string }) {
  return (
    <span class="mr-1 inline-flex max-w-[220px] items-center gap-1 truncate rounded-md border border-v2-border-border-base bg-v2-background-bg-base px-1.5 py-0.5 text-[11px] text-v2-text-text-muted">
      <span class="text-[9px] font-semibold uppercase" style={{ color: props.tone ?? OD_ACCENT }}>
        {props.icon}
      </span>
      <span class="truncate">{props.label}</span>
    </span>
  )
}

function GenericTool(props: { name: string; input: unknown }) {
  const [open, setOpen] = createSignal(false)
  return (
    <div class="my-0.5 text-[11px]">
      <button
        type="button"
        class="flex items-center gap-1 rounded px-1 py-0.5 text-v2-text-text-muted transition-colors hover:bg-v2-background-bg-base"
        onClick={() => setOpen((v) => !v)}
      >
        <span class="text-v2-text-text-faint">{open() ? "▾" : "▸"}</span>
        <span class="font-[540]">{props.name}</span>
      </button>
      <Show when={open()}>
        <pre class="mt-0.5 max-h-40 overflow-auto rounded-md bg-v2-background-bg-base p-1.5 text-[10px] text-v2-text-text-muted">
          {(() => {
            try {
              return JSON.stringify(props.input, null, 2)
            } catch {
              return String(props.input)
            }
          })()}
        </pre>
      </Show>
    </div>
  )
}

function ThinkingBlock(props: { text: string }) {
  const [open, setOpen] = createSignal(false)
  return (
    <div class="my-0.5 text-[11px]">
      <button
        type="button"
        class="flex items-center gap-1 text-v2-text-text-faint transition-colors hover:text-v2-text-text-muted"
        onClick={() => setOpen((v) => !v)}
      >
        <span>{open() ? "▾" : "▸"}</span>
        <span class="italic">thinking</span>
      </button>
      <Show when={open()}>
        <div class="mt-0.5 whitespace-pre-wrap border-l-2 border-v2-border-border-base pl-2 text-v2-text-text-muted">{props.text}</div>
      </Show>
    </div>
  )
}

// Render a single OD event. `onAnswer` is invoked when the user responds to a
// question card.
export function ODEventItem(props: { event: ODEvent; onAnswer?: (a: ODAnswer) => void }): JSX.Element {
  const e = props.event
  return (
    <Switch fallback={null}>
      <Match when={e.kind === "text"}>
        <div class="whitespace-pre-wrap text-[12px] leading-5 text-v2-text-text-base">{(e as { text: string }).text}</div>
      </Match>
      <Match when={e.kind === "thinking"}>
        <ThinkingBlock text={(e as { text: string }).text} />
      </Match>
      <Match when={e.kind === "status"}>
        <span class="my-0.5 inline-block rounded-md bg-v2-background-bg-base px-1.5 py-0.5 text-[10px] text-v2-text-text-muted">
          {(e as { label: string }).label}
          <Show when={(e as { detail?: string }).detail}>
            <span class="text-v2-text-text-faint"> · {(e as { detail?: string }).detail}</span>
          </Show>
        </span>
      </Match>
      <Match when={e.kind === "tool_use"}>
        {(() => {
          const t = e as { id: string; name: string; input?: unknown }
          if (toolIs(t.name, "question", "askuser", "brief")) {
            const qs = parseQuestions(t.input)
            if (qs.length > 0) return <QuestionCard toolUseId={t.id} questions={qs} onAnswer={props.onAnswer} />
          }
          if (toolIs(t.name, "plugin")) {
            const r = asRecord(t.input)
            return <Chip icon="PLUGIN" label={firstString(r, "name", "title", "id") ?? t.name} />
          }
          if (toolIs(t.name, "asset", "attach", "file", "upload")) {
            const r = asRecord(t.input)
            return <Chip icon="ASSET" label={firstString(r, "name", "path", "filename", "title") ?? t.name} tone="#8b5cf6" />
          }
          if (toolIs(t.name, "media", "model", "aspect", "image", "video", "generate")) {
            const r = asRecord(t.input)
            const label = firstString(r, "model", "aspectRatio", "aspect", "prompt", "name") ?? t.name
            return <Chip icon="MEDIA" label={label} tone="#0ea5e9" />
          }
          return <GenericTool name={t.name} input={t.input} />
        })()}
      </Match>
      <Match when={e.kind === "tool_result"}>
        {(() => {
          const t = e as { content: string; isError?: boolean }
          const text = (t.content || "").trim()
          if (!text) return null
          return (
            <div
              class="my-0.5 max-h-24 overflow-auto rounded-md px-1.5 py-1 text-[11px]"
              classList={{
                "bg-v2-background-bg-base text-v2-text-text-muted": !t.isError,
                "bg-red-500/10 text-red-400": !!t.isError,
              }}
            >
              {text.slice(0, 600)}
            </div>
          )
        })()}
      </Match>
      <Match when={e.kind === "image"}>
        {(() => {
          const r = e as Record<string, unknown>
          const src = firstString(r, "url", "src", "dataUrl")
          if (!src || (!src.startsWith("http") && !src.startsWith("data:") && !src.startsWith("/"))) {
            return <Chip icon="IMG" label={firstString(r, "name", "alt") ?? "image"} tone="#0ea5e9" />
          }
          return <img src={src} alt={firstString(r, "alt", "name") ?? "Open Design image"} class="my-1 max-h-48 max-w-full rounded-md border border-v2-border-border-base" />
        })()}
      </Match>
      <Match when={e.kind === "live_artifact" || e.kind === "live_artifact_refresh"}>
        {(() => {
          const r = e as Record<string, unknown>
          return (
            <div class="my-1 rounded-md border px-2 py-1.5 text-[11px]" style={{ "border-color": `${OD_ACCENT}40`, background: `${OD_ACCENT}0d` }}>
              <span class="font-[560]" style={{ color: OD_ACCENT }}>Live artifact</span>
              <Show when={firstString(r, "title", "name")}>
                <span class="text-v2-text-text-muted"> · {firstString(r, "title", "name")}</span>
              </Show>
            </div>
          )
        })()}
      </Match>
    </Switch>
  )
}

// Render a full list of OD events (one assistant turn or the whole transcript
// slice). Unknown kinds are skipped.
export function ODEventList(props: { events: ODEvent[]; onAnswer?: (a: ODAnswer) => void }): JSX.Element {
  return (
    <div class="flex flex-col gap-0.5">
      <For each={props.events}>{(ev) => <ODEventItem event={ev} onAnswer={props.onAnswer} />}</For>
    </div>
  )
}
