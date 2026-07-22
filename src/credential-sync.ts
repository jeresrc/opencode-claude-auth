import { readAllClaudeAccounts, type ClaudeAccount } from "./keychain.ts"
import { log } from "./logger.ts"

type ConnectionInfo =
  | { type: "credential"; id: string; label: string }
  | { type: "env"; name: string }

type CredentialValue =
  | {
      type: "oauth"
      methodID: string
      access: string
      refresh: string
      expires: number
      metadata?: Record<string, unknown>
    }
  | { type: "key"; key: string; metadata?: Record<string, unknown> }

export type ConnectionLookup = {
  active: (integrationID: string) => Promise<ConnectionInfo | undefined>
  resolve: (connection: ConnectionInfo) => Promise<CredentialValue | undefined>
}

type AttemptStatus =
  | { status: "pending" }
  | { status: "complete" }
  | { status: "expired" }
  | { status: "failed"; message: string }

type IntegrationClient = {
  reload: () => Promise<void>
  connection: ConnectionLookup
  oauth: {
    connect: (input: {
      integrationID: string
      methodID: string
      inputs: Record<string, string>
      label?: string
    }) => Promise<{
      data: { attemptID: string; mode: "auto" | "code" }
    }>
    status: (input: {
      integrationID: string
      attemptID: string
    }) => Promise<{ data: AttemptStatus }>
  }
}

type Dependencies = {
  readAccounts: () => ClaudeAccount[]
  sleep: (milliseconds: number) => Promise<void>
  maxStatusChecks: number
}

const defaultDependencies: Dependencies = {
  readAccounts: readAllClaudeAccounts,
  sleep: async (milliseconds) =>
    await new Promise((resolve) => setTimeout(resolve, milliseconds)),
  maxStatusChecks: 200,
}

export async function reconcileConnectedCredential(
  integration: IntegrationClient,
  dependencies: Partial<Dependencies> = {},
): Promise<boolean> {
  const resolvedDependencies = { ...defaultDependencies, ...dependencies }
  try {
    const active = await integration.connection.active("anthropic")
    if (!active || active.type !== "credential") return false

    const credential = await integration.connection.resolve(active)
    if (
      !credential ||
      credential.type !== "oauth" ||
      credential.methodID !== "claude-code"
    ) {
      return false
    }

    const source = credential.metadata?.source
    if (typeof source !== "string" || source.length === 0) return false

    const account = resolvedDependencies
      .readAccounts()
      .find((candidate) => candidate.source === source)
    if (!account) {
      log("active_account_missing", { source })
      return false
    }

    if (
      credential.access === account.credentials.accessToken &&
      credential.refresh === account.credentials.refreshToken &&
      credential.expires === account.credentials.expiresAt
    ) {
      log("active_account_current", { source })
      return false
    }

    // Plugin transforms are batched during startup. Materialize the OAuth
    // method before asking V2 to persist the replacement credential.
    await integration.reload()
    const attempt = await integration.oauth.connect({
      integrationID: "anthropic",
      methodID: "claude-code",
      inputs: { source },
      label: active.label,
    })
    if (attempt.data.mode !== "auto") {
      throw new Error("Claude Code credential reconciliation was not automatic")
    }

    for (let check = 0; check < resolvedDependencies.maxStatusChecks; check++) {
      const status = await integration.oauth.status({
        integrationID: "anthropic",
        attemptID: attempt.data.attemptID,
      })
      if (status.data.status === "complete") {
        log("active_account_reconciled", { source })
        return true
      }
      if (status.data.status === "failed") {
        throw new Error(status.data.message)
      }
      if (status.data.status === "expired") {
        throw new Error("Claude Code credential reconciliation expired")
      }
      await resolvedDependencies.sleep(25)
    }

    throw new Error("Claude Code credential reconciliation timed out")
  } catch (error) {
    log("active_account_reconciliation_failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}
