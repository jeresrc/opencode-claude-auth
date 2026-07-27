# Primary Auth Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Claude OAuth resilient for the single primary Claude account through startup/proactive refresh, bounded 401 recovery, and sanitized failures.

**Architecture:** Collapse credential discovery and Integration prompts to the primary Keychain service or default credential file, then add proactive refresh and request-scoped 401 recovery through existing credential source reload/writeback paths. Keep retry state local to a single fetch call, use fake timers/fetch/credentials in tests, and reserve the live Opus smoke test for the final gate.

**Tech Stack:** TypeScript ESM, Node test runner with `--experimental-strip-types`, pnpm 10.32.1, Effect 4, macOS Keychain command wrappers, default `~/.claude/.credentials.json`, provider-local `createClaudeFetch`.

## Global Constraints

- This plan depends on `docs/superpowers/plans/2026-07-26-v2-provider-compat-stream-plan.md` and `docs/superpowers/plans/2026-07-26-upstream-safe-ports-plan.md` being complete and passing.
- Pin `@opencode-ai/ai` to `1.17.20` and `@opencode-ai/plugin` to `1.18.3`.
- Preserve the current V2 architecture: `Plugin.define`, Integration V2, catalog transform, and native provider registration.
- Do not wholesale merge `origin/main` or port the legacy upstream `src/index.ts` architecture.
- Do not mutate Integration state except through existing sync/writeback paths.
- Treat the primary Keychain service and existing default credential file as the only credential sources.
- Do not support multiple Claude accounts.
- Do not support suffixed account names or account-specific credential files.
- Do not support `CLAUDE_CONFIG_DIR`, even though upstream includes related behavior.
- On startup, load primary credentials through the existing sync path.
- Start a proactive refresh timer that runs every 5 minutes.
- Refresh proactively when the active credential expires in less than 1 hour.
- On plugin unload/cleanup, cancel the proactive refresh timer.
- On a 401 from Claude, reload the primary credential source.
- If the token changed externally, retry the request once with the reloaded token.
- If the token did not change and refresh is possible, refresh, persist through existing writeback, and retry once.
- Never perform more than one retry for a single request.
- Proactive refresh failure: log a sanitized message with no tokens, secrets, or raw response body and continue with the current credential.
- 401 reload/refresh failure: return the original or equivalent 401 error to OpenCode and do not surface raw Claude response bodies in the TUI.
- Second 401 after retry: stop immediately and return the 401.
- Missing stream finish reason: use `"unknown"` only when the reason is absent or `undefined`.
- Preserve valid stream finish reasons unchanged.

---

## Dependency And Plan Order

This is the third implementation plan. It must run after the provider compatibility plan because it extends `createClaudeFetch` and provider settings, and after the upstream-safe ports plan because it relies on sanitized API error handling and current model/beta behavior.

## File Map

- Modify `src/keychain.ts`: export `PRIMARY_SERVICE`, read only `Claude Code-credentials` on Darwin, fall back to the default file source, remove suffixed service discovery from production code, and keep `writeBackCredentials(source, creds): boolean` for `PRIMARY_SERVICE` and `file`.
- Modify `src/keychain.test.ts`: replace suffixed-service expectations with primary-only tests and keep file fallback tests.
- Modify `src/integration.ts`: register one `claude-code` OAuth method with no account-selection prompts and authorize the primary account only.
- Modify `src/integration.test.ts`: remove multi-account prompt expectations and assert primary-only authorization/refresh metadata.
- Modify `src/credentials.ts`: keep `initAccounts`, `refreshAccountsList`, `refreshIfNeeded`, `getCachedCredentials`, and `getCredentialsForSync`; add `reloadPrimaryCredentials`, `forceRefreshPrimaryCredentials`, `startProactiveRefresh`, a 1-hour proactive threshold, and cache invalidation without adding multi-account routing.
- Modify `src/credentials.test.ts`: use fake credentials/keychain modules, fake timers, and fake refresh functions to test proactive refresh, cleanup, source reload, and forced writeback.
- Modify `src/claude-fetch.ts`: add request-scoped `authRecovery` hooks to `ClaudeFetchOptions`, retry exactly once on 401 for replayable requests, and keep response transformation/sanitized logging.
- Modify `src/claude-fetch.test.ts`: use fake fetch and fake auth recovery hooks for external rotation, refresh fallback, second-401 stop, non-replayable no-retry, and sanitized-output checks.
- Modify `src/provider.ts`: pass primary auth recovery hooks into `createClaudeFetch` while keeping `settings.metadata` out of HTTP/provider options.
- Modify `src/provider.test.ts`: extend fake-fetch coverage so provider-level 401 recovery uses the new hooks without forwarding source metadata.
- Modify `src/index.ts`: start proactive refresh during setup after connected credential reconciliation and compose cleanup with the existing rate-limit listener cleanup.
- Modify `src/index.test.ts`: assert setup starts proactive refresh and cleanup cancels both proactive refresh and rate-limit listener.

## Task 1: Enforce Primary-Only Credential Sources

**Files:**
- Modify: `src/keychain.ts`
- Modify: `src/keychain.test.ts`
- Modify: `src/integration.ts`
- Modify: `src/integration.test.ts`

**Interfaces:**
- Consumes: `readAllClaudeAccounts(): ClaudeAccount[]`, `refreshAccount(source: string): ClaudeCredentials | null`, `writeBackCredentials(source: string, creds: ClaudeCredentials): boolean`, and `registerAnthropicIntegration(draft, deps?)`.
- Produces: `PRIMARY_SERVICE = "Claude Code-credentials"`, primary-only `readAllClaudeAccounts()`, and Integration authorization with no account-selection prompt.

- [ ] **Step 1: Write failing primary-only Keychain tests**

In `src/keychain.test.ts`, replace the `keychain service discovery` describe block with primary-only assertions against source text:

```ts
describe("primary-only keychain policy", () => {
  it("exports the primary Claude Code service name", () => {
    assert.equal(PRIMARY_SERVICE, "Claude Code-credentials")
  })

  it("production code no longer scans suffixed Claude Code services", () => {
    const source = readFileSync(new URL("./keychain.ts", import.meta.url), "utf8")
    assert.doesNotMatch(source, /dump-keychain/)
    assert.doesNotMatch(source, /Claude Code-credentials\(\?:-\[0-9a-f\]\+\)\?/)
    assert.doesNotMatch(source, /listClaudeKeychainServices/)
  })
})
```

Update the `src/keychain.test.ts` import to include `PRIMARY_SERVICE`:

```ts
import {
  PRIMARY_SERVICE,
  buildAccountLabels,
  parseCredentials,
  updateCredentialBlob,
  writeBackCredentials,
} from "./keychain.ts"
```

- [ ] **Step 2: Write failing primary-only Integration tests**

In `src/integration.test.ts`, replace the prompt test with:

```ts
  it("registers a primary-only Claude Code OAuth method with no account prompt", () => {
    const { draft, integration, registration } = createDraft()

    registerAnthropicIntegration(draft, {
      readAccounts: () => [account("Claude Code-credentials", "Claude Pro")],
      refreshIfNeeded: () => null,
    })

    assert.equal(integration.name, "Anthropic")
    assert.equal(registration().integrationID, "anthropic")
    assert.deepEqual(registration().method, {
      id: CLAUDE_CODE_METHOD_ID,
      type: "oauth",
      label: "Claude Code credentials",
    })
  })
```

Replace the invalid-selection test with:

```ts
  it("authorizes the primary account only and ignores account-selection inputs", async () => {
    const { draft, registration } = createDraft()
    let reads = 0
    const primary = account("Claude Code-credentials", "Claude Pro")

    registerAnthropicIntegration(draft, {
      readAccounts: () => {
        reads += 1
        return [primary]
      },
      refreshIfNeeded: () => null,
    })

    const authorization = await Effect.runPromise(
      registration().authorize({ source: "Claude Code-credentials-deadbeef" }),
    )

    assert.equal(authorization.mode, "auto")
    assert.deepEqual(await Effect.runPromise(authorization.callback), {
      type: "oauth",
      methodID: CLAUDE_CODE_METHOD_ID,
      access: "access-Claude Code-credentials",
      refresh: "refresh-Claude Code-credentials",
      expires: 1_700_000_000_000,
      metadata: { source: "Claude Code-credentials" },
    })
    assert.equal(reads, 2)
  })
```

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
node --test --experimental-strip-types src/keychain.test.ts src/integration.test.ts
```

Expected: FAIL because production still scans suffixed Keychain services and Integration still creates prompts when multiple accounts are discovered.

- [ ] **Step 4: Make Keychain credential discovery primary-only**

In `src/keychain.ts`, export the primary service constant:

```ts
export const PRIMARY_SERVICE = "Claude Code-credentials"
```

Delete the `listClaudeKeychainServices()` function. Replace `readAllClaudeAccounts()` with:

```ts
export function readAllClaudeAccounts(): ClaudeAccount[] {
  if (process.platform !== "darwin") {
    const creds = readCredentialsFile()
    if (!creds) return []
    const [label] = buildAccountLabels([creds])
    return [{ label, source: "file", credentials: creds }]
  }

  const raw = readKeychainService(PRIMARY_SERVICE)
  if (raw) {
    const creds = parseCredentials(raw)
    if (creds) {
      const [label] = buildAccountLabels([creds])
      return [{ label, source: PRIMARY_SERVICE, credentials: creds }]
    }
  }

  const creds = readCredentialsFile()
  if (!creds) return []
  const [label] = buildAccountLabels([creds])
  return [{ label, source: "file", credentials: creds }]
}
```

Keep `refreshAccount(source)` unchanged except that production callers will now pass only `PRIMARY_SERVICE` or `file`.

- [ ] **Step 5: Remove Integration account-selection prompts**

In `src/integration.ts`, delete the `prompts` construction and replace the `method` object in `registerAnthropicIntegration` with:

```ts
    method: {
      id: CLAUDE_CODE_METHOD_ID,
      type: "oauth" as const,
      label: "Claude Code credentials",
    },
```

Replace `selectAccount` with a primary-only selector:

```ts
function selectPrimaryAccount(accounts: readonly ClaudeAccount[]): ClaudeAccount {
  const primary = accounts[0]
  if (!primary) throw new Error("No Claude Code accounts found")
  return primary
}
```

In `authorize`, replace the `selectAccount(...)` call with:

```ts
          const account = selectPrimaryAccount(resolvedDeps.readAccounts())
```

In `refresh`, keep `sourceFromMetadata(credential)` and find the matching account by source. This preserves existing sync/writeback identity without introducing account selection.

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
node --test --experimental-strip-types src/keychain.test.ts src/integration.test.ts
pnpm run typecheck
```

Expected: PASS for focused tests and typecheck.

- [ ] **Step 7: Commit the primary-only source policy**

```bash
git add src/keychain.ts src/keychain.test.ts src/integration.ts src/integration.test.ts
git commit -m "fix: use primary Claude credentials only"
```

## Task 2: Add Startup And Proactive Refresh With Cleanup

**Files:**
- Modify: `src/credentials.ts`
- Modify: `src/credentials.test.ts`
- Modify: `src/index.ts`
- Modify: `src/index.test.ts`

**Interfaces:**
- Consumes: primary-only `readAllClaudeAccounts()`, `refreshAccount(source)`, `refreshIfNeeded(account, options)`, `writeBackCredentials(source, creds)`, and plugin setup cleanup from Plan 1.
- Produces: `PROACTIVE_REFRESH_INTERVAL_MS`, `PROACTIVE_REFRESH_THRESHOLD_MS`, `startProactiveRefresh(options?): () => void`, and plugin setup cleanup that cancels proactive refresh and rate-limit listener cleanup.

- [ ] **Step 1: Write failing proactive refresh tests**

Extend the temporary module type in `src/credentials.test.ts` helper `loadCredentialsWithCountingKeychain` so `credentialsModule` includes:

```ts
    PROACTIVE_REFRESH_INTERVAL_MS: number
    PROACTIVE_REFRESH_THRESHOLD_MS: number
    startProactiveRefresh: (options?: {
      setInterval?: typeof setInterval
      clearInterval?: typeof clearInterval
      now?: () => number
      refresh?: (refreshToken: string) => Creds | null
    }) => () => void
```

Append these tests inside `describe("credential caching", () => { ... })`:

```ts
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

      assert.equal(account.credentials.accessToken, "new-token")
      assert.equal(keychainModule.__getWriteCount(), 1)
      assert.deepEqual(intervals, [credentialsModule.PROACTIVE_REFRESH_INTERVAL_MS])
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
```

- [ ] **Step 2: Write failing plugin setup cleanup test**

In `src/index.test.ts`, extend the setup order test so it observes proactive refresh through fake global timers. Add this setup before calling `plugin.setup(context)`:

```ts
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  const proactiveTimer = { unref: () => order.push("proactive:unref") }
  let clearedTimer: unknown

  globalThis.setInterval = ((callback: () => void, intervalMs: number) => {
    order.push(`proactive:setInterval:${intervalMs}`)
    assert.equal(typeof callback, "function")
    return proactiveTimer as never
  }) as typeof setInterval
  globalThis.clearInterval = ((timer: unknown) => {
    order.push("proactive:clearInterval")
    clearedTimer = timer
  }) as typeof clearInterval
```

Wrap the setup call in `try/finally` so the globals are restored, and update the assertions to:

```ts
  try {
    const cleanup = await plugin.setup(context)

    assert.deepEqual(order, [
      "integration",
      "integration:active",
      "proactive:setInterval:300000",
      "proactive:unref",
      "catalog",
      "session:context",
      "event:subscribe",
    ])
    assert.equal(typeof cleanup, "function")

    await cleanup?.()
    assert.equal(clearedTimer, proactiveTimer)
    assert.equal(subscriptionStopped, true)
    assert.deepEqual(order.at(-1), "proactive:clearInterval")
  } finally {
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
  }
```

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
node --test --experimental-strip-types src/credentials.test.ts src/index.test.ts
```

Expected: FAIL because `startProactiveRefresh`, `PROACTIVE_REFRESH_INTERVAL_MS`, and `PROACTIVE_REFRESH_THRESHOLD_MS` do not exist and plugin setup does not start proactive refresh.

- [ ] **Step 4: Add proactive refresh primitives**

In `src/credentials.ts`, extend `RefreshOptions`:

```ts
export type RefreshOptions = {
  force?: boolean
  reloadSource?: boolean
  refreshThresholdMs?: number
}
```

Add constants near `CREDENTIAL_CACHE_TTL_MS`:

```ts
export const PROACTIVE_REFRESH_INTERVAL_MS = 5 * 60_000
export const PROACTIVE_REFRESH_THRESHOLD_MS = 60 * 60_000
```

Inside `refreshIfNeeded`, replace the hard-coded fresh check:

```ts
  const refreshThresholdMs = options.refreshThresholdMs ?? 60_000
  if (!force && creds.expiresAt > Date.now() + refreshThresholdMs) return creds
```

Add this function after `refreshIfNeeded`:

```ts
type ProactiveRefreshOptions = {
  setInterval?: typeof setInterval
  clearInterval?: typeof clearInterval
  now?: () => number
  refresh?: (refreshToken: string) => ClaudeCredentials | null
}

export function startProactiveRefresh(
  options: ProactiveRefreshOptions = {},
): () => void {
  const setTimer = options.setInterval ?? globalThis.setInterval
  const clearTimer = options.clearInterval ?? globalThis.clearInterval
  const now = options.now ?? Date.now
  let cleaned = false

  const refresh = () => {
    const account = getActiveAccount()
    if (!account) return
    const expiresIn = account.credentials.expiresAt - now()
    if (expiresIn >= PROACTIVE_REFRESH_THRESHOLD_MS) return

    let refreshed: ClaudeCredentials | null = null
    if (options.refresh && account.credentials.refreshToken) {
      const forced = options.refresh(account.credentials.refreshToken)
      if (forced && forced.expiresAt > now() + 60_000) {
        account.credentials = forced
        writeBackCredentials(account.source, forced)
        accountCacheMap.set(account.source, { creds: forced, cachedAt: now() })
        refreshed = forced
      }
    } else {
      refreshed = refreshIfNeeded(account, {
        reloadSource: true,
        refreshThresholdMs: PROACTIVE_REFRESH_THRESHOLD_MS,
      })
    }

    if (!refreshed) {
      log("proactive_refresh_failed", {
        source: account.source,
        expiresAt: account.credentials.expiresAt,
      })
    }
  }

  refresh()
  const timer = setTimer(refresh, PROACTIVE_REFRESH_INTERVAL_MS)
  const maybeUnref = timer as { unref?: () => void }
  maybeUnref.unref?.()

  return () => {
    if (cleaned) return
    cleaned = true
    clearTimer(timer)
  }
}
```

- [ ] **Step 5: Start proactive refresh during plugin setup and compose cleanup**

In `src/index.ts`, import the starter:

```ts
import { startProactiveRefresh } from "./credentials.ts"
```

Change `setup` to:

```ts
  async setup(context) {
    const runtime = context as unknown as RuntimePluginContext
    initLogger()
    await runtime.integration.transform(registerAnthropicIntegration)
    await reconcileConnectedCredential(runtime.integration)
    const stopProactiveRefresh = startProactiveRefresh()
    await runtime.catalog.transform(applyAnthropicCatalog)
    await runtime.session.hook("context", injectClaudeIdentity)
    const stopRateLimitNotices = await startRateLimitNotices(runtime)

    return async () => {
      stopProactiveRefresh()
      await stopRateLimitNotices()
    }
  },
```

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
node --test --experimental-strip-types src/credentials.test.ts src/index.test.ts
pnpm run typecheck
```

Expected: PASS for focused tests and typecheck.

- [ ] **Step 7: Commit proactive refresh**

```bash
git add src/credentials.ts src/credentials.test.ts src/index.ts src/index.test.ts
git commit -m "fix: proactively refresh primary credentials"
```

## Task 3: Add Bounded 401 Reload/Refresh Retry

**Files:**
- Modify: `src/credentials.ts`
- Modify: `src/credentials.test.ts`
- Modify: `src/claude-fetch.ts`
- Modify: `src/claude-fetch.test.ts`
- Modify: `src/provider.ts`
- Modify: `src/provider.test.ts`

**Interfaces:**
- Consumes: `createClaudeFetch(options: ClaudeFetchOptions): typeof fetch`, replayable request bodies, `refreshAccount(source)`, `writeBackCredentials(source, creds)`, and active primary credentials.
- Produces: `reloadPrimaryCredentials(): ClaudeCredentials | null`, `forceRefreshPrimaryCredentials(refresh?): ClaudeCredentials | null`, and `ClaudeFetchOptions.authRecovery` with exactly one retry per 401 response.

- [ ] **Step 1: Write failing credential reload/force-refresh tests**

Extend the temporary module type in `src/credentials.test.ts` helper so `credentialsModule` includes:

```ts
    reloadPrimaryCredentials: () => Creds | null
    forceRefreshPrimaryCredentials: (
      refresh?: (refreshToken: string) => Creds | null,
    ) => Creds | null
    invalidateCredentialCache: () => void
```

Append these tests inside `describe("credential caching", () => { ... })`:

```ts
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

      const result = credentialsModule.forceRefreshPrimaryCredentials((token) => {
        assert.equal(token, "refresh-token")
        return newCreds
      })

      assert.ok(result)
      assert.equal(result.accessToken, "oauth-refreshed-token")
      assert.equal(account.credentials.accessToken, "oauth-refreshed-token")
      assert.equal(keychainModule.__getWriteCount(), 1)
      assert.equal(credentialsModule.getCachedCredentials()?.accessToken, "oauth-refreshed-token")
    } finally {
      Date.now = originalNow
    }
  })
```

- [ ] **Step 2: Write failing 401 fetch retry tests**

Append these tests inside `describe("Claude OAuth fetch pipeline", () => { ... })` in `src/claude-fetch.test.ts`:

```ts
  it("retries a 401 once with a reloaded primary token when it rotated externally", async () => {
    let calls = 0
    const authHeaders: string[] = []
    const upstream = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1
      authHeaders.push(new Headers(init?.headers).get("authorization") ?? "")
      return new Response(calls === 1 ? "unauthorized" : "ok", {
        status: calls === 1 ? 401 : 200,
      })
    }) as typeof fetch

    const claudeFetch = createClaudeFetch({
      accessToken: "old-token",
      upstream,
      retries: 1,
      authRecovery: {
        reload: () => ({
          accessToken: "rotated-token",
          refreshToken: "rotated-refresh",
          expiresAt: Date.now() + 10 * 60_000,
        }),
        refresh: () => {
          throw new Error("refresh must not run after external rotation")
        },
      },
    })

    const response = await claudeFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    })

    assert.equal(response.status, 200)
    assert.equal(calls, 2)
    assert.deepEqual(authHeaders, ["Bearer old-token", "Bearer rotated-token"])
  })

  it("falls back to one OAuth refresh on 401 when reload returns the rejected token", async () => {
    let calls = 0
    const authHeaders: string[] = []
    const upstream = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1
      authHeaders.push(new Headers(init?.headers).get("authorization") ?? "")
      return new Response(calls === 1 ? "unauthorized" : "ok", {
        status: calls === 1 ? 401 : 200,
      })
    }) as typeof fetch

    const claudeFetch = createClaudeFetch({
      accessToken: "rejected-token",
      upstream,
      retries: 1,
      authRecovery: {
        reload: () => ({
          accessToken: "rejected-token",
          refreshToken: "refresh-token",
          expiresAt: Date.now() + 10 * 60_000,
        }),
        refresh: () => ({
          accessToken: "oauth-refreshed-token",
          refreshToken: "new-refresh",
          expiresAt: Date.now() + 10 * 60_000,
        }),
      },
    })

    const response = await claudeFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    })

    assert.equal(response.status, 200)
    assert.equal(calls, 2)
    assert.deepEqual(authHeaders, [
      "Bearer rejected-token",
      "Bearer oauth-refreshed-token",
    ])
  })

  it("does not loop when the retry also returns 401", async () => {
    let calls = 0
    const upstream = (async () => {
      calls += 1
      return new Response("unauthorized", { status: 401 })
    }) as typeof fetch
    const claudeFetch = createClaudeFetch({
      accessToken: "rejected-token",
      upstream,
      retries: 1,
      authRecovery: {
        reload: () => ({
          accessToken: "rotated-token",
          refreshToken: "rotated-refresh",
          expiresAt: Date.now() + 10 * 60_000,
        }),
        refresh: () => null,
      },
    })

    const response = await claudeFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    })

    assert.equal(response.status, 401)
    assert.equal(await response.text(), "unauthorized")
    assert.equal(calls, 2)
  })
```

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
node --test --experimental-strip-types src/credentials.test.ts src/claude-fetch.test.ts
```

Expected: FAIL because `reloadPrimaryCredentials`, `forceRefreshPrimaryCredentials`, and `authRecovery` do not exist, and the current 401 test still expects exactly one upstream call with no fallback.

- [ ] **Step 4: Add primary credential reload and forced refresh helpers**

In `src/credentials.ts`, add these functions before `getCachedCredentials()`:

```ts
export function invalidateCredentialCache(): void {
  const account = getActiveAccount()
  if (!account) return
  accountCacheMap.delete(account.source)
  log("cache_invalidated", { source: account.source })
}

export function reloadPrimaryCredentials(): ClaudeCredentials | null {
  const account = getActiveAccount()
  if (!account) return null
  try {
    const fresh = refreshAccount(account.source)
    if (!fresh) return null
    account.credentials = fresh
    accountCacheMap.set(account.source, { creds: fresh, cachedAt: Date.now() })
    return fresh
  } catch (err) {
    log("primary_reload_failed", {
      source: account.source,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

export function forceRefreshPrimaryCredentials(
  refresh: (refreshToken: string) => ClaudeCredentials | null = refreshViaOAuth,
): ClaudeCredentials | null {
  const account = getActiveAccount()
  if (!account?.credentials.refreshToken) return null

  const oauthCreds = refresh(account.credentials.refreshToken)
  if (!oauthCreds || oauthCreds.expiresAt <= Date.now() + 60_000) {
    log("force_refresh_failed", { source: account.source })
    return null
  }

  account.credentials = oauthCreds
  if (!writeBackCredentials(account.source, oauthCreds)) {
    log("force_refresh_writeback_failed", { source: account.source })
  }
  accountCacheMap.set(account.source, { creds: oauthCreds, cachedAt: Date.now() })
  return oauthCreds
}
```

- [ ] **Step 5: Add bounded 401 auth recovery to `createClaudeFetch`**

In `src/claude-fetch.ts`, import the credential type:

```ts
import type { ClaudeCredentials } from "./credentials.ts"
```

Extend `ClaudeFetchOptions`:

```ts
export type ClaudeFetchOptions = {
  accessToken: string
  upstream?: FetchFn
  sleep?: SleepFn
  retries?: number
  authRecovery?: {
    reload: () => ClaudeCredentials | null
    refresh: () => ClaudeCredentials | null
  }
}
```

Inside the returned fetch function, replace the first `let response = await fetchWithRetry(...)` with a send helper and one 401 retry:

```ts
    const send = async (accessToken: string): Promise<Response> => {
      const requestHeaders = buildRequestHeaders(
        input,
        requestInit,
        accessToken,
        modelId,
        getExcludedBetas(modelId),
      )
      return await fetchWithRetry(
        requestUrl,
        { ...requestInit, method, body, headers: requestHeaders },
        effectiveRetries,
        upstream,
        sleep,
      )
    }

    let activeAccessToken = options.accessToken
    let response = await send(activeAccessToken)

    log("fetch_response", { status: response.status, modelId, retryAttempt: 0 })

    if (response.status === 401 && isReplayable && options.authRecovery) {
      const reloaded = options.authRecovery.reload()
      let retryCreds =
        reloaded && reloaded.accessToken !== activeAccessToken
          ? reloaded
          : options.authRecovery.refresh()

      if (retryCreds && retryCreds.accessToken !== activeAccessToken) {
        activeAccessToken = retryCreds.accessToken
        response = await send(activeAccessToken)
        log("fetch_response", {
          status: response.status,
          modelId,
          retryAttempt: 1,
        })
      }
    }
```

Keep the existing long-context beta retry loop below this block. In that loop, replace `options.accessToken` in retry header construction with `activeAccessToken` so beta retries after auth recovery use the recovered token.

- [ ] **Step 6: Pass primary recovery hooks from provider**

In `src/provider.ts`, import the helpers:

```ts
import {
  forceRefreshPrimaryCredentials,
  reloadPrimaryCredentials,
} from "./credentials.ts"
```

Change the `createClaudeFetch` call in `executorLayer` to:

```ts
        createClaudeFetch({
          accessToken,
          upstream,
          authRecovery: {
            reload: reloadPrimaryCredentials,
            refresh: forceRefreshPrimaryCredentials,
          },
        }),
```

Keep the existing provider test named `settings metadata such as source is not forwarded to provider options or HTTP`; it must still pass.

- [ ] **Step 7: Run focused tests and typecheck**

Run:

```bash
node --test --experimental-strip-types src/credentials.test.ts src/claude-fetch.test.ts src/provider.test.ts
pnpm run typecheck
```

Expected: PASS for focused tests and typecheck.

- [ ] **Step 8: Commit bounded 401 recovery**

```bash
git add src/credentials.ts src/credentials.test.ts src/claude-fetch.ts src/claude-fetch.test.ts src/provider.ts src/provider.test.ts
git commit -m "fix: recover primary Claude auth after 401"
```

## Task 4: Sanitize Auth Resilience Failures

**Files:**
- Modify: `src/claude-fetch.test.ts`
- Modify: `src/credentials.test.ts`
- Modify: `src/logger.test.ts`
- Modify: `src/logger.ts`

**Interfaces:**
- Consumes: `log(event, data?)`, `redact(data)`, `warnOnErrorResponse(response, modelId)`, and `authRecovery` failure paths.
- Produces: tests and redaction behavior proving tokens, refresh tokens, JWTs, and raw 401 response bodies are not written to logs or `console.warn`.

- [ ] **Step 1: Write failing sanitized 401 recovery test**

Append this test inside `describe("Claude OAuth fetch pipeline", () => { ... })` in `src/claude-fetch.test.ts`:

```ts
  it("does not leak rejected tokens or raw 401 bodies during auth recovery", async () => {
    const logged: string[] = []
    initLogger({
      stream: {
        write(chunk: string) {
          logged.push(chunk)
          return true
        },
      } as never,
    })

    const originalWarn = console.warn
    const warnings: unknown[][] = []
    const rejectedToken = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.rejected.signature"
    const rawBody = `upstream body with Bearer ${rejectedToken} and refresh_token=secret-refresh`
    let calls = 0
    const upstream = (async () => {
      calls += 1
      return new Response(rawBody, { status: 401 })
    }) as typeof fetch

    try {
      console.warn = (...args: unknown[]) => {
        warnings.push(args)
      }
      const claudeFetch = createClaudeFetch({
        accessToken: rejectedToken,
        upstream,
        retries: 1,
        authRecovery: {
          reload: () => null,
          refresh: () => null,
        },
      })

      const response = await claudeFetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
      })

      assert.equal(response.status, 401)
      assert.equal(await response.text(), rawBody)
      await new Promise((resolve) => setImmediate(resolve))
    } finally {
      console.warn = originalWarn
    }

    assert.equal(calls, 1)
    assert.deepEqual(warnings, [])
    const output = logged.join("")
    assert.ok(!output.includes(rejectedToken))
    assert.ok(!output.includes("secret-refresh"))
    assert.ok(!output.includes(rawBody))
  })
```

- [ ] **Step 2: Write failing logger redaction coverage**

Append this test inside `describe("redact", () => { ... })` in `src/logger.test.ts`:

```ts
  it("redacts token-like strings in error messages", () => {
    const result = redact({
      error:
        "failed with Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature and refresh_token=secret-refresh",
    })

    assert.equal(
      result.error,
      "failed with Bearer JWT_REDACTED and refresh_token=REDACTED",
    )
  })
```

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
node --test --experimental-strip-types src/claude-fetch.test.ts src/logger.test.ts
```

Expected: FAIL because logger redaction currently only handles token-like full string values, not secrets embedded inside error message strings.

- [ ] **Step 4: Redact embedded secrets in logger values**

In `src/logger.ts`, replace `redactValue` with:

```ts
function redactValue(key: string, value: unknown): unknown {
  if (typeof value !== "string") return value

  if (key === "refreshToken" || key === "x-api-key") {
    return "REDACTED"
  }

  if (key === "accessToken") {
    const prefix = value.slice(0, 8)
    return `${prefix}...REDACTED`
  }

  if (JWT_PATTERN.test(value)) {
    return `${value.slice(0, 8)}...REDACTED`
  }

  return value
    .replace(/\bBearer\s+eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?\b/g, "Bearer JWT_REDACTED")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?\b/g, "JWT_REDACTED")
    .replace(/\baccess_token=([^&\s"'{};,]+)/gi, "access_token=REDACTED")
    .replace(/\brefresh_token=([^&\s"'{};,]+)/gi, "refresh_token=REDACTED")
    .replace(/("access_token"\s*:\s*")[^"]+(")/gi, "$1REDACTED$2")
    .replace(/("refresh_token"\s*:\s*")[^"]+(")/gi, "$1REDACTED$2")
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-REDACTED")
}
```

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
node --test --experimental-strip-types src/claude-fetch.test.ts src/credentials.test.ts src/logger.test.ts
pnpm run typecheck
```

Expected: PASS for focused tests and typecheck.

- [ ] **Step 6: Commit sanitized auth failures**

```bash
git add src/claude-fetch.test.ts src/credentials.test.ts src/logger.ts src/logger.test.ts
git commit -m "fix: sanitize primary auth recovery logs"
```

## Task 5: Final Auth Resilience Verification Gate

**Files:**
- Modify: `test-results/model-smoke-test.json` only if the live smoke script updates it intentionally.
- Modify: `test-results/failed-models.json` only if the live smoke script updates it intentionally.

**Interfaces:**
- Consumes: all tasks from this plan plus provider/model behavior from Plans 1 and 2.
- Produces: final evidence that local tests, typecheck, build, OpenCode plugin API load, and a live `minion-opus-high` smoke pass work after auth resilience changes.

- [ ] **Step 1: Run full local verification**

Run:

```bash
pnpm test
pnpm run typecheck
pnpm run build
```

Expected: all commands exit with code 0.

- [ ] **Step 2: Verify OpenCode can see the built plugin**

Run: `opencode2 api get /api/plugin`

Expected: command exits with code 0 and the output includes an entry for `opencode-claude-auth`. If the OpenCode service is not running, start it through the normal local workflow for this repository and rerun the same command.

- [ ] **Step 3: Run the final live Opus gate**

Run the approved live smoke for `minion-opus-high` once, after local verification and plugin API load have passed. Use the existing local smoke harness for this repo:

```bash
pnpm run build
opencode2 api get /api/plugin
opencode2 run --model minion-opus-high "Reply with exactly: opencode-claude-auth-live-smoke"
```

Expected: the command completes without auth prompts, without a 401 loop, and the model reply contains `opencode-claude-auth-live-smoke`.

- [ ] **Step 4: Run whitespace and status checks**

Run:

```bash
git diff --check
git status --short
```

Expected: `git diff --check` exits with code 0. `git status --short` shows no uncommitted source changes unless the live smoke intentionally updated `test-results/model-smoke-test.json` or `test-results/failed-models.json`.

- [ ] **Step 5: Commit final smoke-result files only if changed intentionally**

If the live smoke updated tracked result files, commit only those files:

```bash
git add test-results/model-smoke-test.json test-results/failed-models.json
git commit -m "test: record primary auth live smoke"
```

If no tracked result file changed, do not create an empty commit.

## Final Verification

Run these exact commands after Task 5:

```bash
pnpm test
pnpm run typecheck
pnpm run build
opencode2 api get /api/plugin
opencode2 run --model minion-opus-high "Reply with exactly: opencode-claude-auth-live-smoke"
git diff --check
git status --short
```

Expected final state for this plan: all local commands pass, OpenCode lists the plugin, the live Opus smoke returns the expected text, no raw tokens or raw 401 bodies appear in logs/TUI output, no 401 retry loop occurs, and `git status --short` is clean or shows only intentionally committed live-smoke result files.
