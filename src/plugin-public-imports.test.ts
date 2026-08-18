import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

type PackageJson = {
  exports?: Record<string, unknown>
}

const sourceDir = path.dirname(fileURLToPath(import.meta.url))
const pluginEntry = fileURLToPath(import.meta.resolve("@opencode-ai/plugin"))
const pluginRoot = path.dirname(path.dirname(path.dirname(pluginEntry)))
const pluginPackage = JSON.parse(
  readFileSync(path.join(pluginRoot, "package.json"), "utf8"),
) as PackageJson
const pluginExports = new Set(Object.keys(pluginPackage.exports ?? {}))
const pluginSubpathImport =
  /\bimport\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']@opencode-ai\/plugin(\/[^"']+)["']/g

function isPublicSubpath(subpath: string): boolean {
  if (pluginExports.has(subpath)) return true
  return [...pluginExports].some(
    (pattern) =>
      pattern.endsWith("*") && subpath.startsWith(pattern.slice(0, -1)),
  )
}

test("test files only import public @opencode-ai/plugin subpaths", () => {
  const invalidImports: string[] = []

  for (const filename of readdirSync(sourceDir)) {
    if (!filename.endsWith(".test.ts")) continue

    const source = readFileSync(path.join(sourceDir, filename), "utf8")
    for (const match of source.matchAll(pluginSubpathImport)) {
      const subpath = `.${match[1]}`
      if (!isPublicSubpath(subpath)) {
        invalidImports.push(`${filename}: @opencode-ai/plugin${match[1]}`)
      }
    }
  }

  assert.deepEqual(invalidImports, [])
})
