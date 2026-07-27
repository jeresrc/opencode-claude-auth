import assert from "node:assert/strict"
import test from "node:test"
import { reconcileConnectedCredential } from "./credential-sync.ts"
import type { ClaudeAccount } from "./keychain.ts"

function account(source: string): ClaudeAccount {
  return {
    label: source,
    source,
    credentials: {
      accessToken: `access-${source}`,
      refreshToken: `refresh-${source}`,
      expiresAt: 1_700_000_000_000,
    },
  }
}

test("replaces a stale stored credential from its selected Keychain source", async () => {
  const accounts = [account("account-a"), account("account-b")]
  const calls: Array<{ name: string; input?: unknown }> = []
  const statuses = [
    { status: "pending" as const },
    { status: "complete" as const },
  ]

  const result = await reconcileConnectedCredential(
    {
      reload: async () => {
        calls.push({ name: "reload" })
      },
      connection: {
        active: async () => ({
          type: "credential",
          id: "credential-id",
          label: "Anthropic account",
        }),
        resolve: async () => ({
          type: "oauth",
          methodID: "claude-code",
          access: "stale-access",
          refresh: "stale-refresh",
          expires: 1,
          metadata: { source: "account-b" },
        }),
      },
      oauth: {
        connect: async (input) => {
          calls.push({ name: "connect", input })
          return { data: { attemptID: "attempt-id", mode: "auto" } }
        },
        status: async (input) => {
          calls.push({ name: "status", input })
          return { data: statuses.shift() ?? { status: "complete" } }
        },
      },
    },
    {
      readAccounts: () => accounts,
      sleep: async () => {},
      maxStatusChecks: 3,
    },
  )

  assert.equal(result, true)
  assert.deepEqual(calls, [
    { name: "reload" },
    {
      name: "connect",
      input: {
        integrationID: "anthropic",
        methodID: "claude-code",
        inputs: { source: "account-b" },
        label: "Anthropic account",
      },
    },
    {
      name: "status",
      input: { integrationID: "anthropic", attemptID: "attempt-id" },
    },
    {
      name: "status",
      input: { integrationID: "anthropic", attemptID: "attempt-id" },
    },
  ])
})

test("does nothing when Anthropic has no Claude Code OAuth connection", async () => {
  let reads = 0
  const result = await reconcileConnectedCredential(
    {
      reload: async () => {},
      connection: {
        active: async () => ({
          type: "credential",
          id: "credential-id",
          label: "Anthropic",
        }),
        resolve: async () => ({ type: "key", key: "api-key" }),
      },
      oauth: {
        connect: async () => {
          throw new Error("unexpected connect")
        },
        status: async () => {
          throw new Error("unexpected status")
        },
      },
    },
    {
      readAccounts: () => {
        reads += 1
        return []
      },
    },
  )

  assert.equal(result, false)
  assert.equal(reads, 0)
})

test("does not reconnect when the persisted credential is already current", async () => {
  const current = account("account-a")
  let reloads = 0
  const result = await reconcileConnectedCredential(
    {
      reload: async () => {
        reloads += 1
      },
      connection: {
        active: async () => ({
          type: "credential",
          id: "credential-id",
          label: "Anthropic",
        }),
        resolve: async () => ({
          type: "oauth",
          methodID: "claude-code",
          access: current.credentials.accessToken,
          refresh: current.credentials.refreshToken,
          expires: current.credentials.expiresAt,
          metadata: { source: current.source },
        }),
      },
      oauth: {
        connect: async () => {
          throw new Error("unexpected connect")
        },
        status: async () => {
          throw new Error("unexpected status")
        },
      },
    },
    { readAccounts: () => [current] },
  )

  assert.equal(result, false)
  assert.equal(reloads, 0)
})

test("reconciles a legacy suffixed Keychain source through the sole primary account", async () => {
  const primary = account("Claude Code-credentials")
  const calls: Array<{ name: string; input?: unknown }> = []

  const result = await reconcileConnectedCredential(
    {
      reload: async () => {
        calls.push({ name: "reload" })
      },
      connection: {
        active: async () => ({
          type: "credential",
          id: "credential-id",
          label: "Anthropic account",
        }),
        resolve: async () => ({
          type: "oauth",
          methodID: "claude-code",
          access: "legacy-access",
          refresh: "legacy-refresh",
          expires: 1,
          metadata: { source: "Claude Code-credentials-deadbeef" },
        }),
      },
      oauth: {
        connect: async (input) => {
          calls.push({ name: "connect", input })
          return { data: { attemptID: "attempt-id", mode: "auto" } }
        },
        status: async (input) => {
          calls.push({ name: "status", input })
          return { data: { status: "complete" } }
        },
      },
    },
    {
      readAccounts: () => [primary],
      sleep: async () => {},
      maxStatusChecks: 1,
    },
  )

  assert.equal(result, true)
  assert.deepEqual(calls, [
    { name: "reload" },
    {
      name: "connect",
      input: {
        integrationID: "anthropic",
        methodID: "claude-code",
        inputs: { source: "Claude Code-credentials" },
        label: "Anthropic account",
      },
    },
    {
      name: "status",
      input: { integrationID: "anthropic", attemptID: "attempt-id" },
    },
  ])
})

test("does not reconcile arbitrary unknown sources through the primary account", async () => {
  let reloads = 0
  let connects = 0

  const result = await reconcileConnectedCredential(
    {
      reload: async () => {
        reloads += 1
      },
      connection: {
        active: async () => ({
          type: "credential",
          id: "credential-id",
          label: "Anthropic account",
        }),
        resolve: async () => ({
          type: "oauth",
          methodID: "claude-code",
          access: "unknown-access",
          refresh: "unknown-refresh",
          expires: 1,
          metadata: { source: "unrelated-source" },
        }),
      },
      oauth: {
        connect: async () => {
          connects += 1
          throw new Error("unexpected connect")
        },
        status: async () => {
          throw new Error("unexpected status")
        },
      },
    },
    { readAccounts: () => [account("Claude Code-credentials")] },
  )

  assert.equal(result, false)
  assert.equal(reloads, 0)
  assert.equal(connects, 0)
})
