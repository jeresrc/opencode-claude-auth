import { Plugin } from "@opencode-ai/plugin/v2"
import { applyAnthropicCatalog } from "./catalog.ts"
import { registerAnthropicIntegration } from "./integration.ts"
import { initLogger } from "./logger.ts"
import { injectClaudeIdentity } from "./session-context.ts"

export default Plugin.define({
  id: "opencode-claude-auth",
  async setup(context) {
    initLogger()
    await context.catalog.transform(applyAnthropicCatalog)
    await context.session.hook("context", injectClaudeIdentity)
    await context.integration.transform(registerAnthropicIntegration)
  },
})
