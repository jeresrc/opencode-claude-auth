import { Plugin } from "@opencode/plugin"
import { applyAnthropicCatalog } from "./catalog.ts"
import { reconcileConnectedCredential } from "./credential-sync.ts"
import { startProactiveRefresh, syncAuthJson } from "./credentials.ts"
import { registerAnthropicIntegration } from "./integration.ts"
import { initLogger, log } from "./logger.ts"
import {
  startRateLimitNotices,
  type RateLimitNoticeContext,
} from "./rate-limit-notice.ts"
import { injectClaudeIdentity } from "./session-context.ts"

type Cleanup = () => Promise<void> | void

type RuntimeSessionContext = {
  readonly session: {
    readonly hook: (
      name: "context",
      handler: typeof injectClaudeIdentity,
    ) => Promise<unknown> | unknown
  }
}

type RuntimeIntegration = Plugin.Context["integration"] &
  Parameters<typeof reconcileConnectedCredential>[0]

type RuntimePluginContext = Omit<Plugin.Context, "integration"> & {
  readonly integration: RuntimeIntegration
} & RateLimitNoticeContext &
  RuntimeSessionContext

type RuntimePlugin = Omit<Plugin.Plugin, "setup"> & {
  readonly setup: (
    context: Plugin.Context,
  ) => Promise<Cleanup | void> | Cleanup | void
}

const plugin: RuntimePlugin = {
  id: "opencode-claude-auth",
  async setup(context) {
    const runtime = context as unknown as RuntimePluginContext
    const cleanups: Cleanup[] = []
    let cleaned = false

    const cleanup = async (options: { suppressErrors?: boolean } = {}) => {
      if (cleaned) return
      cleaned = true
      const failures: unknown[] = []
      for (const stop of cleanups) {
        try {
          await stop()
        } catch (error) {
          failures.push(error)
          log("cleanup_failed", {
            error: error instanceof Error ? error.name : typeof error,
          })
        }
      }
      if (!options.suppressErrors && failures.length > 0) {
        throw new AggregateError(failures, "Plugin cleanup failed")
      }
    }

    try {
      initLogger()
      await runtime.integration.transform(registerAnthropicIntegration)
      cleanups.push(startProactiveRefresh({ sync: syncAuthJson }))
      await reconcileConnectedCredential(runtime.integration)
      await runtime.provider.transform(applyAnthropicCatalog)
      await runtime.session.hook("context", injectClaudeIdentity)
      cleanups.push(await startRateLimitNotices(runtime))

      return cleanup
    } catch (error) {
      await cleanup({ suppressErrors: true })
      throw error
    }
  },
}

export default Plugin.define(plugin as unknown as Plugin.Plugin)
