import assert from "node:assert/strict"
import { access, readFile } from "node:fs/promises"
import test from "node:test"
import plugin from "./index.ts"

test("entrypoint exposes only the default v2 plugin export", async () => {
  const entrypoint = await import("./index.ts")

  assert.deepEqual(Object.keys(entrypoint), ["default"])
})

test("exports the OpenCode v2 plugin contract", () => {
  assert.equal(typeof plugin, "object")
  assert.equal(plugin.id, "opencode-claude-auth")
  assert.equal(typeof plugin.setup, "function")
})

test("setup registers v2 plugin domains in Integration, catalog, session order", async () => {
  const order: string[] = []
  const context = {
    integration: {
      transform: async () => {
        order.push("integration")
      },
    },
    catalog: {
      transform: async () => {
        order.push("catalog")
      },
    },
    session: {
      hook: async (name: string) => {
        order.push(`session:${name}`)
      },
    },
  } as unknown as Parameters<typeof plugin.setup>[0]

  await plugin.setup(context)

  assert.deepEqual(order, ["integration", "catalog", "session:context"])
})

test("wrapper only re-exports the default plugin from dist", async () => {
  const wrapper = await readFile(
    new URL("../opencode-claude-auth.js", import.meta.url),
    "utf8",
  )

  assert.equal(wrapper.trim(), 'export { default } from "./dist/index.js"')
})

test("package exports implemented entrypoints including the native provider", async () => {
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { exports: Record<string, unknown> }

  assert.ok(pkg.exports["."])
  assert.ok(pkg.exports["./server"])
  assert.deepEqual(pkg.exports["./provider"], {
    types: "./dist/provider.d.ts",
    import: "./dist/provider.js",
  })
  await access(new URL("./provider.ts", import.meta.url))
})
