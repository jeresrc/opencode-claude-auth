import type { IntegrationDraft } from "@opencode-ai/plugin/v2/promise"
import { refreshIfNeeded, type RefreshOptions } from "./credentials.ts"
import {
  PRIMARY_SERVICE,
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

type OAuthCredentialInput = {
  type: "oauth"
  methodID: string
  access: string
  refresh: string
  expires: number
  metadata?: Record<string, unknown>
}

type PromiseOAuthMethodRegistration = {
  integrationID: typeof ANTHROPIC_INTEGRATION_ID
  method: {
    id: typeof CLAUDE_CODE_METHOD_ID
    type: "oauth"
    label: string
  }
  authorize: (inputs: Record<string, string>) => Promise<{
    mode: "auto"
    url: string
    instructions: string
    callback: Promise<ClaudeOAuthCredential>
  }>
  refresh: (credential: OAuthCredentialInput) => Promise<ClaudeOAuthCredential>
  label: (credential: OAuthCredentialInput) => string | undefined
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

function selectPrimaryAccount(
  accounts: readonly ClaudeAccount[],
): ClaudeAccount {
  const primary = accounts[0]
  if (!primary) throw new Error("No Claude Code accounts found")
  return primary
}

function sourceFromMetadata(credential: OAuthCredentialInput): string {
  const source = credential.metadata?.source
  if (typeof source !== "string" || source.length === 0) {
    throw new Error("Claude OAuth credential missing metadata.source")
  }
  return source
}

function isLegacyPrimarySource(source: string): boolean {
  const prefix = `${PRIMARY_SERVICE}-`
  return source.startsWith(prefix) && source.length > prefix.length
}

function selectAccountForSource(
  accounts: readonly ClaudeAccount[],
  source: string,
): ClaudeAccount | null {
  const exact = accounts.find((target) => target.source === source)
  if (exact) return exact
  const [onlyAccount] = accounts
  if (
    isLegacyPrimarySource(source) &&
    accounts.length === 1 &&
    onlyAccount?.source === PRIMARY_SERVICE
  ) {
    return onlyAccount
  }
  return null
}

export function registerAnthropicIntegration(
  draft: IntegrationDraft,
  deps: Partial<IntegrationDeps> = {},
): void {
  const resolvedDeps = { ...defaultDeps, ...deps }
  resolvedDeps.readAccounts()

  draft.update(ANTHROPIC_INTEGRATION_ID, (integration) => {
    integration.name = "Anthropic"
  })

  const registration = {
    integrationID: ANTHROPIC_INTEGRATION_ID,
    method: {
      id: CLAUDE_CODE_METHOD_ID,
      type: "oauth" as const,
      label: "Claude Code credentials",
    },
    authorize: async (_inputs) => {
      const account = selectPrimaryAccount(resolvedDeps.readAccounts())

      return {
        mode: "auto" as const,
        url: "",
        instructions:
          "Use the selected Claude Code credentials already installed on this machine.",
        callback: Promise.resolve(
          toOAuthCredential(account.credentials, account.source),
        ),
      }
    },
    refresh: async (credential) => {
      const source = sourceFromMetadata(credential)
      const account = selectAccountForSource(
        resolvedDeps.readAccounts(),
        source,
      )
      if (!account) {
        throw new Error(`Claude Code account not found for source: ${source}`)
      }
      const refreshed = resolvedDeps.refreshIfNeeded(account, {
        reloadSource: true,
      })
      if (!refreshed) {
        throw new Error(
          `Failed to refresh Claude Code credentials for source: ${source}`,
        )
      }
      return toOAuthCredential(refreshed, account.source)
    },
    label: (credential) => {
      const source = credential.metadata?.source
      return typeof source === "string" ? source : undefined
    },
  } satisfies PromiseOAuthMethodRegistration

  draft.method.update(registration as never)
}
