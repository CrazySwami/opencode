import { describe, expect, test } from "bun:test"
import {
  TOKEN_MAXING_STATUS_TONE,
  groupTokenMaxingSnapshotsByProvider,
  tokenMaxingAdapterId,
  tokenMaxingStatusTone,
  tokenMaxingUtilizationPct,
  type TokenMaxingSnapshot,
} from "./token-maxing-helpers"

const snapshot = (overrides: Partial<TokenMaxingSnapshot>): TokenMaxingSnapshot => ({
  provider: "claude",
  account: "default",
  used: 0,
  limit: 100,
  unit: "tokens",
  ...overrides,
})

describe("groupTokenMaxingSnapshotsByProvider", () => {
  test("groups accounts under their provider and sorts providers alphabetically", () => {
    const claude = snapshot({ provider: "claude", account: "acct-1" })
    const codex = snapshot({ provider: "codex", account: "acct-2" })

    const grouped = groupTokenMaxingSnapshotsByProvider([codex, claude])

    expect(grouped.map(([provider]) => provider)).toEqual(["claude", "codex"])
    expect(grouped[0][1]).toEqual([claude])
    expect(grouped[1][1]).toEqual([codex])
  })

  test("keeps multiple accounts for the same provider in a single pool, in original order", () => {
    const first = snapshot({ provider: "claude", account: "acct-1" })
    const second = snapshot({ provider: "claude", account: "acct-2" })

    const grouped = groupTokenMaxingSnapshotsByProvider([first, second])

    expect(grouped).toHaveLength(1)
    expect(grouped[0]).toEqual(["claude", [first, second]])
  })

  test("buckets snapshots with no provider under '?'", () => {
    const unknown = snapshot({ provider: undefined })

    const grouped = groupTokenMaxingSnapshotsByProvider([unknown])

    expect(grouped).toEqual([["?", [unknown]]])
  })

  test("returns an empty list for no snapshots", () => {
    expect(groupTokenMaxingSnapshotsByProvider([])).toEqual([])
  })
})

describe("tokenMaxingStatusTone", () => {
  test("resolves a tone class for every known daemon status", () => {
    for (const status of Object.keys(TOKEN_MAXING_STATUS_TONE)) {
      expect(tokenMaxingStatusTone(status)).toBe(TOKEN_MAXING_STATUS_TONE[status])
    }
  })

  test("falls back to the unavailable tone for an unknown status", () => {
    expect(tokenMaxingStatusTone("something_new")).toBe(TOKEN_MAXING_STATUS_TONE.unavailable)
  })

  test("falls back to the unavailable tone when status is missing", () => {
    expect(tokenMaxingStatusTone(undefined)).toBe(TOKEN_MAXING_STATUS_TONE.unavailable)
  })
})

describe("tokenMaxingUtilizationPct", () => {
  test("computes a rounded percentage of used over limit", () => {
    expect(tokenMaxingUtilizationPct({ used: 26, limit: 100 })).toBe(26)
    expect(tokenMaxingUtilizationPct({ used: 4, limit: 100 })).toBe(4)
    expect(tokenMaxingUtilizationPct({ used: 1, limit: 3 })).toBe(33)
  })

  test("clamps utilization at 100 when used exceeds limit", () => {
    expect(tokenMaxingUtilizationPct({ used: 150, limit: 100 })).toBe(100)
  })

  test("returns null when there is no limit", () => {
    expect(tokenMaxingUtilizationPct({ used: 10, limit: undefined })).toBeNull()
    expect(tokenMaxingUtilizationPct({ used: 10, limit: 0 })).toBeNull()
  })

  test("returns null when the snapshot is missing", () => {
    expect(tokenMaxingUtilizationPct(undefined)).toBeNull()
    expect(tokenMaxingUtilizationPct(null)).toBeNull()
  })
})

describe("tokenMaxingAdapterId", () => {
  test("prefers adapterId over id", () => {
    expect(tokenMaxingAdapterId({ adapterId: "adapter-1", id: "fallback-id" })).toBe("adapter-1")
  })

  test("falls back to id when adapterId is absent", () => {
    expect(tokenMaxingAdapterId({ id: "fallback-id" })).toBe("fallback-id")
  })

  test("returns undefined when neither is present", () => {
    expect(tokenMaxingAdapterId({})).toBeUndefined()
    expect(tokenMaxingAdapterId(undefined)).toBeUndefined()
  })
})
