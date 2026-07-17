import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import plugin from "./index.ts"

test("exports the OpenCode v2 plugin contract", () => {
  assert.equal(typeof plugin, "object")
  assert.equal(plugin.id, "opencode-claude-auth")
  assert.equal(typeof plugin.setup, "function")
})

test("wrapper only re-exports the default plugin from dist", async () => {
  const wrapper = await readFile(
    new URL("../opencode-claude-auth.js", import.meta.url),
    "utf8",
  )

  assert.equal(wrapper.trim(), 'export { default } from "./dist/index.js"')
})

test("package exports only implemented entrypoints", async () => {
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { exports: Record<string, unknown> }

  assert.ok(pkg.exports["."])
  assert.ok(pkg.exports["./server"])
  assert.equal(pkg.exports["./provider"], undefined)
})
