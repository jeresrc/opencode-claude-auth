import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import test from "node:test"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

test("built plugin wrapper and provider entrypoint load through package exports", async () => {
  const root = new URL("..", import.meta.url)
  await execFileAsync("pnpm", ["run", "build"], {
    cwd: root,
    env: { ...process.env, CLAUDE_AUTH_DEBUG: "" },
  })

  const cacheBust = `?contract=${Date.now()}`
  const pluginModule = (await import(
    new URL(`../opencode-claude-auth.js${cacheBust}`, import.meta.url).href
  )) as { default?: { id?: string; setup?: unknown } }
  const providerModule = (await import(
    new URL(`../dist/provider.js${cacheBust}`, import.meta.url).href
  )) as { model?: unknown }

  assert.equal(pluginModule.default?.id, "opencode-claude-auth")
  assert.equal(typeof pluginModule.default?.setup, "function")
  assert.equal(typeof providerModule.model, "function")

  const selected = (
    providerModule.model as (
      modelID: string,
      settings: { apiKey: string; baseURL?: string },
    ) => { id: string; provider: string; route: { id: string } }
  )("claude-sonnet-4-6", { apiKey: "oauth-access-token" })

  assert.equal(selected.id, "claude-sonnet-4-6")
  assert.equal(String(selected.provider), "anthropic")
  assert.equal(selected.route.id, "anthropic-messages")
})
