// Pure data-shaping helpers for the Token Maxing side panel tab.
// Extracted from TokenMaxingTabContent (session-side-panel.tsx) so the
// grouping/tone/percentage logic can be unit tested without rendering
// the SolidJS component tree.

export type TokenMaxingSnapshot = {
  provider?: string
  account?: string
  used?: number | string
  limit?: number | string
  unit?: string
  status?: string
  evidence?: string
  utilization?: number
  freshnessSec?: number
  source?: string
  stale?: boolean
  adapterId?: string
  id?: string
}

// Tone per normalized lane status (from the daemon's /usage classifier).
export const TOKEN_MAXING_STATUS_TONE: Record<string, string> = {
  usage_observed: "text-emerald-300 border-emerald-500/30 bg-emerald-500/10",
  authenticated: "text-sky-300 border-sky-500/30 bg-sky-500/10",
  limited: "text-red-300 border-red-500/30 bg-red-500/10",
  cooling: "text-amber-300 border-amber-500/30 bg-amber-500/10",
  stale: "text-text-weak border-border-weaker-base bg-background-base",
  unavailable: "text-text-weak border-border-weaker-base bg-background-base",
}

export function tokenMaxingStatusTone(status?: string): string {
  return TOKEN_MAXING_STATUS_TONE[status ?? ""] ?? TOKEN_MAXING_STATUS_TONE.unavailable
}

export function tokenMaxingUtilizationPct(
  s: Pick<TokenMaxingSnapshot, "used" | "limit"> | undefined | null,
): number | null {
  return s?.limit ? Math.min(100, Math.round((Number(s.used) / Number(s.limit)) * 100)) : null
}

// Group accounts into per-provider pools (the "account pool" view), sorted
// alphabetically by provider name. Accounts without a provider are bucketed
// under "?".
export function groupTokenMaxingSnapshotsByProvider<T extends { provider?: string }>(
  snapshots: T[],
): [string, T[]][] {
  const groups: Record<string, T[]> = {}
  for (const s of snapshots) (groups[s.provider ?? "?"] ??= []).push(s)
  return Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0]))
}

export function tokenMaxingAdapterId(
  s: Pick<TokenMaxingSnapshot, "adapterId" | "id"> | undefined | null,
): string | undefined {
  return s?.adapterId ?? s?.id
}
