# V2 Provider Compatibility Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the V2 plugin/provider with the approved OpenCode runtime pins and add a provider-local terminal stream reason compatibility wrapper.

**Architecture:** Keep the V2 plugin shape, Integration V2 boundary, catalog transform, and native provider registration. Pin the runtime dependencies first, adapt only concrete public API drift, then wrap `RouteShape.streamPrepared(prepared, request, runtime)` in `src/provider.ts` so terminal `step-finish` and `finish` events always carry a defined finish reason.

**Tech Stack:** TypeScript ESM, Node test runner with `--experimental-strip-types`, pnpm 10.32.1, Effect 4, `@opencode-ai/ai`, `@opencode-ai/plugin`.

## Global Constraints

- Pin `@opencode-ai/ai` to `0.0.0-next-16255` and `@opencode-ai/plugin` to `1.18.3`.
- `@opencode-ai/ai@1.17.20` is an internal unpublished version; `@opencode-ai/ai@0.0.0-next-16255` matches the local `opencode2 v0.0.0-next-16255` CLI runtime and is reproducible from npm.
- Preserve the current V2 architecture: `Plugin.define`, Integration V2, catalog transform, and native provider registration.
- Add a provider-local stream wrapper that guarantees OpenCode receives a valid finish reason for terminal stream events without changing OpenCode core.
- Wrap `route.streamPrepared` in `src/provider.ts`.
- For `step-finish` and `finish` events, preserve every valid upstream `reason` value exactly as emitted.
- Convert only `undefined` or missing `reason` to `"unknown"`.
- Do not patch OpenCode core or global SDK behavior.
- Keep the fix provider-local so the provider owns the compatibility boundary between Anthropic-style SSE and OpenCode's session event expectations.
- Do not wholesale merge `origin/main` or port the legacy upstream `src/index.ts` architecture.
- Do not mutate Integration state except through existing sync/writeback paths.
- Do not support multiple Claude accounts.
- Do not support suffixed account names or account-specific credential files.
- Do not support `CLAUDE_CONFIG_DIR`, even though upstream includes related behavior.
- Avoid printing raw responses API bodies through `console.warn` in the TUI.
- Preserve the rate-limit notice path so users still receive actionable rate-limit feedback.

---

## Dependency And Plan Order

This is the first implementation plan. `2026-07-26-upstream-safe-ports-plan.md` depends on this plan because it assumes the pinned package surface and successful provider build. `2026-07-26-primary-auth-resilience-plan.md` depends on this plan because it adds auth behavior through the provider fetch path introduced here.

## File Map

- Modify `package.json`: pin `@opencode-ai/ai` to `0.0.0-next-16255`, pin `@opencode-ai/plugin` to `1.18.3`, keep `effect` at `4.0.0-beta.83`, and keep existing scripts.
- Modify `pnpm-lock.yaml`: lock the exact runtime package versions after `pnpm install` resolves them.
- Modify `src/index.ts`: keep the default V2 plugin export and adapt the plugin import to the `@opencode-ai/plugin@1.18.3` public subpath while preserving `Plugin.define` syntax through a namespace import.
- Modify `src/catalog.ts`: keep `applyAnthropicCatalog(draft: CatalogDraft): void` and import `CatalogDraft` from the target plugin public API.
- Modify `src/session-context.ts`: remove the unavailable `@opencode-ai/plugin/v2/session` type import and define the minimal local structural `SessionContext` consumed by `injectClaudeIdentity(context): void`.
- Modify `src/provider.ts`: keep `model(modelID: string, settings: Settings): Model`, wrap the built `AnthropicMessages.route` with `withTerminalFinishReasonFallback`, and export the wrapper helpers for unit tests.
- Modify `src/provider.test.ts`: add deterministic stream wrapper tests that use `Stream.fromIterable`, `Stream.runCollect`, and `Chunk.toArray`.
- Create `src/version-contract.test.ts`: fail fast when package pins drift.
- Create `src/plugin-contract.test.ts`: build the package and import the same default plugin wrapper and provider entrypoint OpenCode loads.

## Task 1: Pin OpenCode Runtime Dependencies

**Files:**
- Create: `src/version-contract.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `package.json` dependency object.
- Produces: exact dependency pins consumed by later tasks: `@opencode-ai/ai@0.0.0-next-16255`, `@opencode-ai/plugin@1.18.3`, `effect@4.0.0-beta.83`.

- [ ] **Step 1: Write the failing dependency contract test**

Create `src/version-contract.test.ts`:

```ts
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

test("OpenCode runtime package versions are pinned to the approved V2 sync targets", async () => {
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { dependencies: Record<string, string> }

  assert.equal(pkg.dependencies["@opencode-ai/ai"], "0.0.0-next-16255")
  assert.equal(pkg.dependencies["@opencode-ai/plugin"], "1.18.3")
  assert.equal(pkg.dependencies.effect, "4.0.0-beta.83")
})
```

- [ ] **Step 2: Run the dependency contract test and verify RED**

Run: `node --test --experimental-strip-types src/version-contract.test.ts`

Expected: FAIL with an assertion showing `@opencode-ai/ai` or `@opencode-ai/plugin` is still `0.0.0-next-15707`.

- [ ] **Step 3: Pin package versions and refresh the lockfile**

Run:

```bash
pnpm add @opencode-ai/ai@0.0.0-next-16255 @opencode-ai/plugin@1.18.3 effect@4.0.0-beta.83 --save-exact
```

If the project registry cannot resolve `@opencode-ai/ai@0.0.0-next-16255`, stop the implementation and report the exact package-manager error. Do not substitute a nearby `0.0.0-next-*` version or a different stable version.

After the command succeeds, the `dependencies` block in `package.json` must be exactly:

```json
{
  "@opencode-ai/ai": "0.0.0-next-16255",
  "@opencode-ai/plugin": "1.18.3",
  "effect": "4.0.0-beta.83"
}
```

- [ ] **Step 4: Run the dependency contract test and install verification**

Run:

```bash
node --test --experimental-strip-types src/version-contract.test.ts
pnpm list @opencode-ai/ai @opencode-ai/plugin --depth 0
```

Expected: PASS for the test, and `pnpm list` prints `@opencode-ai/ai@0.0.0-next-16255` and `@opencode-ai/plugin@1.18.3` under `dependencies`.

- [ ] **Step 5: Commit the dependency pin**

```bash
git add package.json pnpm-lock.yaml src/version-contract.test.ts
git commit -m "test: pin OpenCode runtime contracts"
```

## Task 2: Resolve Public Plugin Type And API Drift

**Files:**
- Modify: `src/index.ts`
- Modify: `src/catalog.ts`
- Modify: `src/session-context.ts`
- Modify: `src/index.test.ts`

**Interfaces:**
- Consumes: `@opencode-ai/plugin@1.18.3` public exports `@opencode-ai/plugin/v2/promise`, `@opencode-ai/plugin/v2/effect/integration`, and `PluginContext`.
- Produces: default export with shape `{ id: "opencode-claude-auth", setup(context): Promise<Cleanup | void> | Cleanup | void }`, `applyAnthropicCatalog(draft: CatalogDraft): void`, and `injectClaudeIdentity(context: SessionContext): void`.

- [ ] **Step 1: Run typecheck and capture the drift failures**

Run: `pnpm run typecheck`

Expected: FAIL with package export/type errors for at least one of these current imports: `@opencode-ai/plugin/v2`, `@opencode-ai/plugin/v2/catalog`, or `@opencode-ai/plugin/v2/session`. If the failure set differs, only adapt real type errors produced by this command.

- [ ] **Step 2: Update the plugin entrypoint to the target public API**

Replace `src/index.ts` with:

```ts
import * as Plugin from "@opencode-ai/plugin/v2/promise"
import { applyAnthropicCatalog } from "./catalog.ts"
import { reconcileConnectedCredential } from "./credential-sync.ts"
import { registerAnthropicIntegration } from "./integration.ts"
import { initLogger } from "./logger.ts"
import {
  startRateLimitNotices,
  type RateLimitNoticeContext,
} from "./rate-limit-notice.ts"
import { injectClaudeIdentity } from "./session-context.ts"

type Cleanup = () => Promise<void> | void

type RuntimeSessionContext = {
  readonly session: {
    readonly hook: (
      name: "context",
      handler: typeof injectClaudeIdentity,
    ) => Promise<unknown> | unknown
  }
}

type RuntimeIntegration = Plugin.PluginContext["integration"] &
  Parameters<typeof reconcileConnectedCredential>[0]

type RuntimePluginContext = Omit<Plugin.PluginContext, "integration"> & {
  readonly integration: RuntimeIntegration
} &
  RateLimitNoticeContext &
  RuntimeSessionContext

type RuntimePlugin = Omit<Plugin.Plugin, "setup"> & {
  readonly setup: (
    context: Plugin.PluginContext,
  ) => Promise<Cleanup | void> | Cleanup | void
}

const plugin: RuntimePlugin = {
  id: "opencode-claude-auth",
  async setup(context) {
    const runtime = context as unknown as RuntimePluginContext
    initLogger()
    await runtime.integration.transform(registerAnthropicIntegration)
    await reconcileConnectedCredential(runtime.integration)
    await runtime.catalog.transform(applyAnthropicCatalog)
    await runtime.session.hook("context", injectClaudeIdentity)
    return await startRateLimitNotices(runtime)
  },
}

export default Plugin.define(plugin as unknown as Plugin.Plugin)
```

This preserves the `Plugin.define` entrypoint syntax while using the public `@opencode-ai/plugin/v2/promise` subpath exported by `@opencode-ai/plugin@1.18.3`. The cast is restricted to the cleanup-return drift: runtime `define(plugin)` returns the object unchanged, while the published type omits cleanup even though this plugin already returns one for the rate-limit listener.

- [ ] **Step 3: Update catalog and session context type imports**

In `src/catalog.ts`, replace the first import with:

```ts
import type { CatalogDraft } from "@opencode-ai/plugin/v2/promise"
```

In `src/session-context.ts`, replace the imports and local context type with:

```ts
import type { SystemPart as SystemPartType } from "@opencode-ai/ai"

const ANTHROPIC_PROVIDER_ID = "anthropic"

export type SessionContext = {
  readonly model: { readonly providerID: string }
  readonly system: SystemPartType[]
}
```

Keep the existing `CLAUDE_CODE_IDENTITY`, `makeClaudeIdentityPart`, `hasExactIdentityText`, and `injectClaudeIdentity(context: SessionContext): void` implementations unchanged below that type.

- [ ] **Step 4: Update the setup contract test for the new public type**

In `src/index.test.ts`, keep the existing assertions and adjust the fake context cast so it still uses the plugin export as the source of truth:

```ts
  } as unknown as Parameters<typeof plugin.setup>[0]

  const cleanup = await plugin.setup(context)
```

If `Parameters<typeof plugin.setup>[0]` becomes `Plugin.PluginContext` without the runtime `event` and `session` fields, keep the `unknown` bridge in the test. Do not remove `session.hook`, `event.subscribe`, or the cleanup assertion from the test because those lock existing V2 runtime behavior.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
node --test --experimental-strip-types src/index.test.ts src/catalog.test.ts src/session-context.test.ts
pnpm run typecheck
```

Expected: PASS for focused tests and typecheck.

- [ ] **Step 6: Commit the plugin API drift fix**

```bash
git add src/index.ts src/catalog.ts src/session-context.ts src/index.test.ts
git commit -m "fix: adapt V2 plugin imports to pinned API"
```

## Task 3: Wrap Terminal Stream Finish Reasons Locally

**Files:**
- Modify: `src/provider.ts`
- Modify: `src/provider.test.ts`

**Interfaces:**
- Consumes: `RouteShape<Body, Prepared>["streamPrepared"]`, `LLMEvent`, `Stream.Stream<LLMEvent, LLMError>`, and existing `model(modelID: string, settings: Settings): Model`.
- Produces: `normalizeTerminalFinishReason(event: LLMEvent): LLMEvent` and `withTerminalFinishReasonFallback<Body, Prepared>(route: RouteShape<Body, Prepared>): RouteShape<Body, Prepared>` used by `model` before returning `route.model({ id: modelID })`.

- [ ] **Step 1: Write the failing stream wrapper tests**

Append these tests to `src/provider.test.ts`:

```ts
test("terminal stream events without reason are normalized to unknown", async () => {
  await runBun(String.raw`
import assert from "node:assert/strict"
import { Chunk, Effect, Stream } from "effect"
import { withTerminalFinishReasonFallback } from "./src/provider.ts"

const rawEvents = [
  { type: "step-finish", index: 0 },
  { type: "finish" },
]
const route = withTerminalFinishReasonFallback({
  streamPrepared: () => Stream.fromIterable(rawEvents),
})
const events = Chunk.toArray(
  await Effect.runPromise(
    Stream.runCollect(route.streamPrepared(undefined, {}, {})),
  ),
)

assert.deepEqual(events, [
  { type: "step-finish", index: 0, reason: "unknown" },
  { type: "finish", reason: "unknown" },
])
`)
})

test("terminal stream events preserve valid reasons", async () => {
  await runBun(String.raw`
import assert from "node:assert/strict"
import { Chunk, Effect, Stream } from "effect"
import { withTerminalFinishReasonFallback } from "./src/provider.ts"

const rawEvents = [
  { type: "step-finish", index: 0, reason: "tool-calls" },
  { type: "finish", reason: "stop" },
  { type: "finish", reason: "length" },
  { type: "finish", reason: "content-filter" },
  { type: "finish", reason: "error" },
  { type: "finish", reason: "unknown" },
]
const route = withTerminalFinishReasonFallback({
  streamPrepared: () => Stream.fromIterable(rawEvents),
})
const events = Chunk.toArray(
  await Effect.runPromise(
    Stream.runCollect(route.streamPrepared(undefined, {}, {})),
  ),
)

assert.deepEqual(
  events.map((event) => event.reason),
  ["tool-calls", "stop", "length", "content-filter", "error", "unknown"],
)
`)
})
```

- [ ] **Step 2: Run the provider tests and verify RED**

Run: `node --test --experimental-strip-types src/provider.test.ts`

Expected: FAIL with `SyntaxError` or `The requested module './src/provider.ts' does not provide an export named 'withTerminalFinishReasonFallback'`.

- [ ] **Step 3: Implement the provider-local wrapper**

Update the imports at the top of `src/provider.ts`:

```ts
import type { LLMEvent, Model } from "@opencode-ai/ai"
import type {
  Definition as ProviderPackageDefinition,
  Settings as ProviderPackageSettings,
} from "@opencode-ai/ai/provider-package"
import { AnthropicMessages } from "@opencode-ai/ai/protocols/anthropic-messages"
import type { AnthropicMessagesBody } from "@opencode-ai/ai/protocols/anthropic-messages"
import {
  Auth,
  HttpTransport,
  RequestExecutor,
  type RouteShape,
  type TransportDef as Transport,
} from "@opencode-ai/ai/route"
import { Effect, Layer, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { createClaudeFetch } from "./claude-fetch.ts"
```

Add these helpers after `withExecutor`:

```ts
type TerminalEvent = Extract<LLMEvent, { type: "step-finish" | "finish" }>

export function normalizeTerminalFinishReason(event: LLMEvent): LLMEvent {
  if (event.type !== "step-finish" && event.type !== "finish") return event

  const terminal = event as TerminalEvent & {
    readonly reason?: TerminalEvent["reason"]
  }
  if (terminal.reason !== undefined) return event

  return { ...event, reason: "unknown" } as LLMEvent
}

export function withTerminalFinishReasonFallback<Body, Prepared>(
  route: RouteShape<Body, Prepared>,
): RouteShape<Body, Prepared> {
  return {
    ...route,
    streamPrepared: (prepared, request, runtime) =>
      route
        .streamPrepared(prepared, request, runtime)
        .pipe(Stream.map(normalizeTerminalFinishReason)),
  }
}
```

Then change the route creation at the end of `model` from:

```ts
  const route = AnthropicMessages.route.with({
```

to:

```ts
  const route = withTerminalFinishReasonFallback(
    AnthropicMessages.route.with({
```

and close the wrapper before returning the model:

```ts
    limits: settings.limits,
  }),
)

return route.model({ id: modelID })
```

- [ ] **Step 4: Run provider tests and typecheck**

Run:

```bash
node --test --experimental-strip-types src/provider.test.ts
pnpm run typecheck
```

Expected: PASS for provider tests and typecheck.

- [ ] **Step 5: Commit the stream compatibility wrapper**

```bash
git add src/provider.ts src/provider.test.ts
git commit -m "fix: normalize terminal stream finish reasons"
```

## Task 4: Add Built Plugin And Provider Contract Load Test

**Files:**
- Create: `src/plugin-contract.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: built files `opencode-claude-auth.js`, `dist/index.js`, `dist/provider.js`, and `package.json` exports `.` and `./provider`.
- Produces: a deterministic load test that proves the compiled default plugin and native provider entrypoint load the way OpenCode expects.

- [ ] **Step 1: Write the failing built-load contract test**

Create `src/plugin-contract.test.ts`:

```ts
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

  const selected = (providerModule.model as (
    modelID: string,
    settings: { apiKey: string; baseURL?: string },
  ) => { id: string; provider: string; route: { id: string } })(
    "claude-sonnet-4-6",
    { apiKey: "oauth-access-token" },
  )

  assert.equal(selected.id, "claude-sonnet-4-6")
  assert.equal(String(selected.provider), "anthropic")
  assert.equal(selected.route.id, "anthropic-messages")
})
```

- [ ] **Step 2: Run the built-load contract and verify RED against unbuilt drift**

Run:

```bash
rm -rf dist
node --test --experimental-strip-types src/plugin-contract.test.ts
```

Expected before Tasks 1-3 are complete: FAIL either during `pnpm run build` with package API/type errors, or during dynamic import with a missing compiled entrypoint. After Tasks 1-3, this same command becomes the GREEN check for this task.

- [ ] **Step 3: Ensure the build script emits the provider and prompt assets**

Keep the build script in `package.json` as:

```json
{
  "scripts": {
    "build": "tsc && cp src/anthropic-prompt.txt dist/"
  }
}
```

Do not add bundling or generated wrappers in this task. The existing `opencode-claude-auth.js` must remain:

```js
export { default } from "./dist/index.js"
```

- [ ] **Step 4: Run contract, full tests, and build**

Run:

```bash
node --test --experimental-strip-types src/plugin-contract.test.ts
pnpm test
pnpm run build
```

Expected: PASS for the contract test, PASS for all tests, and build exits with code 0.

- [ ] **Step 5: Commit the built-load contract**

```bash
git add package.json src/plugin-contract.test.ts
git commit -m "test: load built V2 plugin and provider"
```

## Task 5: Final Provider Preparation Verification

**Files:**
- Modify: `src/provider.test.ts`

**Interfaces:**
- Consumes: `model(modelID: string, settings: Settings): Model`, `LLMClient.prepare(LLM.request(...))`, and `LLM.generate(LLM.request(...))` from `@opencode-ai/ai`.
- Produces: tests proving the pinned provider can still prepare and execute the native Anthropic route with fake fetch after the stream wrapper and API drift fixes.

- [ ] **Step 1: Add a prepared-request smoke test**

Append this test to `src/provider.test.ts`:

```ts
test("pinned native provider can prepare an Anthropic request without sending HTTP", async () => {
  await runBun(String.raw`
import assert from "node:assert/strict"
import { Effect } from "effect"
import { LLM, LLMClient } from "@opencode-ai/ai"
import { model } from "./src/provider.ts"

const selected = model("claude-sonnet-4-6", {
  apiKey: "oauth-access-token",
  baseURL: "https://provider.test/v1",
})
const prepared = await Effect.runPromise(
  LLMClient.prepare(
    LLM.request({ model: selected, prompt: "hello from contract" }),
  ),
)

assert.equal(prepared.route, "anthropic-messages")
assert.equal(prepared.body.model, "claude-sonnet-4-6")
assert.equal(prepared.body.stream, true)
assert.equal(prepared.body.messages.at(-1).role, "user")
`)
})
```

- [ ] **Step 2: Run the focused test and verify RED if preparation drift remains**

Run: `node --test --experimental-strip-types src/provider.test.ts`

Expected before API drift is fully resolved: FAIL with a provider preparation/type/runtime error. After Tasks 1-4 are complete, this test should pass.

- [ ] **Step 3: Fix only real preparation drift if Step 2 exposes it**

If the prepared request uses a different property name than `prepared.route` or `prepared.body`, inspect the pinned `@opencode-ai/ai` declarations and update the assertion names to the real compiled shape. Do not change provider behavior unless the failure proves a real package API incompatibility.

The provider implementation must still end with:

```ts
  return route.model({ id: modelID })
}) satisfies ProviderPackageDefinition<Settings>["model"]
```

- [ ] **Step 4: Run final verification for this plan**

Run:

```bash
pnpm test
pnpm run typecheck
pnpm run build
node --test --experimental-strip-types src/plugin-contract.test.ts src/provider.test.ts
```

Expected: all commands exit with code 0.

- [ ] **Step 5: Commit provider preparation coverage**

```bash
git add src/provider.test.ts
git commit -m "test: verify pinned provider preparation"
```

## Final Verification

Run these exact commands after Task 5:

```bash
pnpm test
pnpm run typecheck
pnpm run build
node --test --experimental-strip-types src/version-contract.test.ts src/plugin-contract.test.ts src/provider.test.ts
git diff --check
```

Expected final state for this plan: all commands pass, the provider compiles against the pinned runtime packages, built plugin/provider imports succeed, and `git status --short` shows only intentional committed changes from this plan.
