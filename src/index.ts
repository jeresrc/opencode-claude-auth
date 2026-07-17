import * as Plugin from "@opencode-ai/plugin/v2/promise"
import { initLogger } from "./logger.ts"

export default Plugin.define({
  id: "opencode-claude-auth",
  setup() {
    initLogger()
  },
})
