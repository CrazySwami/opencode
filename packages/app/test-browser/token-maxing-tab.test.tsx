import { describe, expect, test, afterEach } from "bun:test"
import { cleanup, fireEvent, render, waitFor, within } from "@solidjs/testing-library"
import { TokenMaxingTabContent } from "@/pages/session/session-side-panel"

// The first component-render test for packages/app: everything else under
// src/**/*.test.ts and test-browser/**/*.test.ts exercises pure logic
// (helpers, virtualizer math, gesture math) via createRoot, never mounts a
// real component tree. This spins up a real Solid render (via
// @solidjs/testing-library, see test-browser/solid-render-setup.ts for the
// harness) against the Token Maxing panel and drives it through a fetch mock.

type FetchCall = { url: string; method: string; body?: unknown }

const USAGE_URL = "/experimental/token-maxing/usage"
const SWITCH_URL = "/experimental/token-maxing/switch"

const usageSnapshots = [
  {
    provider: "claude",
    account: "claude-code-max",
    used: 26,
    limit: 100,
    unit: "percent",
    status: "usage_observed",
    evidence: "live_api",
    utilization: 0.26,
    freshnessSec: 12,
    adapterId: "claude-sub:x",
  },
  {
    provider: "codex",
    account: "crazyswami13@gmail.com",
    used: 4,
    limit: 100,
    unit: "percent",
    status: "stale",
    evidence: "cached",
    freshnessSec: 2000,
    adapterId: "codex-account:y",
  },
]

/**
 * The component polls via a helper (`createPolledJson`) that reads its own
 * internal `pending` signal inside the async refresh function before its
 * first `await`. Under Solid's tracking rules that read is picked up as a
 * dependency of the driving `createEffect`, so every `setPending()` call -
 * including the one in the `finally` block - re-triggers the effect. With a
 * fetch mock that resolves on the microtask queue (a plain `async` function
 * returning a `Response` immediately) this becomes a same-tick feedback loop
 * that never yields to the macrotask queue, so real timers (and therefore
 * this test) never get a turn. Resolving the mock via a real `setTimeout`
 * (a macrotask) breaks the cycle open on every poll, which is enough for the
 * component to behave like it would against a real, non-instant network. See
 * `createPolledJson` in session-side-panel.tsx if this ever gets revisited.
 */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function mockFetch(calls: FetchCall[]) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    await delay(5)
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined })

    if (url.includes(USAGE_URL)) {
      return new Response(JSON.stringify({ ok: true, snapshots: usageSnapshots, generatedAt: "2026-07-10T00:00:00Z" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    if (url.includes(SWITCH_URL)) {
      return new Response(JSON.stringify({ ok: true, decision: { toAdapterId: "codex-account:y" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    return new Response("{}", { status: 200 })
  }) as typeof fetch
}

let originalFetch: typeof fetch

afterEach(() => {
  cleanup()
  if (originalFetch) globalThis.fetch = originalFetch
})

describe("TokenMaxingTabContent render", () => {
  test("renders provider pools with status badges and fails over an account", async () => {
    const calls: FetchCall[] = []
    originalFetch = globalThis.fetch
    globalThis.fetch = mockFetch(calls)

    const { getByTestId, getByLabelText } = render(() => <TokenMaxingTabContent />)

    const list = getByTestId("token-maxing-list")

    // Wait for the first poll to land and populate both provider pools.
    await waitFor(() => {
      expect(within(list).getByText("claude")).toBeTruthy()
      expect(within(list).getByText("codex")).toBeTruthy()
    })

    // Provider pool headers (rendered lowercase in the DOM; uppercase is a
    // CSS text-transform, not the text content).
    expect(within(list).getByText("claude")).toBeTruthy()
    expect(within(list).getByText("codex")).toBeTruthy()

    // Claude row: usage value + "usage observed" status badge.
    const claudeRow = within(list).getByText("claude-code-max").closest("div")!.parentElement!
    expect(within(claudeRow).getByText("26 / 100 percent")).toBeTruthy()
    expect(within(claudeRow).getByText("usage observed")).toBeTruthy()

    // Codex row: "stale" status badge.
    const codexRow = within(list).getByText("crazyswami13@gmail.com").closest("div")!.parentElement!
    expect(within(codexRow).getByText("stale")).toBeTruthy()

    // Drive the "Fail over" button on the claude row and confirm it POSTs
    // the right adapterId to the switch endpoint.
    const failOverButton = getByLabelText("Fail over from claude-code-max")
    fireEvent.click(failOverButton)

    await waitFor(() => {
      const switchCall = calls.find((c) => c.url.includes(SWITCH_URL))
      expect(switchCall).toBeTruthy()
      expect(switchCall?.method).toBe("POST")
      expect(switchCall?.body).toMatchObject({ adapterId: "claude-sub:x" })
    })
  })
})
