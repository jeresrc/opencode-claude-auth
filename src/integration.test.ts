import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Effect } from "effect"
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
  authorize: (inputs: Record<string, string>) => Effect.Effect<
    {
      mode: "auto"
      url: string
      instructions: string
      callback: Effect.Effect<unknown, unknown>
    },
    unknown
  >
  refresh: (credential: {
    type: "oauth"
    methodID: string
    access: string
    refresh: string
    expires: number
    metadata?: Record<string, unknown>
  }) => Effect.Effect<unknown, unknown>
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

  it("updates Anthropic and registers a Claude Code OAuth method with source prompts for multiple accounts", () => {
    const { draft, integration, registration } = createDraft()

    registerAnthropicIntegration(draft, {
      readAccounts: () => [
        account("Claude Code-credentials", "Claude Pro"),
        account("Claude Code-credentials-2", "Claude Max"),
      ],
      refreshIfNeeded: () => null,
    })

    assert.equal(integration.name, "Anthropic")
    assert.equal(registration().integrationID, "anthropic")
    assert.deepEqual(registration().method, {
      id: CLAUDE_CODE_METHOD_ID,
      type: "oauth",
      label: "Claude Code credentials",
      prompts: [
        {
          type: "select",
          key: "source",
          message: "Select Claude Code account",
          options: [
            {
              label: "Claude Pro",
              value: "Claude Code-credentials",
              hint: "Claude Code-credentials",
            },
            {
              label: "Claude Max",
              value: "Claude Code-credentials-2",
              hint: "Claude Code-credentials-2",
            },
          ],
        },
      ],
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

  it("returns Effects from authorize and callback that produce OAuth credentials", async () => {
    const { draft, registration } = createDraft()

    registerAnthropicIntegration(draft, {
      readAccounts: () => [account("file", "Claude")],
      refreshIfNeeded: () => null,
    })

    const authorizationEffect = registration().authorize({})
    assert.equal(typeof authorizationEffect.pipe, "function")

    const authorization = await Effect.runPromise(authorizationEffect)
    assert.equal(authorization.mode, "auto")
    assert.equal(authorization.url, "")
    assert.match(authorization.instructions, /Claude Code credentials/)
    assert.equal(typeof authorization.callback.pipe, "function")

    assert.deepEqual(await Effect.runPromise(authorization.callback), {
      type: "oauth",
      methodID: CLAUDE_CODE_METHOD_ID,
      access: "access-file",
      refresh: "refresh-file",
      expires: 1_700_000_000_000,
      metadata: { source: "file" },
    })
  })

  it("rereads accounts for authorize and fails invalid selections or missing accounts", async () => {
    const { draft, registration } = createDraft()
    let reads = 0
    const first = account("first", "First")
    const second = account("second", "Second")

    registerAnthropicIntegration(draft, {
      readAccounts: () => {
        reads += 1
        return reads === 1 ? [first, second] : [second]
      },
      refreshIfNeeded: () => null,
    })

    assert.equal(reads, 1, "registration reads once for prompt construction")
    await assert.rejects(
      Effect.runPromise(registration().authorize({ source: "first" })),
      {
        message: /Claude Code account not found/,
      },
    )
    assert.equal(reads, 2, "authorize rereads live accounts")

    const noAccounts = createDraft()
    registerAnthropicIntegration(noAccounts.draft, {
      readAccounts: () => [],
      refreshIfNeeded: () => null,
    })
    await assert.rejects(
      Effect.runPromise(noAccounts.registration().authorize({})),
      {
        message: /No Claude Code accounts found/,
      },
    )
  })

  it("refresh uses metadata.source, forces refreshIfNeeded with a cloned expired account, and returns refreshed OAuth", async () => {
    const { draft, registration } = createDraft()
    const original = account("second", "Second")
    let refreshAccount: ClaudeAccount | undefined

    registerAnthropicIntegration(draft, {
      readAccounts: () => [account("first", "First"), original],
      refreshIfNeeded: (target) => {
        refreshAccount = target
        return {
          accessToken: "access-refreshed",
          refreshToken: "refresh-refreshed",
          expiresAt: 1_700_000_600_000,
        }
      },
    })

    const refreshed = await Effect.runPromise(
      registration().refresh({
        type: "oauth",
        methodID: CLAUDE_CODE_METHOD_ID,
        access: "old-access",
        refresh: "old-refresh",
        expires: 1,
        metadata: { source: "second" },
      }),
    )

    assert.ok(refreshAccount)
    assert.notEqual(refreshAccount, original)
    assert.equal(refreshAccount.source, "second")
    assert.equal(refreshAccount.credentials.expiresAt, 0)
    assert.deepEqual(refreshed, {
      type: "oauth",
      methodID: CLAUDE_CODE_METHOD_ID,
      access: "access-refreshed",
      refresh: "refresh-refreshed",
      expires: 1_700_000_600_000,
      metadata: { source: "second" },
    })
  })

  it("fails refresh when metadata.source is absent", async () => {
    const { draft, registration } = createDraft()
    registerAnthropicIntegration(draft, {
      readAccounts: () => [account("file", "Claude")],
      refreshIfNeeded: () => creds("unused"),
    })

    await assert.rejects(
      Effect.runPromise(
        registration().refresh({
          type: "oauth",
          methodID: CLAUDE_CODE_METHOD_ID,
          access: "old-access",
          refresh: "old-refresh",
          expires: 1,
        }),
      ),
      { message: /missing metadata.source/ },
    )
  })
})
