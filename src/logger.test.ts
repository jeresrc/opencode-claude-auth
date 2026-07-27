import assert from "node:assert/strict"
import { describe, it, beforeEach, afterEach } from "node:test"
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { PassThrough } from "node:stream"
import { initLogger, log, closeLogger, redact } from "./logger.ts"

describe("logger", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "claude-auth-log-test-"))
    delete process.env.CLAUDE_AUTH_DEBUG
  })

  afterEach(() => {
    closeLogger()
    delete process.env.CLAUDE_AUTH_DEBUG
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe("no-op mode", () => {
    it("log() does nothing when CLAUDE_AUTH_DEBUG is unset", () => {
      initLogger()
      log("test_event", { key: "value" })
      // No file should be created at default path
      const defaultPath = join(tmpDir, "claude-auth-debug.log")
      assert.ok(!existsSync(defaultPath), "No log file should be created")
    })

    it("log() does nothing when CLAUDE_AUTH_DEBUG is empty string", () => {
      process.env.CLAUDE_AUTH_DEBUG = ""
      initLogger()
      log("test_event", { key: "value" })
      const defaultPath = join(tmpDir, "claude-auth-debug.log")
      assert.ok(!existsSync(defaultPath), "No log file should be created")
    })
  })

  describe("file mode", () => {
    it("writes JSON lines to the specified path", () => {
      const logPath = join(tmpDir, "test.log")
      process.env.CLAUDE_AUTH_DEBUG = logPath
      initLogger()

      log("test_event", { key: "value" })

      const content = readFileSync(logPath, "utf-8").trim()
      const parsed = JSON.parse(content)
      assert.equal(parsed.event, "test_event")
      assert.equal(parsed.key, "value")
      assert.ok(parsed.ts, "should have a timestamp")
    })

    it("appends multiple events as separate lines", () => {
      const logPath = join(tmpDir, "test.log")
      process.env.CLAUDE_AUTH_DEBUG = logPath
      initLogger()

      log("event_one", { a: 1 })
      log("event_two", { b: 2 })

      const lines = readFileSync(logPath, "utf-8").trim().split("\n")
      assert.equal(lines.length, 2)
      assert.equal(JSON.parse(lines[0]).event, "event_one")
      assert.equal(JSON.parse(lines[1]).event, "event_two")
    })

    it("truncates the file on initLogger()", () => {
      const logPath = join(tmpDir, "test.log")
      process.env.CLAUDE_AUTH_DEBUG = logPath

      // First session
      initLogger()
      log("old_event", {})
      closeLogger()

      // Second session — should truncate
      initLogger()
      log("new_event", {})

      const lines = readFileSync(logPath, "utf-8").trim().split("\n")
      assert.equal(lines.length, 1)
      assert.equal(JSON.parse(lines[0]).event, "new_event")
    })

    it("creates parent directories if they don't exist", () => {
      const logPath = join(tmpDir, "nested", "dirs", "test.log")
      process.env.CLAUDE_AUTH_DEBUG = logPath
      initLogger()

      log("test_event", {})

      assert.ok(
        existsSync(logPath),
        "Log file should be created in nested dirs",
      )
    })

    it("treats CLAUDE_AUTH_DEBUG=1 as default path", () => {
      process.env.CLAUDE_AUTH_DEBUG = "1"
      // Just verify initLogger doesn't throw — we can't easily assert
      // the default path without polluting the real filesystem
      initLogger()
      log("test_event", {})
      closeLogger()
    })
  })

  describe("stream mode", () => {
    it("writes JSON lines to a provided stream", () => {
      const stream = new PassThrough()
      const chunks: string[] = []
      stream.on("data", (chunk) => chunks.push(chunk.toString()))

      initLogger({ stream })
      log("stream_event", { key: "value" })

      const parsed = JSON.parse(chunks.join("").trim())
      assert.equal(parsed.event, "stream_event")
      assert.equal(parsed.key, "value")
    })

    it("ignores CLAUDE_AUTH_DEBUG env var when stream is provided", () => {
      const logPath = join(tmpDir, "should-not-exist.log")
      process.env.CLAUDE_AUTH_DEBUG = logPath

      const stream = new PassThrough()
      const chunks: string[] = []
      stream.on("data", (chunk) => chunks.push(chunk.toString()))

      initLogger({ stream })
      log("stream_event", {})

      assert.ok(
        !existsSync(logPath),
        "File should not be created when stream is provided",
      )
      assert.ok(chunks.length > 0, "Stream should have received data")
    })

    it("recursively redacts structured data while preserving context", () => {
      const stream = new PassThrough()
      const chunks: string[] = []
      stream.on("data", (chunk) => chunks.push(chunk.toString()))
      const jwt = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature"
      const error = new Error(
        `failed with Bearer opaque-error-token access_token=access-secret refresh_token=refresh-secret sk-ant-api03-error ${jwt}`,
      )

      initLogger({ stream })
      log("auth_recovery_failed", {
        status: 401,
        modelId: "claude-sonnet-4-6",
        phase: "refresh",
        type: "oauth",
        nested: {
          authorization: "Bearer opaque-nested-token",
          items: [
            { access_token: "access-nested", refresh_token: "refresh-nested" },
            `retry with ${jwt}`,
            "sk-ant-api03-nested",
          ],
        },
        error,
      })

      const parsed = JSON.parse(chunks.join("").trim())
      assert.equal(parsed.status, 401)
      assert.equal(parsed.modelId, "claude-sonnet-4-6")
      assert.equal(parsed.phase, "refresh")
      assert.equal(parsed.type, "oauth")
      assert.equal(parsed.nested.authorization, "Bearer REDACTED")
      assert.deepEqual(parsed.nested.items, [
        { access_token: "REDACTED", refresh_token: "REDACTED" },
        "retry with JWT_REDACTED",
        "sk-ant-REDACTED",
      ])
      assert.equal(parsed.error.name, "Error")
      assert.equal(
        parsed.error.message,
        "failed with Bearer REDACTED access_token=REDACTED refresh_token=REDACTED sk-ant-REDACTED JWT_REDACTED",
      )
      assert.equal(typeof parsed.error.stack, "string")

      const output = JSON.stringify(parsed)
      assert.ok(!output.includes("opaque-error-token"))
      assert.ok(!output.includes("opaque-nested-token"))
      assert.ok(!output.includes("access-secret"))
      assert.ok(!output.includes("refresh-secret"))
      assert.ok(!output.includes("access-nested"))
      assert.ok(!output.includes("refresh-nested"))
      assert.ok(!output.includes("api03-error"))
      assert.ok(!output.includes("api03-nested"))
      assert.ok(!output.includes(jwt))
    })

    it("redacts own data properties on class instances without leaking secrets", () => {
      class Credentials {
        refreshToken = "class-refresh-secret"
        Authorization = "Bearer class-authorization-secret"
        nested = { access_token: "class-access-secret" }
      }

      const stream = new PassThrough()
      const chunks: string[] = []
      stream.on("data", (chunk) => chunks.push(chunk.toString()))

      initLogger({ stream })
      log("class_payload", { credentials: new Credentials() })

      const parsed = JSON.parse(chunks.join("").trim())
      assert.deepEqual(parsed.credentials, {
        refreshToken: "REDACTED",
        Authorization: "Bearer REDACTED",
        nested: { access_token: "REDACTED" },
      })
      assert.equal(Object.getPrototypeOf(parsed.credentials), Object.prototype)

      const output = JSON.stringify(parsed)
      assert.ok(!output.includes("class-refresh-secret"))
      assert.ok(!output.includes("class-authorization-secret"))
      assert.ok(!output.includes("class-access-secret"))
    })

    it("does not execute custom toJSON methods while redacting", () => {
      let toJsonCalls = 0
      class Payload {
        value = "safe"
        toJSON() {
          toJsonCalls += 1
          return { refreshToken: "tojson-refresh-secret" }
        }
      }

      const stream = new PassThrough()
      const chunks: string[] = []
      stream.on("data", (chunk) => chunks.push(chunk.toString()))

      initLogger({ stream })
      log("custom_tojson", { payload: new Payload() })

      const parsed = JSON.parse(chunks.join("").trim())
      assert.equal(toJsonCalls, 0)
      assert.equal(parsed.payload.value, "safe")
      assert.equal(parsed.payload.toJSON, undefined)
      assert.ok(!JSON.stringify(parsed).includes("tojson-refresh-secret"))
    })

    it("does not execute throwing getters and still writes the log entry", () => {
      const payload: Record<string, unknown> = {
        refreshToken: "getter-refresh-secret",
      }
      Object.defineProperty(payload, "Authorization", {
        enumerable: true,
        get() {
          throw new Error("getter should not run")
        },
      })

      const stream = new PassThrough()
      const chunks: string[] = []
      stream.on("data", (chunk) => chunks.push(chunk.toString()))

      initLogger({ stream })
      assert.doesNotThrow(() => log("throwing_getter", { payload }))

      const parsed = JSON.parse(chunks.join("").trim())
      assert.equal(parsed.payload.refreshToken, "REDACTED")
      assert.equal(parsed.payload.Authorization, "[Accessor]")
      assert.ok(!JSON.stringify(parsed).includes("getter-refresh-secret"))
    })

    it("serializes BigInt values without throwing", () => {
      const stream = new PassThrough()
      const chunks: string[] = []
      stream.on("data", (chunk) => chunks.push(chunk.toString()))

      initLogger({ stream })
      assert.doesNotThrow(() => log("bigint_payload", { id: 123n }))

      const parsed = JSON.parse(chunks.join("").trim())
      assert.equal(parsed.id, "123")
    })

    it("handles cycles that include class instances without leaking secrets", () => {
      class Credentials {
        refreshToken = "cyclic-class-refresh-secret"
        parent?: Record<string, unknown>
      }

      const root: Record<string, unknown> = { status: 401 }
      const credentials = new Credentials()
      credentials.parent = root
      root.credentials = credentials

      const stream = new PassThrough()
      const chunks: string[] = []
      stream.on("data", (chunk) => chunks.push(chunk.toString()))

      initLogger({ stream })
      assert.doesNotThrow(() => log("cyclic_class_payload", root))

      const parsed = JSON.parse(chunks.join("").trim())
      assert.deepEqual(parsed.credentials, {
        refreshToken: "REDACTED",
        parent: "[Circular]",
      })
      assert.ok(!JSON.stringify(parsed).includes("cyclic-class-refresh-secret"))
    })

    it("marks proxy reflection failures as unserializable without throwing", () => {
      const proxy = new Proxy(
        {},
        {
          ownKeys() {
            throw new Error("reflection failed with proxy-refresh-secret")
          },
        },
      )
      const stream = new PassThrough()
      const chunks: string[] = []
      stream.on("data", (chunk) => chunks.push(chunk.toString()))

      initLogger({ stream })
      assert.doesNotThrow(() => log("proxy_payload", { proxy }))

      const parsed = JSON.parse(chunks.join("").trim())
      assert.equal(parsed.proxy, "[Unserializable]")
      assert.ok(!JSON.stringify(parsed).includes("proxy-refresh-secret"))
    })
  })

  describe("timestamp", () => {
    it("includes an ISO 8601 timestamp", () => {
      const logPath = join(tmpDir, "test.log")
      process.env.CLAUDE_AUTH_DEBUG = logPath
      initLogger()

      const before = new Date().toISOString()
      log("ts_test", {})
      const after = new Date().toISOString()

      const parsed = JSON.parse(readFileSync(logPath, "utf-8").trim())
      assert.ok(parsed.ts >= before, "Timestamp should be >= before")
      assert.ok(parsed.ts <= after, "Timestamp should be <= after")
    })
  })
})

describe("redact", () => {
  it("prefix-redacts accessToken", () => {
    const result = redact({
      accessToken: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.abc123",
    })
    assert.equal(result.accessToken, "eyJhbGci...REDACTED")
  })

  it("fully redacts refreshToken", () => {
    const result = redact({ refreshToken: "dGhpcyBpcyBhIHJlZnJlc2ggdG9rZW4" })
    assert.equal(result.refreshToken, "REDACTED")
  })

  it("redacts x-api-key", () => {
    const result = redact({ "x-api-key": "sk-ant-api03-abc123def456" })
    assert.equal(result["x-api-key"], "REDACTED")
  })

  it("catches JWT-pattern strings in arbitrary keys", () => {
    const result = redact({
      someToken: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature",
    })
    assert.equal(result.someToken, "JWT_REDACTED")
  })

  it("redacts token-like strings in error messages", () => {
    const result = redact({
      error:
        "failed with Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature and refresh_token=secret-refresh",
    })

    assert.equal(
      result.error,
      "failed with Bearer REDACTED and refresh_token=REDACTED",
    )
  })

  it("redacts generic opaque bearer tokens at logger level", () => {
    const result = redact({
      error: "failed with Bearer opaque-token_123-abc/def",
    })

    assert.equal(result.error, "failed with Bearer REDACTED")
  })

  it("preserves eyJ-prefixed strings that are not real JWTs", () => {
    const value = "eyJthis-looks-token-like-but-has-no-dot-segments"
    const result = redact({ value })

    assert.equal(result.value, value)
  })

  it("preserves context around JWTs in arbitrary strings", () => {
    const result = redact({
      message:
        "prefix eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature suffix",
    })

    assert.equal(result.message, "prefix JWT_REDACTED suffix")
  })

  it("fully redacts JWTs whose segments end with dash or underscore", () => {
    for (const jwt of [
      "eyJhbGciOiJSUzI1NiJ9.payload.segment-",
      "eyJhbGciOiJSUzI1NiJ9.payload.segment_",
    ]) {
      const result = redact({ message: `token=${jwt} done` })

      assert.equal(result.message, "token=JWT_REDACTED done")
      assert.ok(!String(result.message).includes(jwt))
      assert.ok(!String(result.message).includes("segment"))
    }
  })

  it("handles cyclic objects without leaking secrets", () => {
    const data: Record<string, unknown> = {
      status: 401,
      nested: { authorization: "Bearer cyclic-secret" },
    }
    data.self = data
    const nested = data.nested as Record<string, unknown>
    nested.parent = data

    const result = redact(data)

    assert.deepEqual(result, {
      status: 401,
      nested: {
        authorization: "Bearer REDACTED",
        parent: "[Circular]",
      },
      self: "[Circular]",
    })
    assert.ok(!JSON.stringify(result).includes("cyclic-secret"))
  })

  it("preserves non-sensitive fields", () => {
    const result = redact({
      expiresAt: 1742860800000,
      subscriptionType: "max",
      source: "Claude Code-credentials",
      modelId: "claude-opus-4-6",
    })
    assert.equal(result.expiresAt, 1742860800000)
    assert.equal(result.subscriptionType, "max")
    assert.equal(result.source, "Claude Code-credentials")
    assert.equal(result.modelId, "claude-opus-4-6")
  })

  it("handles short accessToken without crashing", () => {
    const result = redact({ accessToken: "short" })
    assert.equal(result.accessToken, "short...REDACTED")
  })

  it("handles empty string values", () => {
    const result = redact({ accessToken: "", refreshToken: "" })
    assert.equal(result.accessToken, "...REDACTED")
    assert.equal(result.refreshToken, "REDACTED")
  })

  it("passes through non-string values unchanged", () => {
    const result = redact({
      count: 42,
      success: true,
      items: ["a", "b"],
    })
    assert.equal(result.count, 42)
    assert.equal(result.success, true)
    assert.deepEqual(result.items, ["a", "b"])
  })
})
