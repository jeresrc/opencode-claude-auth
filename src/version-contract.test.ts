import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

test("OpenCode runtime package versions are pinned to the approved V2 sync targets", async () => {
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { dependencies: Record<string, string> }

  assert.equal(pkg.dependencies["@opencode-ai/ai"], "0.0.0-beta-17595")
  assert.equal(pkg.dependencies["@opencode-ai/plugin"], "0.0.0-beta-17595")
  assert.equal(pkg.dependencies.effect, "4.0.0-beta.107")
})
