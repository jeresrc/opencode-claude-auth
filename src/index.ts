import * as Plugin from "@opencode-ai/plugin/v2/promise"
import { registerAnthropicIntegration } from "./integration.ts"
import { initLogger } from "./logger.ts"

export default Plugin.define({
  id: "opencode-claude-auth",
  async setup(context) {
    initLogger()
    await context.integration.transform(registerAnthropicIntegration)
  },
})
