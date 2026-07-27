import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { writeFileSync, mkdirSync, rmSync } from "node:fs"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  PRIMARY_SERVICE,
  buildAccountLabels,
  parseCredentials,
  updateCredentialBlob,
  writeBackCredentials,
} from "./keychain.ts"
import { chmodSync, statSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"

function readCredentialsFile(credPath: string): {
  accessToken: string
  refreshToken: string
  expiresAt: number
} | null {
  try {
    const raw = readFileSync(credPath, "utf-8")
    return parseCredentials(raw)
  } catch {
    return null
  }
}

describe("parseCredentials", () => {
  it("parses credentials with claudeAiOauth wrapper", () => {
    const raw = JSON.stringify({
      claudeAiOauth: {
        accessToken: "at-123",
        refreshToken: "rt-456",
        expiresAt: 1700000000000,
        scopes: ["user:inference"],
        subscriptionType: "pro",
        rateLimitTier: "default_claude_ai",
      },
    })
    const result = parseCredentials(raw)
    assert.ok(result)
    assert.equal(result.accessToken, "at-123")
    assert.equal(result.refreshToken, "rt-456")
    assert.equal(result.expiresAt, 1700000000000)
    assert.equal(result.subscriptionType, "pro")
  })

  it("parses credentials at root level", () => {
    const raw = JSON.stringify({
      accessToken: "at-789",
      refreshToken: "rt-012",
      expiresAt: 1700000000000,
    })
    const result = parseCredentials(raw)
    assert.ok(result)
    assert.equal(result.accessToken, "at-789")
    assert.equal(result.refreshToken, "rt-012")
    assert.equal(result.expiresAt, 1700000000000)
  })

  it("subscriptionType is undefined when not present", () => {
    const raw = JSON.stringify({
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: 1700000000000,
    })
    const result = parseCredentials(raw)
    assert.ok(result)
    assert.equal(result.subscriptionType, undefined)
  })

  it("truncates a fractional stored expiresAt", () => {
    const raw = JSON.stringify({
      claudeAiOauth: {
        accessToken: "at-123",
        refreshToken: "rt-456",
        expiresAt: 1784891051785.9011,
      },
    })

    const result = parseCredentials(raw)

    assert.ok(result)
    assert.equal(result.expiresAt, 1784891051785)
    assert.equal(Number.isInteger(result.expiresAt), true)
  })

  it("returns null for MCP-only entries", () => {
    const raw = JSON.stringify({
      mcpOAuth: {
        "neon|abc123": {
          serverName: "neon",
          accessToken: "some-token",
          expiresAt: 1700000000000,
        },
      },
    })
    assert.equal(parseCredentials(raw), null)
  })

  it("returns null for missing accessToken", () => {
    assert.equal(
      parseCredentials(JSON.stringify({ refreshToken: "rt", expiresAt: 123 })),
      null,
    )
  })

  it("returns null for missing refreshToken", () => {
    assert.equal(
      parseCredentials(JSON.stringify({ accessToken: "at", expiresAt: 123 })),
      null,
    )
  })

  it("returns null for missing expiresAt", () => {
    assert.equal(
      parseCredentials(
        JSON.stringify({ accessToken: "at", refreshToken: "rt" }),
      ),
      null,
    )
  })

  it("returns null for wrong types", () => {
    assert.equal(
      parseCredentials(
        JSON.stringify({
          accessToken: 123,
          refreshToken: "rt",
          expiresAt: 456,
        }),
      ),
      null,
    )
  })

  it("returns null for invalid JSON", () => {
    assert.equal(parseCredentials("not json {{{"), null)
  })

  it("returns null for empty string", () => {
    assert.equal(parseCredentials(""), null)
  })
})

describe("primary-only keychain policy", () => {
  it("exports the primary Claude Code service name", () => {
    assert.equal(PRIMARY_SERVICE, "Claude Code-credentials")
  })

  it("production code no longer scans suffixed Claude Code services", () => {
    const source = readFileSync(
      new URL("./keychain.ts", import.meta.url),
      "utf8",
    )
    assert.doesNotMatch(source, /dump-keychain/)
    assert.doesNotMatch(source, /Claude Code-credentials\(\?:-\[0-9a-f\]\+\)\?/)
    assert.doesNotMatch(source, /listClaudeKeychainServices/)
  })
})

const makeAccountCreds = (
  sub?: string,
): {
  accessToken: string
  refreshToken: string
  expiresAt: number
  subscriptionType?: string
} => ({
  accessToken: "at",
  refreshToken: "rt",
  expiresAt: 9999999999999,
  subscriptionType: sub,
})

describe("account labelling", () => {
  it("uses subscription type as label when available", () => {
    assert.equal(buildAccountLabels([makeAccountCreds("pro")])[0], "Claude Pro")
    assert.equal(buildAccountLabels([makeAccountCreds("max")])[0], "Claude Max")
    assert.equal(
      buildAccountLabels([makeAccountCreds("free")])[0],
      "Claude Free",
    )
  })

  it("capitalises the subscription tier", () => {
    assert.equal(buildAccountLabels([makeAccountCreds("pro")])[0], "Claude Pro")
  })

  it("falls back to 'Claude' when no subscription type", () => {
    assert.equal(buildAccountLabels([makeAccountCreds()])[0], "Claude")
  })

  it("deduplicates labels with counter when multiple accounts share a tier", () => {
    const labels = buildAccountLabels([
      makeAccountCreds("pro"),
      makeAccountCreds("pro"),
      makeAccountCreds("max"),
    ])
    assert.deepEqual(labels, ["Claude Pro 1", "Claude Pro 2", "Claude Max"])
  })

  it("keeps single account of each tier un-numbered", () => {
    assert.deepEqual(
      buildAccountLabels([makeAccountCreds("pro"), makeAccountCreds("max")]),
      ["Claude Pro", "Claude Max"],
    )
  })

  it("handles three accounts of the same tier", () => {
    assert.deepEqual(
      buildAccountLabels([
        makeAccountCreds("pro"),
        makeAccountCreds("pro"),
        makeAccountCreds("pro"),
      ]),
      ["Claude Pro 1", "Claude Pro 2", "Claude Pro 3"],
    )
  })

  it("handles mixed known and unknown subscription types", () => {
    assert.deepEqual(
      buildAccountLabels([
        makeAccountCreds(),
        makeAccountCreds("pro"),
        makeAccountCreds(),
      ]),
      ["Claude 1", "Claude Pro", "Claude 2"],
    )
  })
})

describe("credentials file fallback", () => {
  const tmpDir = join(tmpdir(), `claude-test-${process.pid}`)

  it("reads valid credentials from a JSON file", () => {
    mkdirSync(tmpDir, { recursive: true })
    const credPath = join(tmpDir, ".credentials.json")
    writeFileSync(
      credPath,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "file-at",
          refreshToken: "file-rt",
          expiresAt: 1700000000000,
        },
      }),
    )
    const result = readCredentialsFile(credPath)
    assert.deepEqual(result, {
      accessToken: "file-at",
      refreshToken: "file-rt",
      expiresAt: 1700000000000,
      subscriptionType: undefined,
    })
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("returns null when the file does not exist", () => {
    assert.equal(
      readCredentialsFile(join(tmpDir, "nonexistent", ".credentials.json")),
      null,
    )
  })

  it("returns null when the file contains invalid JSON", () => {
    mkdirSync(tmpDir, { recursive: true })
    const credPath = join(tmpDir, ".credentials.json")
    writeFileSync(credPath, "{ broken json")
    assert.equal(readCredentialsFile(credPath), null)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("returns null when the file is valid JSON but missing required fields", () => {
    mkdirSync(tmpDir, { recursive: true })
    const credPath = join(tmpDir, ".credentials.json")
    writeFileSync(
      credPath,
      JSON.stringify({ claudeAiOauth: { accessToken: "only-this" } }),
    )
    assert.equal(readCredentialsFile(credPath), null)
    rmSync(tmpDir, { recursive: true, force: true })
  })
})

describe("updateCredentialBlob", () => {
  it("updates tokens in claudeAiOauth wrapper format", () => {
    const existing = JSON.stringify({
      claudeAiOauth: {
        accessToken: "old-at",
        refreshToken: "old-rt",
        expiresAt: 1000,
        scopes: ["user:inference"],
        subscriptionType: "pro",
      },
    })
    const newCreds = {
      accessToken: "new-at",
      refreshToken: "new-rt",
      expiresAt: 2000,
    }
    const result = JSON.parse(updateCredentialBlob(existing, newCreds)!)
    assert.equal(result.claudeAiOauth.accessToken, "new-at")
    assert.equal(result.claudeAiOauth.refreshToken, "new-rt")
    assert.equal(result.claudeAiOauth.expiresAt, 2000)
    assert.deepEqual(result.claudeAiOauth.scopes, ["user:inference"])
    assert.equal(result.claudeAiOauth.subscriptionType, "pro")
  })

  it("updates tokens in root-level format", () => {
    const existing = JSON.stringify({
      accessToken: "old-at",
      refreshToken: "old-rt",
      expiresAt: 1000,
    })
    const newCreds = {
      accessToken: "new-at",
      refreshToken: "new-rt",
      expiresAt: 2000,
    }
    const result = JSON.parse(updateCredentialBlob(existing, newCreds)!)
    assert.equal(result.accessToken, "new-at")
    assert.equal(result.refreshToken, "new-rt")
    assert.equal(result.expiresAt, 2000)
  })

  it("preserves mcpOAuth and other unrelated fields", () => {
    const existing = JSON.stringify({
      claudeAiOauth: {
        accessToken: "old-at",
        refreshToken: "old-rt",
        expiresAt: 1000,
      },
      mcpOAuth: { "neon|abc": { serverName: "neon" } },
    })
    const newCreds = {
      accessToken: "new-at",
      refreshToken: "new-rt",
      expiresAt: 2000,
    }
    const result = JSON.parse(updateCredentialBlob(existing, newCreds)!)
    assert.ok(result.mcpOAuth)
    assert.equal(result.mcpOAuth["neon|abc"].serverName, "neon")
  })

  it("returns null for invalid JSON input", () => {
    assert.equal(
      updateCredentialBlob("not json", {
        accessToken: "a",
        refreshToken: "r",
        expiresAt: 1,
      }),
      null,
    )
  })
})

describe("writeBackCredentials (file source)", () => {
  it("reads, updates, and writes back credentials to file", async () => {
    const originalHome = process.env.HOME
    const tempHome = await mkdtemp(join(tmpdir(), "opencode-claude-auth-wb-"))
    process.env.HOME = tempHome

    try {
      const claudeDir = join(tempHome, ".claude")
      mkdirSync(claudeDir, { recursive: true })
      const credPath = join(claudeDir, ".credentials.json")
      writeFileSync(
        credPath,
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "old-at",
            refreshToken: "old-rt",
            expiresAt: 1000,
            subscriptionType: "pro",
          },
        }),
        { encoding: "utf-8", mode: 0o600 },
      )

      const result = writeBackCredentials("file", {
        accessToken: "new-at",
        refreshToken: "new-rt",
        expiresAt: 2000,
      })

      assert.equal(result, true)
      const written = JSON.parse(readFileSync(credPath, "utf-8"))
      assert.equal(written.claudeAiOauth.accessToken, "new-at")
      assert.equal(written.claudeAiOauth.refreshToken, "new-rt")
      assert.equal(written.claudeAiOauth.expiresAt, 2000)
      assert.equal(
        written.claudeAiOauth.subscriptionType,
        "pro",
        "should preserve other fields",
      )
    } finally {
      if (typeof originalHome === "string") {
        process.env.HOME = originalHome
      } else {
        delete process.env.HOME
      }
      rmSync(tempHome, { recursive: true, force: true })
    }
  })

  it("writes file with 0o600 permissions", async () => {
    if (process.platform === "win32") return

    const originalHome = process.env.HOME
    const tempHome = await mkdtemp(
      join(tmpdir(), "opencode-claude-auth-wb-perms-"),
    )
    process.env.HOME = tempHome

    try {
      const claudeDir = join(tempHome, ".claude")
      mkdirSync(claudeDir, { recursive: true })
      const credPath = join(claudeDir, ".credentials.json")
      writeFileSync(
        credPath,
        JSON.stringify({ accessToken: "at", refreshToken: "rt", expiresAt: 1 }),
        { encoding: "utf-8", mode: 0o644 },
      )
      chmodSync(credPath, 0o644)

      writeBackCredentials("file", {
        accessToken: "new-at",
        refreshToken: "new-rt",
        expiresAt: 2000,
      })

      const mode = statSync(credPath).mode & 0o777
      assert.equal(mode, 0o600, `Expected 0o600, got 0o${mode.toString(8)}`)
    } finally {
      if (typeof originalHome === "string") {
        process.env.HOME = originalHome
      } else {
        delete process.env.HOME
      }
      rmSync(tempHome, { recursive: true, force: true })
    }
  })

  it("returns false when credentials file does not exist", async () => {
    const originalHome = process.env.HOME
    const tempHome = await mkdtemp(
      join(tmpdir(), "opencode-claude-auth-wb-missing-"),
    )
    process.env.HOME = tempHome

    try {
      const result = writeBackCredentials("file", {
        accessToken: "at",
        refreshToken: "rt",
        expiresAt: 1000,
      })
      assert.equal(result, false)
    } finally {
      if (typeof originalHome === "string") {
        process.env.HOME = originalHome
      } else {
        delete process.env.HOME
      }
      rmSync(tempHome, { recursive: true, force: true })
    }
  })

  it("returns false when credentials file contains invalid JSON", async () => {
    const originalHome = process.env.HOME
    const tempHome = await mkdtemp(
      join(tmpdir(), "opencode-claude-auth-wb-invalid-"),
    )
    process.env.HOME = tempHome

    try {
      const claudeDir = join(tempHome, ".claude")
      mkdirSync(claudeDir, { recursive: true })
      writeFileSync(join(claudeDir, ".credentials.json"), "not json {")

      const result = writeBackCredentials("file", {
        accessToken: "at",
        refreshToken: "rt",
        expiresAt: 1000,
      })
      assert.equal(result, false)
    } finally {
      if (typeof originalHome === "string") {
        process.env.HOME = originalHome
      } else {
        delete process.env.HOME
      }
      rmSync(tempHome, { recursive: true, force: true })
    }
  })
})
