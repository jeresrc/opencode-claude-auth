import assert from "node:assert/strict"
import { access, readFile } from "node:fs/promises"
import test from "node:test"
import { applyAnthropicCatalog } from "./catalog.ts"
import plugin from "./index.ts"
import { registerAnthropicIntegration } from "./integration.ts"
import { injectClaudeIdentity } from "./session-context.ts"

test("entrypoint exposes only the default v2 plugin export", async () => {
  const entrypoint = await import("./index.ts")

  assert.deepEqual(Object.keys(entrypoint), ["default"])
})

test("exports the OpenCode v2 plugin contract", () => {
  assert.equal(typeof plugin, "object")
  assert.equal(plugin.id, "opencode-claude-auth")
  assert.equal(typeof plugin.setup, "function")
})

test("setup registers v2 plugin domains then starts rate-limit listener", async () => {
  const order: string[] = []
  const registrations: unknown[] = []
  let subscriptionStopped = false
  const context = {
    integration: {
      transform: async (handler: unknown) => {
        order.push("integration")
        registrations.push(handler)
      },
      reload: async () => {
        order.push("integration:reload")
      },
      connection: {
        active: async () => {
          order.push("integration:active")
          return undefined
        },
        resolve: async () => undefined,
      },
      oauth: {
        connect: async () => {
          throw new Error("unexpected connect")
        },
        status: async () => {
          throw new Error("unexpected status")
        },
      },
    },
    catalog: {
      transform: async (handler: unknown) => {
        order.push("catalog")
        registrations.push(handler)
      },
    },
    session: {
      hook: async (name: string, handler: unknown) => {
        order.push(`session:${name}`)
        registrations.push(handler)
      },
      synthetic: async () => {},
    },
    event: {
      subscribe: () => {
        order.push("event:subscribe")
        return {
          [Symbol.asyncIterator]: () => ({
            next: async () =>
              await new Promise<IteratorResult<unknown>>(() => {}),
            return: async () => {
              subscriptionStopped = true
              return { value: undefined, done: true }
            },
          }),
        }
      },
    },
  } as unknown as Parameters<typeof plugin.setup>[0]

  const cleanup = await plugin.setup(context)

  assert.deepEqual(order, [
    "integration",
    "integration:active",
    "catalog",
    "session:context",
    "event:subscribe",
  ])
  assert.deepEqual(registrations, [
    registerAnthropicIntegration,
    applyAnthropicCatalog,
    injectClaudeIdentity,
  ])
  assert.equal(typeof cleanup, "function")

  await cleanup?.()
  assert.equal(subscriptionStopped, true)
})

test("local v2 docs use plugins file URL and do not document removed v1 auth paths", async () => {
  const docs = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../installation.md", import.meta.url), "utf8"),
  ])
  const combined = docs.join("\n")

  assert.match(
    combined,
    /"plugins"\s*:\s*\[\s*"file:\/\/\/Users\/jeresrc\/dev\/lab\/opencode-claude-auth\/opencode-claude-auth\.js"\s*\]/,
  )
  assert.match(combined, /OpenCode v2/)
  assert.match(combined, /Claude Code credentials/)
  assert.doesNotMatch(combined, /"plugin"\s*:/)
  assert.doesNotMatch(combined, /auth\.loader/)
  assert.doesNotMatch(combined, /auth\.json/)
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
