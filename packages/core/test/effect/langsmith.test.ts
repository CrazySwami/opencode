import { afterEach, describe, expect, test } from "bun:test"
import { LangSmith } from "../../src/observability/langsmith"

const ENV_KEYS = ["LANGSMITH_API_KEY", "LANGSMITH_TRACING", "LANGSMITH_PROJECT"] as const
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
  (typeof ENV_KEYS)[number],
  string | undefined
>

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

describe("LangSmith.tracingConfig", () => {
  test("disabled by default when no env vars are set", () => {
    for (const key of ENV_KEYS) delete process.env[key]

    const config = LangSmith.tracingConfig()
    expect(config.enabled).toBe(false)
    expect(config.hasKey).toBe(false)
    expect(config.project).toBeNull()
  })

  test("disabled when a key is present but LANGSMITH_TRACING is not truthy", () => {
    process.env.LANGSMITH_API_KEY = "sk-test-secret-value"
    delete process.env.LANGSMITH_TRACING

    const config = LangSmith.tracingConfig()
    expect(config.enabled).toBe(false)
    expect(config.hasKey).toBe(true)
  })

  test("disabled when LANGSMITH_TRACING is truthy but no key is present", () => {
    delete process.env.LANGSMITH_API_KEY
    process.env.LANGSMITH_TRACING = "1"

    const config = LangSmith.tracingConfig()
    expect(config.enabled).toBe(false)
    expect(config.hasKey).toBe(false)
  })

  test("enabled when LANGSMITH_TRACING=1 and a key is present", () => {
    process.env.LANGSMITH_API_KEY = "sk-test-secret-value"
    process.env.LANGSMITH_TRACING = "1"
    process.env.LANGSMITH_PROJECT = "my-project"

    const config = LangSmith.tracingConfig()
    expect(config.enabled).toBe(true)
    expect(config.hasKey).toBe(true)
    expect(config.project).toBe("my-project")
  })

  test("enabled when LANGSMITH_TRACING=true (case-insensitive)", () => {
    process.env.LANGSMITH_API_KEY = "sk-test-secret-value"
    process.env.LANGSMITH_TRACING = "TRUE"

    expect(LangSmith.tracingConfig().enabled).toBe(true)
  })

  test("project is null when unset or blank", () => {
    process.env.LANGSMITH_API_KEY = "sk-test-secret-value"
    process.env.LANGSMITH_TRACING = "1"
    delete process.env.LANGSMITH_PROJECT
    expect(LangSmith.tracingConfig().project).toBeNull()

    process.env.LANGSMITH_PROJECT = "   "
    expect(LangSmith.tracingConfig().project).toBeNull()
  })

  test("never returns or embeds the raw API key value anywhere in the config", () => {
    const secret = "sk-super-secret-do-not-leak-123456"
    process.env.LANGSMITH_API_KEY = secret
    process.env.LANGSMITH_TRACING = "1"
    process.env.LANGSMITH_PROJECT = "proj"

    const config = LangSmith.tracingConfig()
    const serialized = JSON.stringify(config)

    // Only booleans + a non-secret project label should ever come out of this
    // module -- the key itself must never appear in the returned object.
    expect(Object.keys(config).sort()).toEqual(["enabled", "hasKey", "project"])
    expect(typeof config.enabled).toBe("boolean")
    expect(typeof config.hasKey).toBe("boolean")
    expect(serialized).not.toContain(secret)
  })
})

describe("LangSmith.tracingMetadata", () => {
  test("attaches stable non-secret tags and never includes env var values", () => {
    process.env.LANGSMITH_API_KEY = "sk-should-never-appear"
    process.env.LANGSMITH_TRACING = "1"

    const metadata = LangSmith.tracingMetadata({
      sessionId: "ses_123",
      model: "claude-opus-4",
      provider: "anthropic",
    })

    expect(metadata.sessionId).toBe("ses_123")
    expect(metadata.model).toBe("claude-opus-4")
    expect(metadata.provider).toBe("anthropic")
    expect(typeof metadata.env).toBe("string")
    expect(JSON.stringify(metadata)).not.toContain("sk-should-never-appear")
  })

  test("omits unset tags rather than inventing values", () => {
    const metadata = LangSmith.tracingMetadata({})
    expect(metadata.sessionId).toBeUndefined()
    expect(metadata.model).toBeUndefined()
    expect(metadata.provider).toBeUndefined()
    expect(typeof metadata.env).toBe("string")
  })
})
