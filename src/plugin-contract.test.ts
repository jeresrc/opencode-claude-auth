import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import test, { before } from "node:test"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const root = new URL("..", import.meta.url)
const src = new URL(".", import.meta.url)

before(async () => {
  await execFileAsync("pnpm", ["run", "build"], {
    cwd: root,
    env: { ...process.env, CLAUDE_AUTH_DEBUG: "" },
  })
})

async function runBun(script: string): Promise<string> {
  const { stdout } = await execFileAsync("bun", ["--eval", script], {
    cwd: src,
    env: { ...process.env, CLAUDE_AUTH_DEBUG: "" },
  })
  return stdout
}

test("built plugin wrapper and provider entrypoint load real route through Bun", async () => {
  const cacheBust = `?contract=${Date.now()}`
  await runBun(String.raw`
import assert from "node:assert/strict"

const pluginModule = await import("../opencode-claude-auth.js${cacheBust}")
const providerModule = await import("../dist/provider.js${cacheBust}")

assert.equal(pluginModule.default?.id, "opencode-claude-auth")
assert.equal(typeof pluginModule.default?.setup, "function")
assert.equal(typeof providerModule.model, "function")

const selected = providerModule.model("claude-sonnet-4-6", {
  apiKey: "oauth-access-token",
})

assert.equal(selected.id, "claude-sonnet-4-6")
assert.equal(String(selected.provider), "anthropic")
assert.equal(selected.route.id, "anthropic-messages")
assert.equal(selected.route.provider, "anthropic")
assert.equal(selected.route.protocol, "anthropic-messages")
assert.deepEqual(selected.route.endpoint, {
  baseURL: "https://api.anthropic.com/v1",
  path: "/messages",
})
assert.equal(typeof selected.route.transport, "object")
assert.equal(selected.route.transport.id, "http-json")
assert.equal(typeof selected.route.transport.prepare, "function")
assert.equal(typeof selected.route.transport.frames, "function")
assert.equal(typeof selected.route.model, "function")
assert.equal(typeof selected.route.streamPrepared, "function")
`)
})

test("built provider rejects non-Bun construction instead of returning a fake route", async () => {
  const cacheBust = `?contract=${Date.now()}`
  const providerModule = (await import(
    new URL(`../dist/provider.js${cacheBust}`, import.meta.url).href
  )) as { model?: unknown }

  assert.equal(typeof providerModule.model, "function")
  assert.throws(
    () =>
      (
        providerModule.model as (
          modelID: string,
          settings: { apiKey: string; baseURL?: string },
        ) => unknown
      )("claude-sonnet-4-6", { apiKey: "oauth-access-token" }),
    /OpenCode provider runtime is unavailable/,
  )
})
