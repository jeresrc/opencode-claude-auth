import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { refreshViaOAuth, parseOAuthResponse } from "./credentials.ts"
import { createClaudeFetch } from "./claude-fetch.ts"
import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

type Creds = {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

async function loadCredentialsWithCountingKeychain(
  initialExpiresAt: number,
  options: { writeBackResult?: boolean; writeBackThrows?: boolean } = {},
): Promise<{
  credentialsModule: {
    getCachedCredentials: () => Creds | null
    getCredentialsForSync: () => Creds | null
    reloadPrimaryCredentials: () => Creds | null
    forceRefreshPrimaryCredentials: (
      refresh?: (refreshToken: string) => Creds | null,
    ) => Creds | null
    invalidateCredentialCache: () => void
    refreshIfNeeded: (
      account?: {
        label: string
        source: string
        credentials: Creds
      },
      options?: {
        force?: boolean
        reloadSource?: boolean
        refreshThresholdMs?: number
      },
    ) => Creds | null
    initAccounts: (accounts: unknown[]) => void
    PROACTIVE_REFRESH_INTERVAL_MS: number
    PROACTIVE_REFRESH_THRESHOLD_MS: number
    startProactiveRefresh: (options?: {
      setInterval?: typeof setInterval
      clearInterval?: typeof clearInterval
      now?: () => number
      refresh?: (refreshToken: string) => Creds | null
    }) => () => void
  }
  keychainModule: {
    __getReadCount: () => number
    __getWriteCount: () => number
    __setCredentials: (c: Creds) => void
  }
}> {
  const writeBackResult = options.writeBackResult ?? true
  const writeBackThrows = options.writeBackThrows ?? false
  const tempDir = await mkdtemp(join(tmpdir(), "opencode-claude-auth-creds-"))
  const tempKeychain = join(tempDir, "keychain.ts")
  const tempBetas = join(tempDir, "betas.ts")
  const tempLogger = join(tempDir, "logger.ts")
  const tempCredentials = join(tempDir, "credentials.ts")
  const sourceCredentials = await readFile(
    new URL("./credentials.ts", import.meta.url),
    "utf8",
  )
  const rewritten = sourceCredentials.replace(
    /from\s+["']\.\/(\w+)\.js["']/g,
    'from "./$1.ts"',
  )

  await writeFile(
    tempLogger,
    `export function log() {}\nexport function initLogger() {}\nexport function closeLogger() {}\n`,
    "utf8",
  )

  await writeFile(
    tempKeychain,
    `let readCount = 0
let writeCount = 0
let credentials = {
  accessToken: "token",
  refreshToken: "refresh",
  expiresAt: ${initialExpiresAt}
}

export function readAllClaudeAccounts() {
  readCount += 1
  return [{ label: "Account 1", source: "keychain", credentials }]
}

export function refreshAccount(source) {
  readCount += 1
  return credentials
}

export function writeBackCredentials() {
  writeCount += 1
  if (${writeBackThrows}) throw new Error("writeback failed")
  return ${writeBackResult}
}

export function __getReadCount() {
  return readCount
}

export function __getWriteCount() {
  return writeCount
}

export function __setCredentials(c) {
  credentials = c
}
`,
    "utf8",
  )

  await writeFile(
    tempBetas,
    `export function resetExcludedBetas() {}\n`,
    "utf8",
  )
  await writeFile(tempCredentials, rewritten, "utf8")

  const [credentialsModule, keychainModule] = await Promise.all([
    import(pathToFileURL(tempCredentials).href),
    import(pathToFileURL(tempKeychain).href),
  ])

  return {
    credentialsModule: credentialsModule as {
      getCachedCredentials: () => Creds | null
      getCredentialsForSync: () => Creds | null
      reloadPrimaryCredentials: () => Creds | null
      forceRefreshPrimaryCredentials: (
        refresh?: (refreshToken: string) => Creds | null,
      ) => Creds | null
      invalidateCredentialCache: () => void
      refreshIfNeeded: (
        account?: {
          label: string
          source: string
          credentials: Creds
        },
        options?: {
          force?: boolean
          reloadSource?: boolean
          refreshThresholdMs?: number
        },
      ) => Creds | null
      initAccounts: (accounts: unknown[]) => void
      PROACTIVE_REFRESH_INTERVAL_MS: number
      PROACTIVE_REFRESH_THRESHOLD_MS: number
      startProactiveRefresh: (options?: {
        setInterval?: typeof setInterval
        clearInterval?: typeof clearInterval
        now?: () => number
        refresh?: (refreshToken: string) => Creds | null
      }) => () => void
    },
    keychainModule: keychainModule as {
      __getReadCount: () => number
      __getWriteCount: () => number
      __setCredentials: (c: Creds) => void
    },
  }
}

describe("credential caching", () => {
  it("getCachedCredentials reuses cached credentials within 30 second TTL", async () => {
    const originalNow = Date.now
    const now = 1_700_000_000_000
    Date.now = () => now

    try {
      const { credentialsModule, keychainModule } =
        await loadCredentialsWithCountingKeychain(now + 10 * 60_000)

      credentialsModule.initAccounts([
        {
          label: "Account 1",
          source: "keychain",
          credentials: {
            accessToken: "token",
            refreshToken: "refresh",
            expiresAt: now + 10 * 60_000,
          },
        },
      ])

      const first = credentialsModule.getCachedCredentials()
      const second = credentialsModule.getCachedCredentials()

      assert.ok(first)
      assert.ok(second)
      assert.equal(keychainModule.__getReadCount(), 1)
    } finally {
      Date.now = originalNow
    }
  })

  it("getCachedCredentials refreshes from source after TTL expires", async () => {
    const originalNow = Date.now
    let now = 1_700_000_000_000
    Date.now = () => now

    try {
      const { credentialsModule, keychainModule } =
        await loadCredentialsWithCountingKeychain(now + 10 * 60_000)

      credentialsModule.initAccounts([
        {
          label: "Account 1",
          source: "keychain",
          credentials: {
            accessToken: "token",
            refreshToken: "refresh",
            expiresAt: now + 10 * 60_000,
          },
        },
      ])

      const first = credentialsModule.getCachedCredentials()
      assert.ok(first)

      keychainModule.__setCredentials({
        accessToken: "switched-token",
        refreshToken: "switched-refresh",
        expiresAt: now + 10 * 60_000,
      })
      now += 31_000

      const second = credentialsModule.getCachedCredentials()
      assert.ok(second)
      assert.equal(second.accessToken, "switched-token")
      assert.equal(keychainModule.__getReadCount(), 2)
    } finally {
      Date.now = originalNow
    }
  })

  it("refreshIfNeeded updates account credentials in-place after refresh", async () => {
    const originalNow = Date.now
    let now = 1_700_000_000_000
    Date.now = () => now

    try {
      // Keychain returns fresh creds with 10min expiry
      const { credentialsModule } = await loadCredentialsWithCountingKeychain(
        now + 10 * 60_000,
      )

      const account = {
        label: "Account 1",
        source: "keychain",
        credentials: {
          accessToken: "old-token",
          refreshToken: "old-refresh",
          expiresAt: now + 30_000, // expires in 30s, below 60s threshold
        },
      }

      credentialsModule.initAccounts([account])

      // First call should trigger refresh (token expiring within 60s)
      const result = credentialsModule.getCachedCredentials()
      assert.ok(result)

      // The account object's credentials should now be updated in-place
      assert.ok(
        account.credentials.expiresAt > now + 60_000,
        "account.credentials.expiresAt should be updated after refresh",
      )
    } finally {
      Date.now = originalNow
    }
  })

  it("getCachedCredentials returns null when no accounts are initialised", async () => {
    const { credentialsModule } = await loadCredentialsWithCountingKeychain(
      Date.now() + 10 * 60_000,
    )
    assert.equal(credentialsModule.getCachedCredentials(), null)
  })

  it("getCredentialsForSync returns cached credentials without triggering refresh", async () => {
    const originalNow = Date.now
    let now = 1_700_000_000_000
    Date.now = () => now

    try {
      const { credentialsModule, keychainModule } =
        await loadCredentialsWithCountingKeychain(now + 10 * 60_000)

      credentialsModule.initAccounts([
        {
          label: "Account 1",
          source: "keychain",
          credentials: {
            accessToken: "token",
            refreshToken: "refresh",
            expiresAt: now + 10 * 60_000,
          },
        },
      ])

      // Prime the cache
      credentialsModule.getCachedCredentials()

      // Advance time past cache TTL
      now += 31_000

      // getCredentialsForSync should return the account's current credentials
      // without triggering a keychain read (refresh)
      const readCountBefore = keychainModule.__getReadCount()
      const syncCreds = credentialsModule.getCredentialsForSync()
      const readCountAfter = keychainModule.__getReadCount()

      assert.ok(syncCreds)
      assert.equal(syncCreds.accessToken, "token")
      assert.equal(
        readCountAfter,
        readCountBefore,
        "should not trigger keychain read",
      )
    } finally {
      Date.now = originalNow
    }
  })

  it("refreshIfNeeded reloads externally changed credentials from any source", async () => {
    const originalNow = Date.now
    const now = 1_700_000_000_000
    Date.now = () => now

    try {
      const { credentialsModule, keychainModule } =
        await loadCredentialsWithCountingKeychain(now + 10 * 60_000)

      const account = {
        label: "Account 1",
        source: "keychain",
        credentials: {
          accessToken: "old-token",
          refreshToken: "old-refresh",
          expiresAt: now + 10 * 60_000,
        },
      }

      // External writers include `claude auth login` replacing a macOS
      // Keychain item while OpenCode is still running.
      keychainModule.__setCredentials({
        accessToken: "new-token",
        refreshToken: "new-refresh",
        expiresAt: now + 10 * 60_000,
      })

      const result = credentialsModule.refreshIfNeeded(account)

      assert.ok(result)
      assert.equal(
        result.accessToken,
        "new-token",
        "should return source creds, not the stale in-memory copy",
      )
      assert.equal(
        account.credentials.accessToken,
        "new-token",
        "account.credentials should be updated in place so future calls see the new tokens",
      )
    } finally {
      Date.now = originalNow
    }
  })

  it("refreshIfNeeded skips OAuth refresh writeback when the source is already fresh", async () => {
    const originalNow = Date.now
    const now = 1_700_000_000_000
    Date.now = () => now

    try {
      const { credentialsModule, keychainModule } =
        await loadCredentialsWithCountingKeychain(now + 10 * 60_000)

      // In-memory copy is expiring within the 60s threshold (would normally
      // trigger the OAuth-refresh + writeBackCredentials path).
      const account = {
        label: "Account 1",
        source: "keychain",
        credentials: {
          accessToken: "stale-token",
          refreshToken: "stale-refresh",
          expiresAt: now + 30_000,
        },
      }

      // External writer already replaced the file with fresh creds.
      keychainModule.__setCredentials({
        accessToken: "fresh-token",
        refreshToken: "fresh-refresh",
        expiresAt: now + 10 * 60_000,
      })

      const writeCountBefore = keychainModule.__getWriteCount()
      const result = credentialsModule.refreshIfNeeded(account)
      const writeCountAfter = keychainModule.__getWriteCount()

      assert.ok(result)
      assert.equal(result.accessToken, "fresh-token")
      assert.equal(
        writeCountAfter,
        writeCountBefore,
        "writeBackCredentials must not run when on-disk creds are already fresh; otherwise the stale in-memory refreshToken would be spliced into the new account's JSON blob",
      )
    } finally {
      Date.now = originalNow
    }
  })

  it("refreshIfNeeded can skip source reload when caller supplies current credentials", async () => {
    const originalNow = Date.now
    const now = 1_700_000_000_000
    Date.now = () => now

    try {
      const { credentialsModule, keychainModule } =
        await loadCredentialsWithCountingKeychain(now + 10 * 60_000)

      const account = {
        label: "Account 1",
        source: "keychain",
        credentials: {
          accessToken: "current-access",
          refreshToken: "current-refresh",
          expiresAt: now + 10 * 60_000,
        },
      }

      keychainModule.__setCredentials({
        accessToken: "stale-access",
        refreshToken: "stale-refresh",
        expiresAt: now + 10 * 60_000,
      })

      const result = credentialsModule.refreshIfNeeded(account, {
        reloadSource: false,
      })

      assert.ok(result)
      assert.equal(result.accessToken, "current-access")
      assert.equal(result.refreshToken, "current-refresh")
      assert.equal(keychainModule.__getReadCount(), 0)
    } finally {
      Date.now = originalNow
    }
  })

  it("startProactiveRefresh refreshes at startup when primary credentials expire within one hour", async () => {
    const originalNow = Date.now
    const now = 1_700_000_000_000
    Date.now = () => now

    try {
      const { credentialsModule, keychainModule } =
        await loadCredentialsWithCountingKeychain(now + 30 * 60_000)
      const account = {
        label: "Claude",
        source: "Claude Code-credentials",
        credentials: {
          accessToken: "old-token",
          refreshToken: "refresh-token",
          expiresAt: now + 30 * 60_000,
        },
      }
      credentialsModule.initAccounts([account])
      const intervals: number[] = []
      const callbacks: Array<() => void> = []
      const refreshed = {
        accessToken: "new-token",
        refreshToken: "new-refresh",
        expiresAt: now + 10 * 60 * 60_000,
      }

      const cleanup = credentialsModule.startProactiveRefresh({
        setInterval: ((callback: () => void, interval: number) => {
          callbacks.push(callback)
          intervals.push(interval)
          return 123 as never
        }) as typeof setInterval,
        clearInterval: (() => undefined) as typeof clearInterval,
        now: () => now,
        refresh: () => refreshed,
      })

      const current = credentialsModule.getCredentialsForSync()
      assert.ok(current)
      assert.equal(current.accessToken, "new-token")
      assert.equal(keychainModule.__getWriteCount(), 1)
      assert.deepEqual(intervals, [
        credentialsModule.PROACTIVE_REFRESH_INTERVAL_MS,
      ])
      assert.equal(callbacks.length, 1)
      cleanup()
    } finally {
      Date.now = originalNow
    }
  })

  it("startProactiveRefresh skips fresh credentials and cleanup clears the timer", async () => {
    const originalNow = Date.now
    const now = 1_700_000_000_000
    Date.now = () => now

    try {
      const { credentialsModule, keychainModule } =
        await loadCredentialsWithCountingKeychain(now + 2 * 60 * 60_000)
      credentialsModule.initAccounts([
        {
          label: "Claude",
          source: "Claude Code-credentials",
          credentials: {
            accessToken: "fresh-token",
            refreshToken: "refresh-token",
            expiresAt: now + 2 * 60 * 60_000,
          },
        },
      ])
      const cleared: unknown[] = []
      const cleanup = credentialsModule.startProactiveRefresh({
        setInterval: ((callback: () => void) => {
          callback()
          return "timer-id" as never
        }) as typeof setInterval,
        clearInterval: ((timer: unknown) => {
          cleared.push(timer)
        }) as typeof clearInterval,
        now: () => now,
        refresh: () => {
          throw new Error("fresh credentials must not refresh")
        },
      })

      assert.equal(keychainModule.__getWriteCount(), 0)
      cleanup()
      cleanup()
      assert.deepEqual(cleared, ["timer-id"])
    } finally {
      Date.now = originalNow
    }
  })

  it("startProactiveRefresh seeds the primary account when startup reconciliation only read keychain", async () => {
    const originalNow = Date.now
    const now = 1_700_000_000_000
    Date.now = () => now

    try {
      const { credentialsModule, keychainModule } =
        await loadCredentialsWithCountingKeychain(now + 30 * 60_000)
      const refreshed = {
        accessToken: "new-token",
        refreshToken: "new-refresh",
        expiresAt: now + 10 * 60 * 60_000,
      }

      const cleanup = credentialsModule.startProactiveRefresh({
        setInterval: (() => "timer-id" as never) as typeof setInterval,
        clearInterval: (() => undefined) as typeof clearInterval,
        now: () => now,
        refresh: () => refreshed,
      })

      const current = credentialsModule.getCredentialsForSync()
      assert.ok(current)
      assert.equal(current.accessToken, "new-token")
      assert.equal(keychainModule.__getReadCount(), 1)
      assert.equal(keychainModule.__getWriteCount(), 1)
      cleanup()
    } finally {
      Date.now = originalNow
    }
  })

  it("startProactiveRefresh reloads the primary source before using a hot module cache", async () => {
    const originalNow = Date.now
    const now = 1_700_000_000_000
    Date.now = () => now

    try {
      const { credentialsModule, keychainModule } =
        await loadCredentialsWithCountingKeychain(now + 2 * 60 * 60_000)
      keychainModule.__setCredentials({
        accessToken: "old-fresh-token",
        refreshToken: "old-refresh-token",
        expiresAt: now + 2 * 60 * 60_000,
      })
      credentialsModule.initAccounts([
        {
          label: "Claude",
          source: "keychain",
          credentials: {
            accessToken: "old-fresh-token",
            refreshToken: "old-refresh-token",
            expiresAt: now + 2 * 60 * 60_000,
          },
        },
      ])

      const cached = credentialsModule.getCachedCredentials()
      assert.ok(cached)
      assert.equal(cached.accessToken, "old-fresh-token")

      keychainModule.__setCredentials({
        accessToken: "new-near-expiry-token",
        refreshToken: "new-refresh-token",
        expiresAt: now + 30 * 60_000,
      })
      const refreshed = {
        accessToken: "refreshed-token",
        refreshToken: "refreshed-refresh-token",
        expiresAt: now + 10 * 60 * 60_000,
      }
      const refreshTokens: string[] = []

      const cleanup = credentialsModule.startProactiveRefresh({
        setInterval: (() => "timer-id" as never) as typeof setInterval,
        clearInterval: (() => undefined) as typeof clearInterval,
        now: () => now,
        refresh: (refreshToken: string) => {
          refreshTokens.push(refreshToken)
          return refreshed
        },
      })

      const current = credentialsModule.getCredentialsForSync()
      assert.ok(current)
      assert.equal(current.accessToken, "refreshed-token")
      assert.deepEqual(refreshTokens, ["new-refresh-token"])
      assert.equal(keychainModule.__getWriteCount(), 1)
      cleanup()
    } finally {
      Date.now = originalNow
    }
  })

  it("reloadPrimaryCredentials picks up externally rotated primary credentials", async () => {
    const now = Date.now()
    const { credentialsModule, keychainModule } =
      await loadCredentialsWithCountingKeychain(now + 10 * 60_000)
    const account = {
      label: "Claude",
      source: "Claude Code-credentials",
      credentials: {
        accessToken: "old-token",
        refreshToken: "old-refresh",
        expiresAt: now + 10 * 60_000,
      },
    }
    credentialsModule.initAccounts([account])

    keychainModule.__setCredentials({
      accessToken: "rotated-token",
      refreshToken: "rotated-refresh",
      expiresAt: now + 10 * 60_000,
    })

    const result = credentialsModule.reloadPrimaryCredentials()

    assert.ok(result)
    assert.equal(result.accessToken, "rotated-token")
    assert.equal(account.credentials.accessToken, "rotated-token")
  })

  it("forceRefreshPrimaryCredentials writes back and primes the cache", async () => {
    const originalNow = Date.now
    const now = 1_700_000_000_000
    Date.now = () => now

    try {
      const { credentialsModule, keychainModule } =
        await loadCredentialsWithCountingKeychain(now + 10 * 60_000)
      const account = {
        label: "Claude",
        source: "Claude Code-credentials",
        credentials: {
          accessToken: "rejected-token",
          refreshToken: "refresh-token",
          expiresAt: now + 10 * 60_000,
        },
      }
      credentialsModule.initAccounts([account])
      const newCreds = {
        accessToken: "oauth-refreshed-token",
        refreshToken: "oauth-refreshed-refresh",
        expiresAt: now + 10 * 60 * 60_000,
      }

      const result = credentialsModule.forceRefreshPrimaryCredentials(
        (token) => {
          assert.equal(token, "refresh-token")
          return newCreds
        },
      )

      assert.ok(result)
      assert.equal(result.accessToken, "oauth-refreshed-token")
      assert.equal(account.credentials.accessToken, "oauth-refreshed-token")
      assert.equal(keychainModule.__getWriteCount(), 1)
      assert.equal(
        credentialsModule.getCachedCredentials()?.accessToken,
        "oauth-refreshed-token",
      )
    } finally {
      Date.now = originalNow
    }
  })

  it("does not retry 401 recovery or update cache when forced refresh writeback fails", async () => {
    const originalNow = Date.now
    const now = 1_700_000_000_000
    Date.now = () => now

    try {
      const { credentialsModule, keychainModule } =
        await loadCredentialsWithCountingKeychain(now + 10 * 60_000, {
          writeBackResult: false,
        })
      const oldCreds = {
        accessToken: "old-token",
        refreshToken: "old-refresh",
        expiresAt: now + 10 * 60_000,
      }
      const newCreds = {
        accessToken: "oauth-refreshed-token",
        refreshToken: "oauth-refreshed-refresh",
        expiresAt: now + 10 * 60 * 60_000,
      }
      keychainModule.__setCredentials(oldCreds)
      const account = {
        label: "Claude",
        source: "Claude Code-credentials",
        credentials: { ...oldCreds },
      }
      credentialsModule.initAccounts([account])
      assert.equal(
        credentialsModule.getCachedCredentials()?.accessToken,
        "old-token",
      )

      let calls = 0
      const upstream = (async () => {
        calls += 1
        return new Response(calls === 1 ? "unauthorized" : "should not retry", {
          status: calls === 1 ? 401 : 200,
        })
      }) as typeof fetch
      const claudeFetch = createClaudeFetch({
        accessToken: "old-token",
        upstream,
        retries: 3,
        sleep: async () => {},
        authRecovery: {
          reload: () => credentialsModule.reloadPrimaryCredentials(),
          refresh: () =>
            credentialsModule.forceRefreshPrimaryCredentials((refreshToken) => {
              assert.equal(refreshToken, "old-refresh")
              return newCreds
            }),
        },
      })

      const response = await claudeFetch(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
        },
      )

      assert.equal(response.status, 401)
      assert.equal(await response.text(), "unauthorized")
      assert.equal(calls, 1)
      assert.equal(keychainModule.__getWriteCount(), 1)
      assert.equal(account.credentials.accessToken, "old-token")
      assert.equal(
        credentialsModule.getCachedCredentials()?.accessToken,
        "old-token",
      )
    } finally {
      Date.now = originalNow
    }
  })
})

describe("syncAuthJson file permissions", () => {
  it("writes auth.json with mode 0o600", async () => {
    if (process.platform === "win32") return // Windows doesn't support Unix permissions

    const originalHome = process.env.HOME
    const tempHome = await mkdtemp(
      join(tmpdir(), "opencode-claude-auth-perms-"),
    )
    process.env.HOME = tempHome

    try {
      const tempDir = await mkdtemp(
        join(tmpdir(), "opencode-claude-auth-sync-"),
      )
      const tempCredentials = join(tempDir, "credentials.ts")
      const tempKeychain = join(tempDir, "keychain.ts")
      const tempBetas = join(tempDir, "betas.ts")
      const tempLogger = join(tempDir, "logger.ts")
      const sourceCredentials = await readFile(
        new URL("./credentials.ts", import.meta.url),
        "utf8",
      )
      const rewritten = sourceCredentials.replace(
        /from\s+["']\.\/(\w+)\.js["']/g,
        'from "./$1.ts"',
      )

      await writeFile(
        tempKeychain,
        `export function readAllClaudeAccounts() { return [] }
export function refreshAccount() { return null }
export function writeBackCredentials() { return true }
export function buildAccountLabels(creds) { return creds.map((_, i) => \`Account \${i + 1}\`) }`,
        "utf8",
      )
      await writeFile(
        tempBetas,
        `export function resetExcludedBetas() {}\n`,
        "utf8",
      )
      await writeFile(
        tempLogger,
        `export function log() {}\nexport function initLogger() {}\nexport function closeLogger() {}\n`,
        "utf8",
      )
      await writeFile(tempCredentials, rewritten, "utf8")

      const mod = await import(pathToFileURL(tempCredentials).href)
      mod.syncAuthJson({
        accessToken: "tok",
        refreshToken: "ref",
        expiresAt: Date.now() + 600_000,
      })

      const authPath = join(
        tempHome,
        ".local",
        "share",
        "opencode",
        "auth.json",
      )
      const stats = statSync(authPath)
      const mode = stats.mode & 0o777
      assert.equal(
        mode,
        0o600,
        `Expected file mode 0o600, got 0o${mode.toString(8)}`,
      )
    } finally {
      if (typeof originalHome === "string") {
        process.env.HOME = originalHome
      } else {
        delete process.env.HOME
      }
    }
  })

  it("tightens permissions on pre-existing auth.json from 0o644 to 0o600", async () => {
    if (process.platform === "win32") return

    const originalHome = process.env.HOME
    const tempHome = await mkdtemp(
      join(tmpdir(), "opencode-claude-auth-perms2-"),
    )
    process.env.HOME = tempHome

    try {
      // Create auth.json with permissive mode first
      const authDir = join(tempHome, ".local", "share", "opencode")
      mkdirSync(authDir, { recursive: true })
      const authPath = join(authDir, "auth.json")
      writeFileSync(authPath, "{}", { encoding: "utf-8", mode: 0o644 })
      chmodSync(authPath, 0o644) // Ensure 0o644 regardless of umask

      // Now call syncAuthJson which should tighten permissions
      const tempDir = await mkdtemp(
        join(tmpdir(), "opencode-claude-auth-sync2-"),
      )
      const tempCredentials = join(tempDir, "credentials.ts")
      const tempKeychain = join(tempDir, "keychain.ts")
      const tempBetas = join(tempDir, "betas.ts")
      const tempLogger = join(tempDir, "logger.ts")
      const sourceCredentials = await readFile(
        new URL("./credentials.ts", import.meta.url),
        "utf8",
      )
      const rewritten = sourceCredentials.replace(
        /from\s+["']\.\/(\w+)\.js["']/g,
        'from "./$1.ts"',
      )

      await writeFile(
        tempKeychain,
        `export function readAllClaudeAccounts() { return [] }
export function refreshAccount() { return null }
export function writeBackCredentials() { return true }
export function buildAccountLabels(creds) { return creds.map((_, i) => \`Account \${i + 1}\`) }`,
        "utf8",
      )
      await writeFile(
        tempBetas,
        `export function resetExcludedBetas() {}\n`,
        "utf8",
      )
      await writeFile(
        tempLogger,
        `export function log() {}\nexport function initLogger() {}\nexport function closeLogger() {}\n`,
        "utf8",
      )
      await writeFile(tempCredentials, rewritten, "utf8")

      const mod = await import(pathToFileURL(tempCredentials).href)
      mod.syncAuthJson({
        accessToken: "tok",
        refreshToken: "ref",
        expiresAt: Date.now() + 600_000,
      })

      const stats = statSync(authPath)
      const mode = stats.mode & 0o777
      assert.equal(
        mode,
        0o600,
        `Expected tightened mode 0o600, got 0o${mode.toString(8)}`,
      )
    } finally {
      if (typeof originalHome === "string") {
        process.env.HOME = originalHome
      } else {
        delete process.env.HOME
      }
    }
  })
})

describe("refreshViaOAuth", () => {
  it("is exported as a function", () => {
    assert.equal(typeof refreshViaOAuth, "function")
  })
})

describe("parseOAuthResponse", () => {
  const now = 1_700_000_000_000
  const currentRefresh = "sk-ant-ort01-current"

  it("parses a valid OAuth response with all fields", () => {
    const raw = JSON.stringify({
      access_token: "sk-ant-oat01-new",
      refresh_token: "sk-ant-ort01-new",
      expires_in: 28800,
      token_type: "Bearer",
    })
    const result = parseOAuthResponse(raw, currentRefresh, now)
    assert.ok(result)
    assert.equal(result.accessToken, "sk-ant-oat01-new")
    assert.equal(result.refreshToken, "sk-ant-ort01-new")
    assert.equal(result.expiresAt, now + 28800 * 1000)
  })

  it("returns null when access_token is missing", () => {
    const raw = JSON.stringify({ refresh_token: "rt", expires_in: 3600 })
    assert.equal(parseOAuthResponse(raw, currentRefresh, now), null)
  })

  it("returns null for an error response", () => {
    const raw = JSON.stringify({ error: "invalid_grant" })
    assert.equal(parseOAuthResponse(raw, currentRefresh, now), null)
  })

  it("falls back to current refresh token when response omits it", () => {
    const raw = JSON.stringify({
      access_token: "sk-ant-oat01-new",
      expires_in: 3600,
    })
    const result = parseOAuthResponse(raw, currentRefresh, now)
    assert.ok(result)
    assert.equal(result.refreshToken, currentRefresh)
  })

  it("defaults expires_in to 36000s (10h) when missing", () => {
    const raw = JSON.stringify({ access_token: "sk-ant-oat01-new" })
    const result = parseOAuthResponse(raw, currentRefresh, now)
    assert.ok(result)
    assert.equal(result.expiresAt, now + 36_000 * 1000)
  })

  it("truncates fractional expires_in to integer milliseconds", () => {
    const expiresIn = 28_800.000_901_1
    const raw = JSON.stringify({
      access_token: "sk-ant-oat01-new",
      expires_in: expiresIn,
    })

    const result = parseOAuthResponse(raw, currentRefresh, now)

    assert.ok(result)
    assert.equal(result.expiresAt, Math.trunc(now + expiresIn * 1000))
    assert.equal(Number.isInteger(result.expiresAt), true)
  })

  it("returns null for invalid JSON", () => {
    assert.equal(parseOAuthResponse("not json {", currentRefresh, now), null)
  })

  it("returns null for empty string", () => {
    assert.equal(parseOAuthResponse("", currentRefresh, now), null)
  })
})
