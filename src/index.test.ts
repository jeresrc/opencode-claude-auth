import assert from "node:assert/strict"
import test from "node:test"
import plugin from "./index.ts"

test("exports the OpenCode v2 plugin contract", () => {
  assert.equal(typeof plugin, "object")
  assert.equal(plugin.id, "opencode-claude-auth")
  assert.equal(typeof plugin.setup, "function")
})
