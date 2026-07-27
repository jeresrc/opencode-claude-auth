import assert from "node:assert/strict"
import { access, readFile } from "node:fs/promises"
import test from "node:test"
import { applyAnthropicCatalog } from "./catalog.ts"
import { initAccounts } from "./credentials.ts"
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
  let subscriptionStopCount = 0
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  const proactiveTimer = { unref: () => order.push("proactive:unref") }
  let clearedTimer: unknown
  initAccounts([
    {
      label: "Claude",
      source: "Claude Code-credentials",
      credentials: {
        accessToken: "fresh-token",
        refreshToken: "fresh-refresh",
        expiresAt: Date.now() + 2 * 60 * 60_000,
      },
    },
  ])
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
              subscriptionStopCount++
              return { value: undefined, done: true }
            },
          }),
        }
      },
    },
  } as unknown as Parameters<typeof plugin.setup>[0]

  globalThis.setInterval = ((callback: () => void, intervalMs: number) => {
    order.push(`proactive:setInterval:${intervalMs}`)
    assert.equal(typeof callback, "function")
    return proactiveTimer as never
  }) as typeof setInterval
  globalThis.clearInterval = ((timer: unknown) => {
    order.push("proactive:clearInterval")
    clearedTimer = timer
  }) as typeof clearInterval

  try {
    const cleanup = await plugin.setup(context)

    assert.deepEqual(order, [
      "integration",
      "integration:active",
      "proactive:setInterval:300000",
      "proactive:unref",
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
    await cleanup?.()
    assert.equal(clearedTimer, proactiveTimer)
    assert.equal(subscriptionStopped, true)
    assert.equal(subscriptionStopCount, 1)
    assert.deepEqual(order.at(-1), "proactive:clearInterval")
  } finally {
    initAccounts([])
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
  }
})

test("setup reconciliation consumes the registered OAuth method with Promise semantics", async () => {
  const calls: string[] = []
  const expiresAt = Date.now() + 2 * 60 * 60_000
  let registration:
    | {
        authorize: (inputs: Record<string, string>) => Promise<{
          mode: "auto"
          callback: Promise<unknown>
        }>
      }
    | undefined

  initAccounts([
    {
      label: "Claude",
      source: "Claude Code-credentials",
      credentials: {
        accessToken: "fresh-token",
        refreshToken: "fresh-refresh",
        expiresAt,
      },
    },
  ])

  const context = {
    integration: {
      transform: async (handler: typeof registerAnthropicIntegration) => {
        calls.push("transform")
        handler(
          {
            list: () => [{ id: "anthropic", name: "Old Anthropic" }],
            get: () => ({ id: "anthropic", name: "Old Anthropic" }),
            update: () => {},
            remove: () => {},
            method: {
              list: () => [],
              update: (input: typeof registration) => {
                registration = input
                calls.push("method:update")
              },
              remove: () => {},
            },
          },
          {
            readAccounts: () => [
              {
                label: "Claude",
                source: "Claude Code-credentials",
                credentials: {
                  accessToken: "fresh-token",
                  refreshToken: "fresh-refresh",
                  expiresAt,
                },
              },
            ],
            refreshIfNeeded: () => null,
          },
        )
      },
      reload: async () => {
        calls.push("reload")
      },
      connection: {
        active: async () => ({
          type: "credential",
          id: "credential-id",
          label: "Anthropic account",
        }),
        resolve: async () => ({
          type: "oauth",
          methodID: "claude-code",
          access: "legacy-access",
          refresh: "legacy-refresh",
          expires: 1,
          metadata: { source: "Claude Code-credentials-deadbeef" },
        }),
      },
      oauth: {
        connect: async (input: { inputs: Record<string, string> }) => {
          calls.push("connect")
          assert.ok(registration, "expected registered OAuth method")
          const authorization = await registration
            .authorize(input.inputs)
            .then((value) => value)
          const credential = await authorization.callback.then((value) => value)
          assert.deepEqual(credential, {
            type: "oauth",
            methodID: "claude-code",
            access: "fresh-token",
            refresh: "fresh-refresh",
            expires: expiresAt,
            metadata: { source: "Claude Code-credentials" },
          })
          calls.push("connect:authorized")
          return { data: { attemptID: "attempt-id", mode: authorization.mode } }
        },
        status: async () => {
          calls.push("status")
          return { data: { status: "complete" } }
        },
      },
    },
    catalog: {
      transform: async () => {
        calls.push("catalog")
      },
    },
    session: {
      hook: async () => {
        calls.push("session")
      },
      synthetic: async () => {},
    },
    event: {
      subscribe: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async () =>
            await new Promise<IteratorResult<unknown>>(() => {}),
          return: async () => ({ value: undefined, done: true }),
        }),
      }),
    },
  } as unknown as Parameters<typeof plugin.setup>[0]

  try {
    const cleanup = await plugin.setup(context)
    await cleanup?.()
  } finally {
    initAccounts([])
  }

  assert.deepEqual(calls.slice(0, 6), [
    "transform",
    "method:update",
    "reload",
    "connect",
    "connect:authorized",
    "status",
  ])
})

test("setup cleans up proactive refresh when a later registration fails", async () => {
  const error = new Error("catalog registration failed")
  const registrations: unknown[] = []
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  const proactiveTimer = { unref: () => {} }
  const activeTimers = new Map<unknown, () => void>()
  let clearedTimer: unknown
  let callbackRuns = 0

  initAccounts([
    {
      label: "Claude",
      source: "Claude Code-credentials",
      credentials: {
        accessToken: "fresh-token",
        refreshToken: "fresh-refresh",
        expiresAt: Date.now() + 2 * 60 * 60_000,
      },
    },
  ])
  const context = {
    integration: {
      transform: async (handler: unknown) => {
        registrations.push(handler)
      },
      reload: async () => {},
      connection: {
        active: async () => undefined,
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
      transform: async () => {
        throw error
      },
    },
    session: {
      hook: async () => {
        throw new Error("session hook should not run")
      },
      synthetic: async () => {},
    },
    event: {
      subscribe: () => {
        throw new Error("rate-limit listener should not start")
      },
    },
  } as unknown as Parameters<typeof plugin.setup>[0]

  globalThis.setInterval = ((callback: () => void) => {
    activeTimers.set(proactiveTimer, () => {
      callbackRuns++
      callback()
    })
    return proactiveTimer as never
  }) as typeof setInterval
  globalThis.clearInterval = ((timer: unknown) => {
    clearedTimer = timer
    activeTimers.delete(timer)
  }) as typeof clearInterval

  try {
    await assert.rejects(() => plugin.setup(context), error)

    assert.deepEqual(registrations, [registerAnthropicIntegration])
    assert.equal(clearedTimer, proactiveTimer)
    assert.equal(activeTimers.size, 0)
    for (const callback of activeTimers.values()) callback()
    assert.equal(callbackRuns, 0)
  } finally {
    initAccounts([])
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
  }
})

test("setup preserves the original registration error when rollback cleanup throws", async () => {
  const setupError = new Error("catalog registration failed")
  const cleanupError = new Error("cleanup failed")
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval

  initAccounts([
    {
      label: "Claude",
      source: "Claude Code-credentials",
      credentials: {
        accessToken: "fresh-token",
        refreshToken: "fresh-refresh",
        expiresAt: Date.now() + 2 * 60 * 60_000,
      },
    },
  ])
  const context = {
    integration: {
      transform: async () => {},
      reload: async () => {},
      connection: {
        active: async () => undefined,
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
      transform: async () => {
        throw setupError
      },
    },
    session: {
      hook: async () => {
        throw new Error("session hook should not run")
      },
      synthetic: async () => {},
    },
    event: {
      subscribe: () => {
        throw new Error("rate-limit listener should not start")
      },
    },
  } as unknown as Parameters<typeof plugin.setup>[0]

  globalThis.setInterval = (() =>
    ({ unref: () => {} }) as never) as typeof setInterval
  globalThis.clearInterval = (() => {
    throw cleanupError
  }) as typeof clearInterval

  try {
    await assert.rejects(() => plugin.setup(context), setupError)
  } finally {
    initAccounts([])
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
  }
})

test("normal teardown attempts every cleanup and reports cleanup failures", async () => {
  const order: string[] = []
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval

  initAccounts([
    {
      label: "Claude",
      source: "Claude Code-credentials",
      credentials: {
        accessToken: "fresh-token",
        refreshToken: "fresh-refresh",
        expiresAt: Date.now() + 2 * 60 * 60_000,
      },
    },
  ])
  const context = {
    integration: {
      transform: async () => {},
      reload: async () => {},
      connection: {
        active: async () => undefined,
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
      transform: async () => {},
    },
    session: {
      hook: async () => {},
      synthetic: async () => {},
    },
    event: {
      subscribe: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async () =>
            await new Promise<IteratorResult<unknown>>(() => {}),
          return: async () => {
            order.push("rate-limit:cleanup")
            return { value: undefined, done: true }
          },
        }),
      }),
    },
  } as unknown as Parameters<typeof plugin.setup>[0]

  globalThis.setInterval = (() =>
    ({ unref: () => {} }) as never) as typeof setInterval
  globalThis.clearInterval = (() => {
    order.push("proactive:cleanup")
    throw new Error("proactive cleanup failed")
  }) as typeof clearInterval

  try {
    const cleanup = await plugin.setup(context)

    await assert.rejects(
      () => cleanup?.(),
      (error) =>
        error instanceof AggregateError &&
        error.errors.length === 1 &&
        error.errors[0] instanceof Error &&
        error.errors[0].message === "proactive cleanup failed",
    )
    assert.deepEqual(order, ["proactive:cleanup", "rate-limit:cleanup"])
  } finally {
    initAccounts([])
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
  }
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
