import { createSignal, For, Show, Switch, Match, type JSX } from "solid-js"
import type { ODEvent } from "./open-design-mirror-types"

// The answer produced when the user responds to an Open Design question form.
// `text` is OD's exact `[form answers — <id>]` payload, ready to send back to
// the run; `answers` is the structured map; `toolUseId` is the form id (inline
// forms carry no tool_use id, so we use the <question-form id="...">).
export type ODAnswer = {
  toolUseId: string
  text: string
  answers: Record<string, string | string[]>
}

const OD_ACCENT = "#f97316"

// --- OD question-form contract (mirrors open-design/apps/web/src/artifacts/question-form.ts) ---
type FormQuestionType = "radio" | "checkbox" | "select" | "text" | "textarea" | "direction-cards"
type FormOption = { label: string; value: string; description?: string }
type FormQuestion = {
  id: string
  label: string
  type: FormQuestionType
  options?: FormOption[]
  placeholder?: string
  required?: boolean
  help?: string
  maxSelections?: number
}
type QuestionForm = { id: string; title?: string; description?: string; questions: FormQuestion[]; submitLabel?: string }

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {})
const firstString = (rec: Record<string, unknown>, ...keys: string[]): string | undefined => {
  for (const k of keys) if (typeof rec[k] === "string" && rec[k]) return rec[k] as string
  return undefined
}

function normalizeType(raw: unknown): FormQuestionType {
  const l = typeof raw === "string" ? raw.toLowerCase().trim() : ""
  if (l === "radio" || l === "checkbox" || l === "select" || l === "textarea" || l === "direction-cards") return l
  return "text"
}

// String options → {label,value}; object options → {label, value ?? label, description}.
function parseOptions(raw: unknown): FormOption[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: FormOption[] = []
  for (const o of raw) {
    if (typeof o === "string") out.push({ label: o, value: o })
    else if (o && typeof o === "object") {
      const or = o as Record<string, unknown>
      const label = String(or.label ?? or.value ?? "")
      if (!label) continue
      out.push({ label, value: String(or.value ?? or.label ?? label), description: or.description ? String(or.description) : undefined })
    }
  }
  return out.length ? out : undefined
}

function parseForm(body: string, attrs: Record<string, string>): QuestionForm | null {
  const stripped = body.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim()
  if (!stripped) return null
  let data: unknown
  try {
    data = JSON.parse(stripped)
  } catch {
    return null
  }
  const obj = asRecord(data)
  const rawQs = Array.isArray(obj.questions) ? obj.questions : null
  if (!rawQs) return null
  const questions: FormQuestion[] = []
  rawQs.forEach((q, i) => {
    const qo = asRecord(q)
    const id = typeof qo.id === "string" && qo.id.trim() ? qo.id.trim() : `q${i + 1}`
    const label = typeof qo.label === "string" ? qo.label : id
    const type = normalizeType(qo.type)
    let options = parseOptions(qo.options)
    // direction-cards: derive options from card metadata (id -> label).
    if (type === "direction-cards" && Array.isArray(qo.cards)) {
      const cards: FormOption[] = []
      for (const c of qo.cards) {
        const cr = asRecord(c)
        const l = String(cr.label ?? cr.id ?? "")
        if (l) cards.push({ label: l, value: String(cr.id ?? l), description: cr.mood ? String(cr.mood) : undefined })
      }
      if (cards.length) options = cards
    }
    const maxSelections =
      typeof qo.maxSelections === "number" && Number.isInteger(qo.maxSelections) && qo.maxSelections > 0 ? qo.maxSelections : undefined
    questions.push({
      id,
      label,
      type,
      ...(options ? { options } : {}),
      ...(typeof qo.placeholder === "string" ? { placeholder: qo.placeholder } : {}),
      ...(typeof qo.help === "string" ? { help: qo.help } : {}),
      ...(qo.required === true ? { required: true } : {}),
      ...(maxSelections !== undefined && type === "checkbox" ? { maxSelections } : {}),
    })
  })
  if (questions.length === 0) return null
  return {
    id: attrs.id ?? (typeof obj.id === "string" ? obj.id : "discovery"),
    title: attrs.title ?? (typeof obj.title === "string" ? obj.title : undefined),
    ...(typeof obj.description === "string" ? { description: obj.description } : {}),
    ...(typeof obj.submitLabel === "string" ? { submitLabel: obj.submitLabel } : {}),
    questions,
  }
}

function parseAttrs(raw: string): Record<string, string> {
  const re = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  const out: Record<string, string> = {}
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) out[m[1] as string] = (m[2] ?? m[3] ?? "") as string
  return out
}

type TextSegment = { kind: "text"; text: string } | { kind: "form"; form: QuestionForm }

// Split a text event into prose + inline <question-form> cards (matches OD's
// splitOnQuestionForms scan). Malformed tags fall back to raw text.
function splitInlineForms(input: string): TextSegment[] {
  const OPEN_RE = /<question-form\b([^>]*)>/i
  const CLOSE = "</question-form>"
  const out: TextSegment[] = []
  let cursor = 0
  if (!/<question-form\b/i.test(input)) return [{ kind: "text", text: input }]
  while (cursor < input.length) {
    const rest = input.slice(cursor)
    const m = OPEN_RE.exec(rest)
    if (!m) {
      out.push({ kind: "text", text: input.slice(cursor) })
      break
    }
    const openStart = cursor + m.index
    const openEnd = openStart + m[0].length
    if (openStart > cursor) out.push({ kind: "text", text: input.slice(cursor, openStart) })
    const closeIdx = input.indexOf(CLOSE, openEnd)
    if (closeIdx === -1) {
      out.push({ kind: "text", text: input.slice(openStart) })
      break
    }
    const form = parseForm(input.slice(openEnd, closeIdx), parseAttrs(m[1] ?? ""))
    if (form) out.push({ kind: "form", form })
    else out.push({ kind: "text", text: input.slice(openStart, closeIdx + CLOSE.length) })
    cursor = closeIdx + CLOSE.length
  }
  return out.filter((s) => s.kind === "form" || (s.kind === "text" && s.text.trim().length > 0))
}

// value -> display, matching OD's formOptionDisplayForValue.
function displayForValue(q: FormQuestion, value: string): string {
  const match = q.options?.find((o) => o.value === value || o.label === value)
  if (!match) return value
  return match.value === match.label ? match.label : `${match.label} [value: ${match.value}]`
}

// OD's formatFormAnswers: `[form answers — <id>]` then `- <label>: <display>`.
function formatFormAnswers(form: QuestionForm, answers: Record<string, string | string[]>): string {
  const lines = [`[form answers — ${form.id}]`]
  for (const q of form.questions) {
    const v = answers[q.id]
    let display: string
    if (Array.isArray(v)) display = v.length ? v.map((val) => displayForValue(q, val)).join(", ") : "(skipped)"
    else if (typeof v === "string") display = v.trim().length ? displayForValue(q, v.trim()) : "(skipped)"
    else display = "(skipped)"
    lines.push(`- ${q.label}: ${display}`)
  }
  return lines.join("\n")
}

// --- Rendering ---

function FormCard(props: { form: QuestionForm; onAnswer?: (a: ODAnswer) => void }) {
  const [answers, setAnswers] = createSignal<Record<string, string | string[]>>({})
  const [sent, setSent] = createSignal(false)

  const setSingle = (q: FormQuestion, value: string) => setAnswers((p) => ({ ...p, [q.id]: value }))
  const setText = (q: FormQuestion, value: string) => setAnswers((p) => ({ ...p, [q.id]: value }))
  const toggleMulti = (q: FormQuestion, value: string) =>
    setAnswers((p) => {
      const cur = Array.isArray(p[q.id]) ? (p[q.id] as string[]) : []
      if (cur.includes(value)) return { ...p, [q.id]: cur.filter((v) => v !== value) }
      if (q.maxSelections && cur.length >= q.maxSelections) return p // respect the cap
      return { ...p, [q.id]: [...cur, value] }
    })
  const isOn = (q: FormQuestion, value: string) => {
    const a = answers()[q.id]
    return q.type === "checkbox" ? Array.isArray(a) && a.includes(value) : a === value
  }

  const send = () => {
    if (props.onAnswer && !sent()) {
      props.onAnswer({ toolUseId: props.form.id, text: formatFormAnswers(props.form, answers()), answers: { ...answers() } })
    }
    setSent(true)
  }

  return (
    <div class="my-1.5 rounded-lg border p-2.5 text-[12px] leading-4" style={{ "border-color": `${OD_ACCENT}40`, background: `${OD_ACCENT}0d` }}>
      <div class="mb-1 flex items-center gap-1.5 text-[11px] font-[560] uppercase tracking-wide" style={{ color: OD_ACCENT }}>
        <span class="flex size-[14px] items-center justify-center rounded text-[7px] font-semibold" style={{ background: `${OD_ACCENT}26`, color: OD_ACCENT }}>?</span>
        {props.form.title ?? "Open Design needs input"}
      </div>
      <Show when={props.form.description}>
        <div class="mb-2 text-[11px] text-v2-text-text-muted">{props.form.description}</div>
      </Show>
      <For each={props.form.questions}>
        {(q) => (
          <div class="mb-2 last:mb-0">
            <div class="mb-1 text-v2-text-text-base">
              <span class="font-[540]">{q.label}</span>
              <Show when={q.required}>
                <span style={{ color: OD_ACCENT }}> *</span>
              </Show>
              <Show when={q.type === "checkbox" && q.maxSelections}>
                <span class="text-v2-text-text-faint"> · pick up to {q.maxSelections}</span>
              </Show>
            </div>
            <Show when={q.help}>
              <div class="mb-1 text-[11px] text-v2-text-text-faint">{q.help}</div>
            </Show>
            <Switch>
              <Match when={(q.type === "text" || q.type === "textarea") && !q.options}>
                <input
                  type="text"
                  disabled={sent()}
                  placeholder={q.placeholder ?? "Type an answer (optional)"}
                  value={typeof answers()[q.id] === "string" ? (answers()[q.id] as string) : ""}
                  onInput={(e) => setText(q, e.currentTarget.value)}
                  class="w-full rounded-md border border-v2-border-border-base bg-v2-background-bg-base px-2 py-1 text-[11px] text-v2-text-text-base outline-none disabled:opacity-60"
                />
              </Match>
              <Match when={q.type === "select" && q.options}>
                <select
                  disabled={sent()}
                  value={typeof answers()[q.id] === "string" ? (answers()[q.id] as string) : ""}
                  onChange={(e) => setSingle(q, e.currentTarget.value)}
                  class="max-w-full rounded-md border border-v2-border-border-base bg-v2-background-bg-base px-2 py-1 text-[11px] text-v2-text-text-base outline-none disabled:opacity-60"
                >
                  <option value="">Select…</option>
                  <For each={q.options}>{(opt) => <option value={opt.value} title={opt.description}>{opt.label}</option>}</For>
                </select>
              </Match>
              <Match when={q.type === "direction-cards" && q.options}>
                {/* direction-cards → visual cards showing label + mood/description */}
                <div class="grid grid-cols-2 gap-1.5">
                  <For each={q.options}>
                    {(opt) => (
                      <button
                        type="button"
                        disabled={sent()}
                        class="flex flex-col items-start gap-0.5 rounded-lg border p-2 text-left transition-colors disabled:opacity-60"
                        classList={{ "border-v2-border-border-base hover:bg-v2-background-bg-base": !isOn(q, opt.value) }}
                        style={isOn(q, opt.value) ? { "border-color": OD_ACCENT, background: `${OD_ACCENT}14` } : undefined}
                        onClick={() => setSingle(q, opt.value)}
                      >
                        <span
                          class="text-[12px] font-[560] text-v2-text-text-base"
                          style={isOn(q, opt.value) ? { color: OD_ACCENT } : undefined}
                        >
                          {opt.label}
                        </span>
                        <Show when={opt.description}>
                          <span class="text-[10px] leading-[13px] text-v2-text-text-muted">{opt.description}</span>
                        </Show>
                      </button>
                    )}
                  </For>
                </div>
              </Match>
              <Match when={q.options}>
                {/* radio / checkbox → option chips */}
                <div class="flex flex-wrap gap-1">
                  <For each={q.options}>
                    {(opt) => (
                      <button
                        type="button"
                        disabled={sent()}
                        title={opt.description}
                        class="rounded-md border px-2 py-1 text-[11px] transition-colors disabled:opacity-60"
                        classList={{ "text-v2-text-text-muted border-v2-border-border-base hover:bg-v2-background-bg-base": !isOn(q, opt.value) }}
                        style={isOn(q, opt.value) ? { "border-color": OD_ACCENT, background: `${OD_ACCENT}26`, color: OD_ACCENT } : undefined}
                        onClick={() => (q.type === "checkbox" ? toggleMulti(q, opt.value) : setSingle(q, opt.value))}
                      >
                        {opt.label}
                      </button>
                    )}
                  </For>
                </div>
              </Match>
              <Match when={true}>
                <input
                  type="text"
                  disabled={sent()}
                  placeholder={q.placeholder ?? "Type an answer (optional)"}
                  value={typeof answers()[q.id] === "string" ? (answers()[q.id] as string) : ""}
                  onInput={(e) => setText(q, e.currentTarget.value)}
                  class="w-full rounded-md border border-v2-border-border-base bg-v2-background-bg-base px-2 py-1 text-[11px] text-v2-text-text-base outline-none disabled:opacity-60"
                />
              </Match>
            </Switch>
          </div>
        )}
      </For>
      <Show when={!sent()} fallback={<div class="mt-1 text-[11px] text-v2-text-text-faint">Answer sent to Open Design.</div>}>
        <button type="button" class="mt-1.5 rounded-md px-2.5 py-1 text-[11px] font-[560] text-white" style={{ background: OD_ACCENT }} onClick={send}>
          {props.form.submitLabel ?? "Send answers"}
        </button>
      </Show>
    </div>
  )
}

function Chip(props: { icon: string; label: string; tone?: string }) {
  return (
    <span class="mr-1 inline-flex max-w-[220px] items-center gap-1 truncate rounded-md border border-v2-border-border-base bg-v2-background-bg-base px-1.5 py-0.5 text-[11px] text-v2-text-text-muted">
      <span class="text-[9px] font-semibold uppercase" style={{ color: props.tone ?? OD_ACCENT }}>{props.icon}</span>
      <span class="truncate">{props.label}</span>
    </span>
  )
}

function Collapsible(props: { label: string; children: JSX.Element; italic?: boolean }) {
  const [open, setOpen] = createSignal(false)
  return (
    <div class="my-0.5 text-[11px]">
      <button type="button" class="flex items-center gap-1 rounded px-1 py-0.5 text-v2-text-text-faint transition-colors hover:text-v2-text-text-muted" onClick={() => setOpen((v) => !v)}>
        <span>{open() ? "▾" : "▸"}</span>
        <span classList={{ italic: props.italic }}>{props.label}</span>
      </button>
      <Show when={open()}>{props.children}</Show>
    </div>
  )
}

// Render one OD event; `onAnswer` fires when the user answers a question form
// (either an inline <question-form> in a text event or a tool_use question).
export function ODEventItem(props: { event: ODEvent; onAnswer?: (a: ODAnswer) => void }): JSX.Element {
  const e = props.event
  return (
    <Switch fallback={null}>
      <Match when={e.kind === "text"}>
        <For each={splitInlineForms((e as { text: string }).text)}>
          {(seg) =>
            seg.kind === "form" ? (
              <FormCard form={seg.form} onAnswer={props.onAnswer} />
            ) : (
              <div class="whitespace-pre-wrap text-[12px] leading-5 text-v2-text-text-base">{seg.text}</div>
            )
          }
        </For>
      </Match>
      <Match when={e.kind === "thinking"}>
        <Collapsible label="thinking" italic>
          <div class="mt-0.5 whitespace-pre-wrap border-l-2 border-v2-border-border-base pl-2 text-v2-text-text-muted">{(e as { text: string }).text}</div>
        </Collapsible>
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
          const n = t.name.toLowerCase()
          // A few OD builds still emit questions as a tool_use — accept a form there too.
          if (/question|askuser|brief/.test(n)) {
            const r = asRecord(t.input)
            if (Array.isArray(r.questions)) {
              const form = parseForm(JSON.stringify(r), { id: String(r.id ?? t.id) })
              if (form) return <FormCard form={form} onAnswer={props.onAnswer} />
            }
          }
          if (n.includes("plugin")) return <Chip icon="PLUGIN" label={firstString(asRecord(t.input), "name", "title", "id") ?? t.name} />
          if (/asset|attach|upload|file/.test(n)) return <Chip icon="ASSET" label={firstString(asRecord(t.input), "name", "path", "filename", "title") ?? t.name} tone="#8b5cf6" />
          if (/media|model|aspect|image|video|generate/.test(n)) {
            const r = asRecord(t.input)
            const model = firstString(r, "model", "name")
            const aspect = firstString(r, "aspectRatio", "aspect", "ratio")
            const mediaPrompt = firstString(r, "prompt")
            return (
              <div class="flex flex-col gap-1 rounded-md border border-v2-border-border-base bg-v2-background-bg-base/60 px-2 py-1.5">
                <div class="flex flex-wrap items-center gap-1.5 text-[11px]">
                  <span class="rounded bg-[#0ea5e9]/15 px-1.5 py-0.5 font-[560] text-[#0ea5e9]">MEDIA</span>
                  <Show when={model}>
                    <span class="rounded bg-v2-background-bg-layer-02 px-1.5 py-0.5 text-v2-text-text-muted">model · {model}</span>
                  </Show>
                  <Show when={aspect}>
                    <span class="rounded bg-v2-background-bg-layer-02 px-1.5 py-0.5 text-v2-text-text-muted">aspect · {aspect}</span>
                  </Show>
                  <Show when={!model && !aspect}>
                    <span class="text-v2-text-text-muted">{t.name}</span>
                  </Show>
                </div>
                <Show when={mediaPrompt}>
                  <span class="line-clamp-2 text-[11px] text-v2-text-text-muted">{mediaPrompt}</span>
                </Show>
              </div>
            )
          }
          return (
            <Collapsible label={t.name}>
              <pre class="mt-0.5 max-h-40 overflow-auto rounded-md bg-v2-background-bg-base p-1.5 text-[10px] text-v2-text-text-muted">
                {(() => { try { return JSON.stringify(t.input, null, 2) } catch { return String(t.input) } })()}
              </pre>
            </Collapsible>
          )
        })()}
      </Match>
      <Match when={e.kind === "tool_result"}>
        {(() => {
          const t = e as { content: string; isError?: boolean }
          const text = (t.content || "").trim()
          if (!text) return null
          return (
            <div class="my-0.5 max-h-24 overflow-auto rounded-md px-1.5 py-1 text-[11px]" classList={{ "bg-v2-background-bg-base text-v2-text-text-muted": !t.isError, "bg-red-500/10 text-red-400": !!t.isError }}>
              {text.slice(0, 600)}
            </div>
          )
        })()}
      </Match>
      <Match when={e.kind === "image"}>
        {(() => {
          const r = e as Record<string, unknown>
          const src = firstString(r, "url", "src", "dataUrl")
          if (!src || (!src.startsWith("http") && !src.startsWith("data:") && !src.startsWith("/")))
            return <Chip icon="IMG" label={firstString(r, "name", "alt") ?? "image"} tone="#0ea5e9" />
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

// Render a list of OD events. Unknown kinds are skipped.
export function ODEventList(props: { events: ODEvent[]; onAnswer?: (a: ODAnswer) => void }): JSX.Element {
  return (
    <div class="flex flex-col gap-0.5">
      <For each={props.events}>{(ev) => <ODEventItem event={ev} onAnswer={props.onAnswer} />}</For>
    </div>
  )
}
