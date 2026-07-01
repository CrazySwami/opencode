type AppleBridgeEventPayload = unknown

const appleBridgeIngestURL = () =>
  (process.env.OPENCODE_IOS_BRIDGE_INGEST_URL || process.env.OPENCODE_APPLE_BRIDGE_INGEST_URL || "").trim()

export function publishAppleBridgeEvent(source: string, event: string, payload: AppleBridgeEventPayload) {
  const endpoint = appleBridgeIngestURL()
  if (!endpoint) return
  const body = {
    source,
    event,
    timestamp: new Date().toISOString(),
    payload,
  }
  void fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => undefined)
}
