// SECURITY-CRITICAL: server-side encrypted env/secrets store.
//
// Secrets (API keys, env vars) are written ONCE to the server, encrypted at
// rest with AES-256-GCM, and only ever handed to spawned child processes via
// `secretsEnvFor(scope)` (mirroring the token-maxing minimalSpawnEnv pattern in
// tool/routines.ts). Plaintext values NEVER leave this module through any
// list/metadata API and there is deliberately no "get value" accessor exposed
// over HTTP.
//
// Crypto choices (documented for auditors):
//   - Cipher:    AES-256-GCM (authenticated encryption, per-entry).
//   - Key:       32 bytes. Source order:
//                  1. env OPENCODE_SECRETS_KEY (base64, must decode to 32 bytes)
//                  2. else generated with crypto.randomBytes(32) and persisted
//                     to `<store>/.master.key` (base64) with mode 0600 on first
//                     use. Never hardcoded.
//   - Nonce/IV:  12 random bytes (crypto.randomBytes) per encryption -- the
//                GCM-recommended nonce length. Stored alongside ciphertext.
//                A fresh IV is generated on every set, so re-encrypting the same
//                value yields different ciphertext.
//   - Auth tag:  16-byte GCM tag stored per entry; verified on decrypt (any
//                tamper of ciphertext/iv/tag/AAD fails decryption -> throws).
//   - AAD:       JSON.stringify([scope, name]) is bound as additional
//                authenticated data so a ciphertext cannot be moved between
//                entries/scopes (also serves as the injective store map key).

import { randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from "node:crypto"
import { mkdir, readFile, writeFile, rename, chmod } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const ALGO = "aes-256-gcm"
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const STORE_VERSION = 1

const GLOBAL_SCOPE = "global"

export type SecretMetadata = {
  name: string
  scope: string
  present: true
  updatedAt: number
  // Only the last four characters of the value, for operator identification.
  // Omitted for values shorter than 8 chars so we never approximate the whole.
  lastFour?: string
}

type StoredEntry = {
  name: string
  scope: string
  iv: string // base64
  tag: string // base64
  ct: string // base64 ciphertext
  updatedAt: number
  lastFour?: string
}

type StoreFile = {
  version: number
  entries: Record<string, StoredEntry>
}

// ---------------------------------------------------------------------------
// Path resolution. Store lives at <XDG_DATA_HOME|~/.local/share>/opencode-secrets/.
// OPENCODE_SECRETS_DIR overrides the directory (used for isolation in tests and
// by operators who want a dedicated volume).
// ---------------------------------------------------------------------------
function storeDir(): string {
  const override = process.env.OPENCODE_SECRETS_DIR
  if (override && override.length > 0) return override
  const xdg = process.env.XDG_DATA_HOME
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".local", "share")
  return path.join(base, "opencode-secrets")
}

function storeFilePath(): string {
  return path.join(storeDir(), "secrets.json")
}

function masterKeyPath(): string {
  return path.join(storeDir(), ".master.key")
}

// ---------------------------------------------------------------------------
// Flag: mutations (set/delete) are gated behind OPENCODE_SECRETS_ENABLED. Read
// of metadata and internal env injection are always available.
// ---------------------------------------------------------------------------
export function secretsEnabled(): boolean {
  const raw = process.env.OPENCODE_SECRETS_ENABLED
  if (!raw) return false
  const v = raw.trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

// ---------------------------------------------------------------------------
// In-process write serialization so concurrent set/delete cannot clobber the
// read-modify-write of the JSON file.
// ---------------------------------------------------------------------------
let writeChain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn)
  // Keep the chain alive but never reject it, so one failure doesn't wedge the
  // queue for later callers.
  writeChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

// ---------------------------------------------------------------------------
// Master key: env first, else generate + persist 0600. Cached in-process.
// ---------------------------------------------------------------------------
let cachedKey: Buffer | null = null
let cachedKeyDir: string | null = null

async function masterKey(): Promise<Buffer> {
  const dir = storeDir()
  // Bust the cache if the store dir changed (env override in tests).
  if (cachedKey && cachedKeyDir === dir) return cachedKey

  const fromEnv = process.env.OPENCODE_SECRETS_KEY
  if (fromEnv && fromEnv.length > 0) {
    const key = Buffer.from(fromEnv, "base64")
    if (key.length !== KEY_BYTES) {
      throw new Error(`OPENCODE_SECRETS_KEY must decode to ${KEY_BYTES} bytes (got ${key.length})`)
    }
    cachedKey = key
    cachedKeyDir = dir
    return key
  }

  await mkdir(dir, { recursive: true, mode: 0o700 })
  const keyFile = masterKeyPath()
  try {
    const existing = await readFile(keyFile, "utf8")
    const key = Buffer.from(existing.trim(), "base64")
    if (key.length === KEY_BYTES) {
      cachedKey = key
      cachedKeyDir = dir
      return key
    }
    // Corrupt/short key file: refuse rather than silently regenerate (would
    // orphan every existing ciphertext). Operators must intervene.
    throw new Error("master key file is present but invalid; refusing to overwrite")
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err
  }

  const key = randomBytes(KEY_BYTES)
  try {
    // Exclusive create (wx): if two processes race on first use, only one wins
    // the create — the loser must adopt the winner's key, never clobber it (a
    // clobber would orphan every ciphertext the winner already wrote).
    await writeFile(keyFile, key.toString("base64"), { mode: 0o600, flag: "wx" })
    await chmod(keyFile, 0o600).catch(() => {})
    cachedKey = key
    cachedKeyDir = dir
    return key
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err
    // Lost the race: another process created the key first — adopt it.
    const winner = Buffer.from((await readFile(keyFile, "utf8")).trim(), "base64")
    if (winner.length !== KEY_BYTES) {
      throw new Error("master key file is present but invalid; refusing to overwrite")
    }
    cachedKey = winner
    cachedKeyDir = dir
    return winner
  }
}

// ---------------------------------------------------------------------------
// Store file read/write (async only).
// ---------------------------------------------------------------------------
async function readStore(): Promise<StoreFile> {
  try {
    const raw = await readFile(storeFilePath(), "utf8")
    const parsed = JSON.parse(raw) as StoreFile
    if (!parsed || typeof parsed !== "object" || typeof parsed.entries !== "object") {
      return { version: STORE_VERSION, entries: {} }
    }
    return { version: parsed.version ?? STORE_VERSION, entries: parsed.entries ?? {} }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { version: STORE_VERSION, entries: {} }
    throw err
  }
}

async function writeStore(store: StoreFile): Promise<void> {
  const dir = storeDir()
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = storeFilePath()
  const tmp = file + "." + randomBytes(6).toString("hex") + ".tmp"
  await writeFile(tmp, JSON.stringify(store), { mode: 0o600 })
  await rename(tmp, file)
  await chmod(file, 0o600).catch(() => {})
}

function entryKey(scope: string, name: string): string {
  return JSON.stringify([scope, name])
}

function normalizeScope(scope?: string): string {
  const s = (scope ?? "").trim()
  return s.length > 0 ? s : GLOBAL_SCOPE
}

function computeLastFour(value: string): string | undefined {
  return value.length >= 8 ? value.slice(-4) : undefined
}

// ---------------------------------------------------------------------------
// Encryption / decryption. AAD binds name+scope.
// ---------------------------------------------------------------------------
function encrypt(key: Buffer, scope: string, name: string, value: string): Omit<StoredEntry, "name" | "scope" | "updatedAt" | "lastFour"> {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, key, iv, { authTagLength: TAG_BYTES })
  cipher.setAAD(Buffer.from(entryKey(scope, name), "utf8"))
  const ct = Buffer.concat([cipher.update(Buffer.from(value, "utf8")), cipher.final()])
  const tag = cipher.getAuthTag()
  return { iv: iv.toString("base64"), tag: tag.toString("base64"), ct: ct.toString("base64") }
}

function decrypt(key: Buffer, entry: StoredEntry): string {
  const iv = Buffer.from(entry.iv, "base64")
  const tag = Buffer.from(entry.tag, "base64")
  const ct = Buffer.from(entry.ct, "base64")
  const decipher = createDecipheriv(ALGO, key, iv, { authTagLength: TAG_BYTES })
  decipher.setAAD(Buffer.from(entryKey(entry.scope, entry.name), "utf8"))
  decipher.setAuthTag(tag)
  const pt = Buffer.concat([decipher.update(ct), decipher.final()])
  return pt.toString("utf8")
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

// Reasonable bounds to avoid abuse / accidental blobs.
const MAX_NAME = 256
const MAX_VALUE = 64 * 1024
const MAX_SCOPE = 256
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export type SetSecretInput = { name: string; value: string; scope?: string }

export async function setSecret(input: SetSecretInput): Promise<SecretMetadata> {
  const name = (input.name ?? "").trim()
  if (!name || name.length > MAX_NAME || !NAME_RE.test(name)) {
    // NOTE: never include the value in errors.
    throw new SecretsError(`invalid secret name`)
  }
  if (typeof input.value !== "string" || input.value.length === 0) {
    throw new SecretsError(`missing secret value for "${name}"`)
  }
  if (input.value.length > MAX_VALUE) {
    throw new SecretsError(`secret value for "${name}" exceeds maximum size`)
  }
  if (typeof input.scope === "string" && input.scope.length > MAX_SCOPE) {
    throw new SecretsError(`scope for "${name}" exceeds maximum size`)
  }
  const scope = normalizeScope(input.scope)
  const value = input.value

  return withLock(async () => {
    const key = await masterKey()
    const store = await readStore()
    const enc = encrypt(key, scope, name, value)
    const updatedAt = Date.now()
    const lastFour = computeLastFour(value)
    const entry: StoredEntry = { name, scope, ...enc, updatedAt, lastFour }
    store.entries[entryKey(scope, name)] = entry
    await writeStore(store)
    return { name, scope, present: true, updatedAt, ...(lastFour ? { lastFour } : {}) }
  })
}

export async function deleteSecret(name: string, scope?: string): Promise<boolean> {
  const n = (name ?? "").trim()
  const s = normalizeScope(scope)
  return withLock(async () => {
    const store = await readStore()
    const k = entryKey(s, n)
    if (!(k in store.entries)) return false
    delete store.entries[k]
    await writeStore(store)
    return true
  })
}

// listSecrets returns ONLY metadata -- never the plaintext value. This is the
// single security invariant that must hold for every read/list path.
export async function listSecrets(scope?: string): Promise<SecretMetadata[]> {
  const store = await readStore()
  const filter = scope === undefined ? undefined : normalizeScope(scope)
  const out: SecretMetadata[] = []
  for (const entry of Object.values(store.entries)) {
    if (filter !== undefined && entry.scope !== filter) continue
    out.push({
      name: entry.name,
      scope: entry.scope,
      present: true,
      updatedAt: entry.updatedAt,
      ...(entry.lastFour ? { lastFour: entry.lastFour } : {}),
    })
  }
  out.sort((a, b) => (a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope.localeCompare(b.scope)))
  return out
}

// INTERNAL ONLY -- the sole consumer of decrypted values. Returns a { NAME:
// value } map for injecting into a spawned child's env. Global secrets are
// included for every scope; scope-specific secrets override globals of the same
// name. This function is never routed over HTTP.
export async function secretsEnvFor(scope?: string): Promise<Record<string, string>> {
  const s = normalizeScope(scope)
  const key = await masterKey()
  const store = await readStore()
  const env: Record<string, string> = {}
  // Global first, then scope-specific so scope wins on name collision.
  for (const pass of s === GLOBAL_SCOPE ? [GLOBAL_SCOPE] : [GLOBAL_SCOPE, s]) {
    for (const entry of Object.values(store.entries)) {
      if (entry.scope !== pass) continue
      env[entry.name] = decrypt(key, entry)
    }
  }
  return env
}

// ---------------------------------------------------------------------------
// Redaction. walkSecrets-style guard: scrub any known plaintext secret value
// out of arbitrary structures/strings before they hit a log or error path.
// ---------------------------------------------------------------------------
const REDACTED = "***REDACTED***"

export function redact(input: unknown, secretValues: Iterable<string>): unknown {
  const secrets: string[] = []
  for (const v of secretValues) {
    if (typeof v === "string" && v.length >= 4) secrets.push(v)
  }
  // Longest first so overlapping values scrub cleanly.
  secrets.sort((a, b) => b.length - a.length)

  const scrubString = (str: string): string => {
    let out = str
    for (const secret of secrets) out = out.split(secret).join(REDACTED)
    return out
  }

  const seen = new WeakSet<object>()
  const walk = (val: unknown): unknown => {
    if (typeof val === "string") return scrubString(val)
    if (val === null || typeof val !== "object") return val
    if (seen.has(val as object)) return "[Circular]"
    seen.add(val as object)
    if (Array.isArray(val)) return val.map(walk)
    if (val instanceof Error) return scrubString(val.stack || val.message || String(val))
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) out[k] = walk(v)
    return out
  }
  return walk(input)
}

// Error type whose message is always scrubbed of any secret values passed in
// its context. Use this on any throw path that might carry a secret.
export class SecretsError extends Error {
  constructor(message: string, context?: { secrets?: Iterable<string> }) {
    const scrubbed = context?.secrets ? String(redact(message, context.secrets)) : message
    super(scrubbed)
    this.name = "SecretsError"
  }
}

// Exposed for tests: constant-time compare helper (used nowhere sensitive yet
// but kept alongside the crypto so future auth checks don't reach for ===).
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}
