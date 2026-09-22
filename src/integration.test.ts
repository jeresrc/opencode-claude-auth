import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  CLAUDE_CODE_METHOD_ID,
  registerAnthropicIntegration,
  toOAuthCredential,
} from "./integration.ts"
import type { ClaudeAccount, ClaudeCredentials } from "./credentials.ts"

type CapturedRegistration = {
  integrationID: string
  method: {
    id: string
    type: "oauth"
    label: string
    prompts?: Array<{
      type: "select"
      key: string
      message: string
      options: Array<{ label: string; value: string; hint?: string }>
    }>
  }
  authorize: (inputs: Record<string, string>) => Promise<{
    mode: "auto"
    url: string
    instructions: string
    callback: Promise<unknown>
  }>
  refresh: (credential: {
    type: "oauth"
    methodID: string
    access: string
    refresh: string
    expires: number
    metadata?: Record<string, unknown>
  }) => Promise<unknown>
}

type RefreshOptions = {
  force?: boolean
  reloadSource?: boolean
}

function creds(id: string): ClaudeCredentials {
  return {
    accessToken: `access-${id}`,
    refreshToken: `refresh-${id}`,
    expiresAt: 1_700_000_000_000,
  }
}

function account(source: string, label: string): ClaudeAccount {
  return { source, label, credentials: creds(source) }
}

function createDraft() {
  const integration = { id: "anthropic", name: "Old Anthropic" }
  let captured: CapturedRegistration | undefined

  return {
    draft: {
      list: () => [integration],
      get: (id: string) => (id === integration.id ? integration : undefined),
      update: (id: string, update: (target: typeof integration) => void) => {
        assert.equal(id, "anthropic")
        update(integration)
      },
      remove: () => undefined,
      method: {
        list: () => [],
        update: (registration: CapturedRegistration) => {
          captured = registration
        },
        remove: () => undefined,
      },
    },
    integration,
    registration: () => {
      assert.ok(captured, "expected OAuth method registration to be captured")
      return captured
    },
  }
}

describe("Anthropic integration registration", () => {
  it("converts Claude Code credentials to the exact OAuth credential shape", () => {
    assert.deepEqual(toOAuthCredential(creds("file"), "file"), {
      type: "oauth",
      methodID: "claude-code",
      access: "access-file",
      refresh: "refresh-file",
      expires: 1_700_000_000_000,
      metadata: { source: "file" },
    })
  })

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

  it("does not prompt when zero or one Claude Code account is available", () => {
    const empty = createDraft()
    registerAnthropicIntegration(empty.draft, {
      readAccounts: () => [],
      refreshIfNeeded: () => null,
    })
    assert.equal(empty.registration().method.prompts, undefined)

    const single = createDraft()
    registerAnthropicIntegration(single.draft, {
      readAccounts: () => [account("file", "Claude")],
      refreshIfNeeded: () => null,
    })
    assert.equal(single.registration().method.prompts, undefined)
  })

  it("returns real Promises from authorize and callback that produce OAuth credentials", async () => {
    const { draft, registration } = createDraft()

    registerAnthropicIntegration(draft, {
      readAccounts: () => [account("file", "Claude")],
      refreshIfNeeded: () => null,
    })

    const authorizationPromise = registration().authorize({})
    assert.equal(typeof authorizationPromise.then, "function")
    assert.equal("pipe" in authorizationPromise, false)

    const authorization = await authorizationPromise
    assert.equal(authorization.mode, "auto")
    assert.equal(authorization.url, "")
    assert.match(authorization.instructions, /Claude Code credentials/)
    assert.equal(typeof authorization.callback.then, "function")
    assert.equal("pipe" in authorization.callback, false)

    assert.deepEqual(await authorization.callback, {
      type: "oauth",
      methodID: CLAUDE_CODE_METHOD_ID,
      access: "access-file",
      refresh: "refresh-file",
      expires: 1_700_000_000_000,
      metadata: { source: "file" },
    })
  })

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

    const authorization = await registration().authorize({
      source: "Claude Code-credentials-deadbeef",
    })

    assert.equal(authorization.mode, "auto")
    assert.deepEqual(await authorization.callback, {
      type: "oauth",
      methodID: CLAUDE_CODE_METHOD_ID,
      access: "access-Claude Code-credentials",
      refresh: "refresh-Claude Code-credentials",
      expires: 1_700_000_000_000,
      metadata: { source: "Claude Code-credentials" },
    })
    assert.equal(reads, 2)
  })

  it("refresh reloads the selected account instead of reusing a stale stored credential", async () => {
    const { draft, registration } = createDraft()
    const original: ClaudeAccount = {
      source: "file",
      label: "Claude",
      credentials: {
        accessToken: "access-stale",
        refreshToken: "refresh-stale",
        expiresAt: 1_700_000_900_000,
      },
    }
    let refreshAccount: ClaudeAccount | undefined
    let refreshOptions: RefreshOptions | undefined

    registerAnthropicIntegration(draft, {
      readAccounts: () => [original],
      refreshIfNeeded: (target, options?: RefreshOptions) => {
        refreshAccount = target
        refreshOptions = options
        return {
          accessToken: "access-refreshed",
          refreshToken: "refresh-refreshed",
          expiresAt: 1_700_000_600_000,
        }
      },
    })

    const refreshPromise = registration().refresh({
      type: "oauth",
      methodID: CLAUDE_CODE_METHOD_ID,
      access: "access-current",
      refresh: "refresh-current",
      expires: 1_700_001_000_000,
      metadata: { source: "file" },
    })
    assert.equal(typeof refreshPromise.then, "function")
    assert.equal("pipe" in refreshPromise, false)

    const refreshed = await refreshPromise

    assert.ok(refreshAccount)
    assert.equal(refreshAccount, original)
    assert.equal(refreshAccount.source, "file")
    assert.equal(refreshAccount.credentials.accessToken, "access-stale")
    assert.equal(refreshAccount.credentials.refreshToken, "refresh-stale")
    assert.equal(refreshAccount.credentials.expiresAt, 1_700_000_900_000)
    assert.equal(refreshOptions?.reloadSource, true)
    assert.equal(typeof refreshOptions?.sync, "function")
    assert.deepEqual(refreshed, {
      type: "oauth",
      methodID: CLAUDE_CODE_METHOD_ID,
      access: "access-refreshed",
      refresh: "refresh-refreshed",
      expires: 1_700_000_600_000,
      metadata: { source: "file" },
    })
  })

  it("refresh migrates a legacy suffixed Keychain source to the sole primary account", async () => {
    const { draft, registration } = createDraft()
    const primary = account("Claude Code-credentials", "Claude Pro")
    let refreshAccount: ClaudeAccount | undefined

    registerAnthropicIntegration(draft, {
      readAccounts: () => [primary],
      refreshIfNeeded: (target) => {
        refreshAccount = target
        return {
          accessToken: "access-refreshed-primary",
          refreshToken: "refresh-refreshed-primary",
          expiresAt: 1_700_000_600_000,
        }
      },
    })

    const refreshed = await registration().refresh({
      type: "oauth",
      methodID: CLAUDE_CODE_METHOD_ID,
      access: "access-legacy",
      refresh: "refresh-legacy",
      expires: 1,
      metadata: { source: "Claude Code-credentials-deadbeef" },
    })

    assert.equal(refreshAccount, primary)
    assert.deepEqual(refreshed, {
      type: "oauth",
      methodID: CLAUDE_CODE_METHOD_ID,
      access: "access-refreshed-primary",
      refresh: "refresh-refreshed-primary",
      expires: 1_700_000_600_000,
      metadata: { source: "Claude Code-credentials" },
    })
  })

  it("refresh does not migrate arbitrary unknown sources to the primary account", async () => {
    const { draft, registration } = createDraft()
    let refreshCalls = 0

    registerAnthropicIntegration(draft, {
      readAccounts: () => [account("Claude Code-credentials", "Claude Pro")],
      refreshIfNeeded: () => {
        refreshCalls += 1
        return creds("unused")
      },
    })

    await assert.rejects(
      registration().refresh({
        type: "oauth",
        methodID: CLAUDE_CODE_METHOD_ID,
        access: "access-unknown",
        refresh: "refresh-unknown",
        expires: 1,
        metadata: { source: "unrelated-source" },
      }),
      { message: /account not found/ },
    )
    assert.equal(refreshCalls, 0)
  })

  it("fails refresh when metadata.source is absent", async () => {
    const { draft, registration } = createDraft()
    registerAnthropicIntegration(draft, {
      readAccounts: () => [account("file", "Claude")],
      refreshIfNeeded: () => creds("unused"),
    })

    await assert.rejects(
      registration().refresh({
        type: "oauth",
        methodID: CLAUDE_CODE_METHOD_ID,
        access: "old-access",
        refresh: "old-refresh",
        expires: 1,
      }),
      { message: /missing metadata.source/ },
    )
  })
})
