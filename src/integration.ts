import type {
  IntegrationDraft,
  IntegrationMethodRegistration,
} from "@opencode-ai/plugin/v2/effect/integration"
import { Effect } from "effect"
import { refreshIfNeeded, type RefreshOptions } from "./credentials.ts"
import {
  readAllClaudeAccounts,
  type ClaudeAccount,
  type ClaudeCredentials,
} from "./keychain.ts"

export const ANTHROPIC_INTEGRATION_ID = "anthropic"
export const CLAUDE_CODE_METHOD_ID = "claude-code"

export type ClaudeOAuthCredential = {
  type: "oauth"
  methodID: typeof CLAUDE_CODE_METHOD_ID
  access: string
  refresh: string
  expires: number
  metadata: { source: string }
}

type IntegrationDeps = {
  readAccounts: () => ClaudeAccount[]
  refreshIfNeeded: (
    account?: ClaudeAccount,
    options?: RefreshOptions,
  ) => ClaudeCredentials | null
}

const defaultDeps: IntegrationDeps = {
  readAccounts: readAllClaudeAccounts,
  refreshIfNeeded,
}

export function toOAuthCredential(
  credentials: ClaudeCredentials,
  source: string,
): ClaudeOAuthCredential {
  return {
    type: "oauth",
    methodID: CLAUDE_CODE_METHOD_ID,
    access: credentials.accessToken,
    refresh: credentials.refreshToken,
    expires: credentials.expiresAt,
    metadata: { source },
  }
}

function selectAccount(
  accounts: readonly ClaudeAccount[],
  source: string | undefined,
): ClaudeAccount {
  if (accounts.length === 0) {
    throw new Error("No Claude Code accounts found")
  }

  if (source) {
    const selected = accounts.find((account) => account.source === source)
    if (!selected) {
      throw new Error(`Claude Code account not found for source: ${source}`)
    }
    return selected
  }

  if (accounts.length === 1) return accounts[0]

  throw new Error("Claude Code account selection is required")
}

function sourceFromMetadata(credential: {
  metadata?: { [key: string]: unknown }
}): string {
  const source = credential.metadata?.source
  if (typeof source !== "string" || source.length === 0) {
    throw new Error("Claude OAuth credential missing metadata.source")
  }
  return source
}

export function registerAnthropicIntegration(
  draft: IntegrationDraft,
  deps: Partial<IntegrationDeps> = {},
): void {
  const resolvedDeps = { ...defaultDeps, ...deps }
  const accountsForPrompts = resolvedDeps.readAccounts()

  draft.update(ANTHROPIC_INTEGRATION_ID, (integration) => {
    integration.name = "Anthropic"
  })

  const prompts =
    accountsForPrompts.length > 1
      ? [
          {
            type: "select" as const,
            key: "source",
            message: "Select Claude Code account",
            options: accountsForPrompts.map((account) => ({
              label: account.label,
              value: account.source,
              hint: account.source,
            })),
          },
        ]
      : undefined

  const registration = {
    integrationID: ANTHROPIC_INTEGRATION_ID,
    method: {
      id: CLAUDE_CODE_METHOD_ID,
      type: "oauth" as const,
      label: "Claude Code credentials",
      ...(prompts ? { prompts } : {}),
    },
    authorize: (inputs) =>
      Effect.try({
        try: () => {
          const account = selectAccount(
            resolvedDeps.readAccounts(),
            inputs.source,
          )

          return {
            mode: "auto" as const,
            url: "",
            instructions:
              "Use the selected Claude Code credentials already installed on this machine.",
            callback: Effect.sync(() =>
              toOAuthCredential(account.credentials, account.source),
            ),
          }
        },
        catch: (error) => error,
      }),
    refresh: (credential) =>
      Effect.try({
        try: () => {
          const source = sourceFromMetadata(credential)
          const account = selectAccount(resolvedDeps.readAccounts(), source)
          const refreshed = resolvedDeps.refreshIfNeeded(account, {
            reloadSource: true,
          })
          if (!refreshed) {
            throw new Error(
              `Failed to refresh Claude Code credentials for source: ${source}`,
            )
          }
          return toOAuthCredential(refreshed, source)
        },
        catch: (error) => error,
      }),
    label: (credential) => {
      const source = credential.metadata?.source
      return typeof source === "string" ? source : undefined
    },
  } satisfies IntegrationMethodRegistration

  draft.method.update(registration)
}
