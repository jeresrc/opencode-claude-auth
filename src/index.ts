import * as Plugin from "@opencode-ai/plugin/v2/promise"
import { applyAnthropicCatalog } from "./catalog.ts"
import { reconcileConnectedCredential } from "./credential-sync.ts"
import { startProactiveRefresh } from "./credentials.ts"
import { registerAnthropicIntegration } from "./integration.ts"
import { initLogger } from "./logger.ts"
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

type RuntimeIntegration = Plugin.PluginContext["integration"] &
  Parameters<typeof reconcileConnectedCredential>[0]

type RuntimePluginContext = Omit<Plugin.PluginContext, "integration"> & {
  readonly integration: RuntimeIntegration
} & RateLimitNoticeContext &
  RuntimeSessionContext

type RuntimePlugin = Omit<Plugin.Plugin, "setup"> & {
  readonly setup: (
    context: Plugin.PluginContext,
  ) => Promise<Cleanup | void> | Cleanup | void
}

const plugin: RuntimePlugin = {
  id: "opencode-claude-auth",
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
}

export default Plugin.define(plugin as unknown as Plugin.Plugin)
