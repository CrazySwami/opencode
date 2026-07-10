// SECURITY-CRITICAL tests for the encrypted secrets store. These prove the
// hard invariants: values are encrypted at rest, plaintext never leaks through
// any list/metadata path, and error paths are redacted.
//
// NOTE: the repo standardizes on bun:test (no vitest is installed); the
// describe/expect/test API is identical. Run: `bun test test/secrets/store.test.ts`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import os from "node:os"
import path from "node:path"

import * as Secrets from "@/secrets/store"

let dir: string
const KEY = randomBytes(32).toString("base64")

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "opencode-secrets-test-"))
  process.env.OPENCODE_SECRETS_DIR = dir
  process.env.OPENCODE_SECRETS_KEY = KEY
  process.env.OPENCODE_SECRETS_ENABLED = "1"
})

afterEach(async () => {
  delete process.env.OPENCODE_SECRETS_DIR
  delete process.env.OPENCODE_SECRETS_KEY
  delete process.env.OPENCODE_SECRETS_ENABLED
  await rm(dir, { recursive: true, force: true })
})

const SECRET_VALUE = "sk-live-SUPERSECRET-9f8e7d6c5b4a-value"

describe("secrets store crypto", () => {
  test("encrypt -> decrypt round-trip via secretsEnvFor returns the original value", async () => {
    await Secrets.setSecret({ name: "OPENAI_API_KEY", value: SECRET_VALUE })
    const env = await Secrets.secretsEnvFor()
    expect(env.OPENAI_API_KEY).toBe(SECRET_VALUE)
  })

  test("scope-specific secret overrides a global one of the same name", async () => {
    await Secrets.setSecret({ name: "TOKEN", value: "global-token-value-1234" })
    await Secrets.setSecret({ name: "TOKEN", value: "pool-token-value-5678", scope: "pool-a" })
    expect((await Secrets.secretsEnvFor()).TOKEN).toBe("global-token-value-1234")
    expect((await Secrets.secretsEnvFor("pool-a")).TOKEN).toBe("pool-token-value-5678")
    // A different scope only sees the global fallback.
    expect((await Secrets.secretsEnvFor("pool-b")).TOKEN).toBe("global-token-value-1234")
  })

  test("ciphertext on disk != plaintext (encrypted at rest)", async () => {
    await Secrets.setSecret({ name: "DB_PASSWORD", value: SECRET_VALUE })
    const onDisk = await readFile(path.join(dir, "secrets.json"), "utf8")
    expect(onDisk).not.toContain(SECRET_VALUE)
    // Also ensure common substrings of the secret are absent.
    expect(onDisk).not.toContain("SUPERSECRET")
  })

  test("tampering with ciphertext fails authenticated decryption", async () => {
    await Secrets.setSecret({ name: "API_KEY", value: SECRET_VALUE })
    const file = path.join(dir, "secrets.json")
    const store = JSON.parse(await readFile(file, "utf8"))
    const key = Object.keys(store.entries)[0]
    // Flip the ciphertext so the GCM auth tag no longer verifies.
    const entry = store.entries[key]
    const ct = Buffer.from(entry.ct, "base64")
    ct[0] = ct[0] ^ 0xff
    entry.ct = ct.toString("base64")
    await Bun.write(file, JSON.stringify(store))
    await expect(Secrets.secretsEnvFor()).rejects.toThrow()
  })

  test("wrong master key cannot decrypt (auth failure)", async () => {
    await Secrets.setSecret({ name: "API_KEY", value: SECRET_VALUE })
    process.env.OPENCODE_SECRETS_KEY = randomBytes(32).toString("base64")
    // Force key cache bust by pointing at a fresh dir handle is unnecessary —
    // the module re-reads the env when the dir changes; simulate that by moving
    // to a copy dir with same file but different key.
    const dir2 = await mkdtemp(path.join(os.tmpdir(), "opencode-secrets-test2-"))
    await Bun.write(path.join(dir2, "secrets.json"), await readFile(path.join(dir, "secrets.json"), "utf8"))
    process.env.OPENCODE_SECRETS_DIR = dir2
    await expect(Secrets.secretsEnvFor()).rejects.toThrow()
    await rm(dir2, { recursive: true, force: true })
  })
})

describe("secrets store never leaks plaintext", () => {
  test("listSecrets NEVER contains the plaintext value", async () => {
    await Secrets.setSecret({ name: "SECRET_ONE", value: SECRET_VALUE, scope: "proj-x" })
    const list = await Secrets.listSecrets()
    const serialized = JSON.stringify(list)
    expect(serialized).not.toContain(SECRET_VALUE)
    expect(serialized).not.toContain("SUPERSECRET")
    // Metadata shape is exactly the allowlisted fields.
    const entry = list.find((s) => s.name === "SECRET_ONE")!
    expect(entry).toBeDefined()
    expect(entry.present).toBe(true)
    expect(entry.scope).toBe("proj-x")
    expect(typeof entry.updatedAt).toBe("number")
    expect(entry.lastFour).toBe("alue")
    expect(Object.keys(entry).sort()).toEqual(["lastFour", "name", "present", "scope", "updatedAt"])
    // Crucially: no "value" field anywhere.
    expect(serialized).not.toContain("\"value\"")
  })

  test("setSecret return value is metadata only (never echoes the value)", async () => {
    const meta = await Secrets.setSecret({ name: "ECHO_TEST", value: SECRET_VALUE })
    const serialized = JSON.stringify(meta)
    expect(serialized).not.toContain(SECRET_VALUE)
    expect((meta as any).value).toBeUndefined()
    expect(meta.name).toBe("ECHO_TEST")
    expect(meta.present).toBe(true)
  })

  test("short values (<8 chars) get no lastFour approximation", async () => {
    const meta = await Secrets.setSecret({ name: "SHORT", value: "abc" })
    expect(meta.lastFour).toBeUndefined()
  })
})

describe("redaction", () => {
  test("a thrown error carrying a secret in context comes out redacted", () => {
    const err = new Secrets.SecretsError(`connection failed using key ${SECRET_VALUE}`, {
      secrets: [SECRET_VALUE],
    })
    expect(err.message).not.toContain(SECRET_VALUE)
    expect(err.message).toContain("***REDACTED***")
  })

  test("redact() scrubs secret values from arbitrary nested structures", () => {
    const payload = {
      note: `token is ${SECRET_VALUE} here`,
      nested: { arr: ["prefix-" + SECRET_VALUE, "clean"] },
      err: new Error(`boom ${SECRET_VALUE}`),
    }
    const cleaned = JSON.stringify(Secrets.redact(payload, [SECRET_VALUE]))
    expect(cleaned).not.toContain(SECRET_VALUE)
    expect(cleaned).not.toContain("SUPERSECRET")
    expect(cleaned).toContain("***REDACTED***")
  })
})

describe("mutations & flag", () => {
  test("delete removes a secret; secretsEnvFor no longer returns it", async () => {
    await Secrets.setSecret({ name: "TEMP", value: "temp-value-12345678" })
    expect((await Secrets.secretsEnvFor()).TEMP).toBe("temp-value-12345678")
    const deleted = await Secrets.deleteSecret("TEMP")
    expect(deleted).toBe(true)
    expect((await Secrets.secretsEnvFor()).TEMP).toBeUndefined()
    expect(await Secrets.deleteSecret("TEMP")).toBe(false)
  })

  test("secretsEnabled reflects OPENCODE_SECRETS_ENABLED", () => {
    process.env.OPENCODE_SECRETS_ENABLED = "1"
    expect(Secrets.secretsEnabled()).toBe(true)
    process.env.OPENCODE_SECRETS_ENABLED = "false"
    expect(Secrets.secretsEnabled()).toBe(false)
    delete process.env.OPENCODE_SECRETS_ENABLED
    expect(Secrets.secretsEnabled()).toBe(false)
  })

  test("invalid names are rejected without ever surfacing the value", async () => {
    await expect(Secrets.setSecret({ name: "bad name!", value: SECRET_VALUE })).rejects.toThrow()
    try {
      await Secrets.setSecret({ name: "1BADSTART", value: SECRET_VALUE })
    } catch (err: any) {
      expect(String(err.message)).not.toContain(SECRET_VALUE)
    }
  })

  test("generates a 0600 master key file when OPENCODE_SECRETS_KEY is unset", async () => {
    const genDir = await mkdtemp(path.join(os.tmpdir(), "opencode-secrets-gen-"))
    delete process.env.OPENCODE_SECRETS_KEY
    process.env.OPENCODE_SECRETS_DIR = genDir
    await Secrets.setSecret({ name: "GENERATED", value: "value-from-generated-key" })
    expect((await Secrets.secretsEnvFor()).GENERATED).toBe("value-from-generated-key")
    const { stat } = await import("node:fs/promises")
    const st = await stat(path.join(genDir, ".master.key"))
    expect(st.mode & 0o777).toBe(0o600)
    await rm(genDir, { recursive: true, force: true })
  })

  test("rejects an oversized scope (abuse bound) without leaking the value", async () => {
    const hugeScope = "x".repeat(300)
    await expect(
      Secrets.setSecret({ name: "SCOPED", value: SECRET_VALUE, scope: hugeScope }),
    ).rejects.toThrow(/scope .* maximum size/)
  })

  test("listSecrets returns metadata only — never a plaintext value", async () => {
    await Secrets.setSecret({ name: "LISTED", value: SECRET_VALUE })
    const list = await Secrets.listSecrets()
    const json = JSON.stringify(list)
    expect(json).not.toContain(SECRET_VALUE)
    const entry = list.find((s: any) => s.name === "LISTED") as any
    expect(entry).toBeTruthy()
    expect(entry.value).toBeUndefined()
  })

  test("secretsEnvFor: scope-specific value overrides a global of the same name", async () => {
    await Secrets.setSecret({ name: "SHARED", value: "global-val" })
    await Secrets.setSecret({ name: "SHARED", value: "scoped-val", scope: "proj" })
    await Secrets.setSecret({ name: "ONLY_GLOBAL", value: "g" })
    const globalEnv = await Secrets.secretsEnvFor()
    expect(globalEnv.SHARED).toBe("global-val")
    expect(globalEnv.ONLY_GLOBAL).toBe("g")
    const scopedEnv = await Secrets.secretsEnvFor("proj")
    expect(scopedEnv.SHARED).toBe("scoped-val") // scope wins
    expect(scopedEnv.ONLY_GLOBAL).toBe("g") // global still present
  })

})
