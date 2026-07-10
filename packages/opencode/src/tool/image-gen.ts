// Provider-agnostic image generation. Routes a prompt to whichever backend is
// actually reachable/configured: the local FLUX hub first (fast, free, no
// key), then Recraft, then Gemini. Never returns or logs secret values --
// only presence/reachability booleans ever leave this module for status, and
// any API key is scrubbed out of error text before it's returned.

export type ImageProviderID = "local" | "recraft" | "gemini"

export type ImageProviderStatus = {
  local: { id: "local"; reachable: boolean; url: string }
  recraft: { id: "recraft"; configured: boolean }
  gemini: { id: "gemini"; configured: boolean }
}

export type GenerateImageResult =
  | { ok: true; provider: ImageProviderID; url?: string; dataUri?: string }
  | { ok: false; provider?: ImageProviderID; error: string }

// Order providers are tried in when no explicit preference is given (or the
// preferred provider turns out to be unavailable).
const PROVIDER_ORDER: ImageProviderID[] = ["local", "recraft", "gemini"]

// Probing reachability (GET /status on the hub) should be fast -- it's just a
// health check, not the generation call itself.
const PROBE_TIMEOUT_MS = 3_000
// Actual generation can take 10-30s on local FLUX hardware, so give it real
// headroom -- comfortably above the 3s floor.
const GENERATE_TIMEOUT_MS = 45_000

export function isImageProviderID(value: unknown): value is ImageProviderID {
  return value === "local" || value === "recraft" || value === "gemini"
}

export function localHubUrl(): string {
  return process.env.OPENCODE_IMAGE_HUB_URL?.trim() || "http://127.0.0.1:8766"
}

async function probeLocalHub(timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  try {
    const res = await fetch(`${localHubUrl()}/status`, { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok
  } catch {
    return false
  }
}

// Presence/reachability booleans only -- never the key values themselves.
export async function imageProviderStatus(opts?: { timeoutMs?: number }): Promise<ImageProviderStatus> {
  const reachable = await probeLocalHub(opts?.timeoutMs)
  return {
    local: { id: "local", reachable, url: localHubUrl() },
    recraft: { id: "recraft", configured: !!process.env.RECRAFT_API_KEY?.trim() },
    gemini: { id: "gemini", configured: !!process.env.GEMINI_API_KEY?.trim() },
  }
}

function isProviderAvailable(status: ImageProviderStatus, id: ImageProviderID): boolean {
  if (id === "local") return status.local.reachable
  if (id === "recraft") return status.recraft.configured
  return status.gemini.configured
}

// Pure selection logic (no I/O): pick the first available provider, trying
// the caller's preference first (if given), then falling back through the
// default order. Returns undefined when nothing is available -- the caller
// is expected to handle that gracefully rather than throw.
export function pickProvider(status: ImageProviderStatus, preferred?: ImageProviderID): ImageProviderID | undefined {
  const order = preferred ? [preferred, ...PROVIDER_ORDER.filter((id) => id !== preferred)] : PROVIDER_ORDER
  return order.find((id) => isProviderAvailable(status, id))
}

function redactSecrets(text: string): string {
  const secrets = [process.env.RECRAFT_API_KEY, process.env.GEMINI_API_KEY].filter(
    (value): value is string => !!value && value.trim().length >= 6,
  )
  let redacted = text
  for (const secret of secrets) redacted = redacted.split(secret).join("***REDACTED***")
  return redacted
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return redactSecrets(message)
}

function resolveHubAssetUrl(value: string): string {
  if (/^https?:\/\//i.test(value)) return value
  const base = localHubUrl().replace(/\/+$/, "")
  return `${base}${value.startsWith("/") ? "" : "/"}${value}`
}

async function generateWithLocalHub(prompt: string, size?: string): Promise<GenerateImageResult> {
  try {
    const res = await fetch(`${localHubUrl()}/v1/images/generations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, n: 1, size: size ?? "768x768", response_format: "b64_json" }),
      signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
    })
    if (!res.ok) return { ok: false, provider: "local", error: `Local image hub responded with ${res.status}` }
    const data = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> }
    const first = data.data?.[0]
    if (first?.b64_json) return { ok: true, provider: "local", dataUri: `data:image/png;base64,${first.b64_json}` }
    if (first?.url) return { ok: true, provider: "local", url: resolveHubAssetUrl(first.url) }
    return { ok: false, provider: "local", error: "Local image hub returned no image data" }
  } catch (error) {
    return { ok: false, provider: "local", error: describeError(error) }
  }
}

async function generateWithRecraft(prompt: string, size?: string): Promise<GenerateImageResult> {
  const key = process.env.RECRAFT_API_KEY?.trim()
  if (!key) return { ok: false, provider: "recraft", error: "RECRAFT_API_KEY is not configured" }
  try {
    const res = await fetch("https://external.api.recraft.ai/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ prompt, size: size ?? "1024x1024", n: 1 }),
      signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
    })
    if (!res.ok) return { ok: false, provider: "recraft", error: `Recraft responded with ${res.status}` }
    const data = (await res.json()) as { data?: Array<{ url?: string; b64_json?: string }> }
    const first = data.data?.[0]
    if (first?.url) return { ok: true, provider: "recraft", url: first.url }
    if (first?.b64_json) return { ok: true, provider: "recraft", dataUri: `data:image/png;base64,${first.b64_json}` }
    return { ok: false, provider: "recraft", error: "Recraft returned no image data" }
  } catch (error) {
    return { ok: false, provider: "recraft", error: describeError(error) }
  }
}

async function generateWithGemini(prompt: string): Promise<GenerateImageResult> {
  const key = process.env.GEMINI_API_KEY?.trim()
  if (!key) return { ok: false, provider: "gemini", error: "GEMINI_API_KEY is not configured" }
  try {
    const model = process.env.OPENCODE_GEMINI_IMAGE_MODEL?.trim() || "imagen-3.0-generate-002"
    // Auth via header (not a URL query param) so the key can never end up in
    // an error message that echoes back the request URL.
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:predict`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ instances: [{ prompt }], parameters: { sampleCount: 1 } }),
      signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
    })
    if (!res.ok) return { ok: false, provider: "gemini", error: `Gemini responded with ${res.status}` }
    const data = (await res.json()) as { predictions?: Array<{ bytesBase64Encoded?: string }> }
    const first = data.predictions?.[0]
    if (first?.bytesBase64Encoded)
      return { ok: true, provider: "gemini", dataUri: `data:image/png;base64,${first.bytesBase64Encoded}` }
    return { ok: false, provider: "gemini", error: "Gemini returned no image data" }
  } catch (error) {
    return { ok: false, provider: "gemini", error: describeError(error) }
  }
}

export async function generateImage(input: {
  prompt: string
  provider?: ImageProviderID
  size?: string
}): Promise<GenerateImageResult> {
  const prompt = input.prompt?.trim()
  if (!prompt) return { ok: false, error: "prompt is required" }

  const status = await imageProviderStatus()
  const chosen = pickProvider(status, input.provider)
  if (!chosen) {
    return {
      ok: false,
      error:
        "No image generation provider is available. Start the local hub " +
        `(${localHubUrl()}, override with OPENCODE_IMAGE_HUB_URL), or set RECRAFT_API_KEY / GEMINI_API_KEY.`,
    }
  }

  if (chosen === "local") return generateWithLocalHub(prompt, input.size)
  if (chosen === "recraft") return generateWithRecraft(prompt, input.size)
  return generateWithGemini(prompt)
}
