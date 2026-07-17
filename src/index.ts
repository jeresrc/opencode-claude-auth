import { Plugin } from "@opencode-ai/plugin/v2"
import { applyAnthropicCatalog } from "./catalog.ts"
import { registerAnthropicIntegration } from "./integration.ts"
import { initLogger } from "./logger.ts"
import { injectClaudeIdentity } from "./session-context.ts"

export {
  buildRequestHeaders,
  buildRequestUrl,
  createClaudeFetch,
  fetchWithRetry,
} from "./claude-fetch.ts"

export default Plugin.define({
  id: "opencode-claude-auth",
  async setup(context) {
    initLogger()
    await context.integration.transform(registerAnthropicIntegration)
    await context.catalog.transform(applyAnthropicCatalog)
    await context.session.hook("context", injectClaudeIdentity)
  },
})
