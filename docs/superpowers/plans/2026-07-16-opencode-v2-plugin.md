# OpenCode v2 Claude Auth Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port `opencode-claude-auth` to an OpenCode v2-only local plugin that authenticates Anthropic requests exclusively through an active v2 Integration connection.

**Architecture:** A Promise v2 plugin registers an Anthropic Integration, rewrites Anthropic catalog models to a local `file://` provider, and injects Claude Code identity through the session context hook. The provider reuses OpenCode's public `AnthropicMessages.route` and parser while replacing its HTTP executor with a private executor backed by the plugin's request/response transforming fetch.

**Tech Stack:** TypeScript ESM, Node test runner, `@opencode-ai/plugin/v2`, `@opencode-ai/ai`, Effect 4, pnpm.

---

## File Map

- Modify `package.json`: pin the OpenCode v2 runtime packages, expose the provider subpath, and add a typecheck script.
- Modify `pnpm-lock.yaml`: lock the v2 runtime dependencies.
- Replace `src/index.ts`: compose only the OpenCode v2 Integration, catalog, and session registrations.
- Create `src/integration.ts`: adapt Claude Code accounts and refresh into the v2 OAuth Integration contract.
- Create `src/catalog.ts`: redirect only the Anthropic provider and models to the local provider file.
- Create `src/session-context.ts`: inject Claude Code identity for Anthropic requests.
- Create `src/claude-fetch.ts`: own final HTTP request/response transformation and bounded retries.
- Create `src/provider.ts`: expose the custom provider model and private request executor.
- Replace `src/index.test.ts`: remove mirrored v1 tests and exercise the actual v2 plugin composition.
- Create `src/integration.test.ts`: test OAuth prompts, authorization, metadata, and refresh through the Effect bridge.
- Create `src/catalog.test.ts`: test provider/model package rewriting and zero costs.
- Create `src/session-context.test.ts`: test Anthropic-only idempotent identity injection.
- Create `src/claude-fetch.test.ts`: migrate HTTP helper tests and test the fixed Integration token path.
- Create `src/provider.test.ts`: test the provider contract and an end-to-end native Anthropic route with fake fetch.
- Modify `opencode-claude-auth.js`: export only the compiled v2 plugin default.
- Modify `README.md` and `installation.md`: document local v2 build, Integration connection, and smoke usage.

## Task 1: Establish The V2 Runtime Contract

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Replace: `src/index.ts`
- Replace: `src/index.test.ts`
- Modify: `opencode-claude-auth.js`

- [ ] **Step 1: Replace the v1 test with a failing v2 export test**

Replace `src/index.test.ts` with:

```ts
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import plugin from "./index.ts"

describe("OpenCode v2 plugin contract", () => {
  it("exports a v2 plugin definition instead of a v1 plugin function", () => {
    assert.equal(typeof plugin, "object")
    assert.equal(plugin.id, "opencode-claude-auth")
    assert.equal(typeof plugin.setup, "function")
  })
})
```

- [ ] **Step 2: Run the focused test and verify the v1 export fails**

Run: `node --test --experimental-strip-types src/index.test.ts`

Expected: FAIL because the current default export is a v1 function.

- [ ] **Step 3: Install the exact packages used by the cloned v2 snapshot**

Run:

```bash
pnpm add @opencode-ai/ai@1.17.20 @opencode-ai/plugin@1.18.3 effect@4.0.0-beta.83
```

Update `package.json` so `@opencode-ai/ai`, `@opencode-ai/plugin`, and `effect` are runtime dependencies, remove the old `@opencode-ai/plugin` dev dependency, retain the existing tooling dev dependencies, and add:

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./opencode-claude-auth.js"
    },
    "./server": {
      "types": "./dist/index.d.ts",
      "import": "./opencode-claude-auth.js"
    },
    "./provider": {
      "types": "./dist/provider.d.ts",
      "import": "./dist/provider.js"
    }
  }
}
```

- [ ] **Step 4: Add the minimal v2 plugin definition**

Replace `src/index.ts` with:

```ts
import { Plugin } from "@opencode-ai/plugin/v2"
import { initLogger } from "./logger.ts"

const plugin = Plugin.define({
  id: "opencode-claude-auth",
  setup() {
    initLogger()
  },
})

export default plugin
```

Replace `opencode-claude-auth.js` with:

```js
export { default } from "./dist/index.js"
```

- [ ] **Step 5: Run the focused test and typecheck**

Run:

```bash
node --test --experimental-strip-types src/index.test.ts
pnpm run typecheck
```

Expected: the focused test passes and TypeScript exits with code 0.

- [ ] **Step 6: Commit the v2 contract**

```bash
git add package.json pnpm-lock.yaml opencode-claude-auth.js src/index.ts src/index.test.ts
git commit -m "feat: establish OpenCode v2 plugin contract"
```

## Task 2: Register Claude Accounts As A V2 Integration

**Files:**
- Create: `src/integration.ts`
- Create: `src/integration.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write failing credential and authorization tests**

Create `src/integration.test.ts` with tests against the real registration object rather than mirrored logic:

```ts
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Effect } from "effect"
import type { ClaudeAccount, ClaudeCredentials } from "./keychain.ts"
import {
  CLAUDE_CODE_METHOD_ID,
  registerAnthropicIntegration,
  toOAuthCredential,
} from "./integration.ts"

const credentials: ClaudeCredentials = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  expiresAt: 1_800_000_000_000,
}

const accounts: ClaudeAccount[] = [
  { label: "Claude Pro", source: "Claude Code-credentials", credentials },
  {
    label: "Claude Max",
    source: "Claude Code-credentials-ab12",
    credentials: { ...credentials, accessToken: "access-2" },
  },
]

function captureRegistration() {
  let registration: Record<string, unknown> | undefined
  const draft = {
    update(_id: string, update: (value: { name: string }) => void) {
      update({ name: "anthropic" })
    },
    method: {
      update(value: Record<string, unknown>) {
        registration = value
      },
    },
  }
  registerAnthropicIntegration(draft as never, {
    readAccounts: () => accounts,
    refreshAccount: (account) => ({ ...account.credentials, accessToken: "refreshed" }),
  })
  assert.ok(registration)
  return registration
}

describe("Anthropic Integration", () => {
  it("converts a Claude account to the exact v2 OAuth credential", () => {
    assert.deepEqual(toOAuthCredential(credentials, accounts[0].source), {
      type: "oauth",
      methodID: CLAUDE_CODE_METHOD_ID,
      access: "access-1",
      refresh: "refresh-1",
      expires: 1_800_000_000_000,
      metadata: { source: "Claude Code-credentials" },
    })
  })

  it("exposes one select option per discovered account", () => {
    const registration = captureRegistration()
    const method = registration.method as {
      prompts: Array<{ options: Array<{ value: string }> }>
    }
    assert.deepEqual(
      method.prompts[0].options.map((option) => option.value),
      accounts.map((account) => account.source),
    )
  })

  it("bridges authorize and callback through Effect", async () => {
    const registration = captureRegistration()
    const authorize = registration.authorize as (
      inputs: Record<string, string>,
    ) => Effect.Effect<{
      mode: "auto"
      callback: Effect.Effect<ReturnType<typeof toOAuthCredential>>
    }>
    const authorization = await Effect.runPromise(
      authorize({ account: accounts[1].source }),
    )
    assert.equal(authorization.mode, "auto")
    assert.equal(
      (await Effect.runPromise(authorization.callback)).access,
      "access-2",
    )
  })

  it("refreshes the source recorded in metadata", async () => {
    const registration = captureRegistration()
    const refresh = registration.refresh as (
      credential: ReturnType<typeof toOAuthCredential>,
    ) => Effect.Effect<ReturnType<typeof toOAuthCredential>>
    const result = await Effect.runPromise(
      refresh(toOAuthCredential(credentials, accounts[0].source)),
    )
    assert.equal(result.access, "refreshed")
    assert.deepEqual(result.metadata, { source: accounts[0].source })
  })
})
```

- [ ] **Step 2: Run the Integration tests and verify the missing module failure**

Run: `node --test --experimental-strip-types src/integration.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/integration.ts`.

- [ ] **Step 3: Implement the Integration adapter with the snapshot's Effect bridge**

Create `src/integration.ts`:

```ts
import type { IntegrationDraft } from "@opencode-ai/plugin/v2/integration"
import { Effect } from "effect"
import { refreshIfNeeded } from "./credentials.ts"
import {
  readAllClaudeAccounts,
  type ClaudeAccount,
  type ClaudeCredentials,
} from "./keychain.ts"

export const ANTHROPIC_INTEGRATION_ID = "anthropic"
export const CLAUDE_CODE_METHOD_ID = "claude-code"

type Dependencies = {
  readonly readAccounts: () => ClaudeAccount[]
  readonly refreshAccount: (account: ClaudeAccount) => ClaudeCredentials | null
}

const defaults: Dependencies = {
  readAccounts: readAllClaudeAccounts,
  refreshAccount: (account) =>
    refreshIfNeeded({
      ...account,
      credentials: { ...account.credentials, expiresAt: 0 },
    }),
}

export function toOAuthCredential(creds: ClaudeCredentials, source: string) {
  return {
    type: "oauth" as const,
    methodID: CLAUDE_CODE_METHOD_ID,
    access: creds.accessToken,
    refresh: creds.refreshToken,
    expires: creds.expiresAt,
    metadata: { source },
  }
}

export function registerAnthropicIntegration(
  draft: IntegrationDraft,
  dependencies: Dependencies = defaults,
): void {
  const accounts = dependencies.readAccounts()
  draft.update(ANTHROPIC_INTEGRATION_ID, (integration) => {
    integration.name = "Anthropic"
  })
  draft.method.update({
    integrationID: ANTHROPIC_INTEGRATION_ID,
    method: {
      id: CLAUDE_CODE_METHOD_ID,
      type: "oauth",
      label: "Claude Code credentials",
      prompts:
        accounts.length <= 1
          ? []
          : [
              {
                type: "select",
                key: "account",
                message: "Select which Claude Code account to use:",
                options: accounts.map((account) => ({
                  label: account.label,
                  value: account.source,
                  hint: account.source,
                })),
              },
            ],
    },
    authorize: (inputs) =>
      Effect.sync(() => {
        const current = dependencies.readAccounts()
        const selected = inputs.account
          ? current.find((account) => account.source === inputs.account)
          : current[0]
        if (!selected) {
          throw new Error(
            "No Claude Code credentials found. Run `claude`, then connect Anthropic in OpenCode v2.",
          )
        }
        if (inputs.account && selected.source !== inputs.account) {
          throw new Error(`Unknown Claude Code account: ${inputs.account}`)
        }
        return {
          mode: "auto" as const,
          url: "",
          instructions: `Using ${selected.label} from ${selected.source}.`,
          callback: Effect.sync(() =>
            toOAuthCredential(selected.credentials, selected.source),
          ),
        }
      }),
    refresh: (credential) =>
      Effect.sync(() => {
        const source = credential.metadata?.source
        if (typeof source !== "string") {
          throw new Error("Claude OAuth credential is missing metadata.source")
        }
        const account = dependencies
          .readAccounts()
          .find((candidate) => candidate.source === source)
        if (!account) throw new Error(`Claude Code account is unavailable: ${source}`)
        account.credentials = {
          accessToken: credential.access,
          refreshToken: credential.refresh,
          expiresAt: credential.expires,
        }
        const refreshed = dependencies.refreshAccount(account)
        if (!refreshed) throw new Error("Claude Code OAuth refresh failed")
        return toOAuthCredential(refreshed, source)
      }),
    label: (credential) => {
      const source = credential.metadata?.source
      if (typeof source !== "string") return undefined
      return dependencies.readAccounts().find((account) => account.source === source)?.label
    },
  })
}
```

The Effect values are intentional. In this v2 snapshot, the Promise Integration types still re-export Effect callback signatures and the host calls `.pipe()` on them.

- [ ] **Step 4: Register the Integration in the plugin**

Change `setup` in `src/index.ts` to:

```ts
async setup(context) {
  initLogger()
  await context.integration.transform(registerAnthropicIntegration)
}
```

Add the import for `registerAnthropicIntegration`.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
node --test --experimental-strip-types src/integration.test.ts src/index.test.ts
pnpm run typecheck
```

Expected: all focused tests pass and TypeScript exits with code 0.

- [ ] **Step 6: Commit the Integration**

```bash
git add src/index.ts src/integration.ts src/integration.test.ts
git commit -m "feat: register Claude OAuth integration"
```

## Task 3: Redirect The Anthropic Catalog And Session Context

**Files:**
- Create: `src/catalog.ts`
- Create: `src/catalog.test.ts`
- Create: `src/session-context.ts`
- Create: `src/session-context.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write failing catalog and session tests**

Create `src/catalog.test.ts`:

```ts
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { applyAnthropicCatalog, providerFileUrl } from "./catalog.ts"

describe("Anthropic catalog transform", () => {
  it("rewrites the Anthropic provider and explicit model packages only", () => {
    const provider = { id: "anthropic", package: "aisdk:@ai-sdk/anthropic" }
    const models = [
      {
        id: "claude-sonnet-4-6",
        package: "aisdk:@ai-sdk/anthropic",
        cost: [{ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }],
      },
    ]
    const draft = {
      provider: {
        get: () => ({ provider, models: new Map(models.map((model) => [model.id, model])) }),
        update: (_id: string, update: (value: typeof provider) => void) => update(provider),
      },
      model: {
        update: (_provider: string, id: string, update: (value: (typeof models)[number]) => void) =>
          update(models.find((model) => model.id === id)!),
      },
    }
    applyAnthropicCatalog(draft as never, "file:///plugin/dist/provider.js")
    assert.equal(provider.package, "file:///plugin/dist/provider.js")
    assert.equal(models[0].package, "file:///plugin/dist/provider.js")
    assert.deepEqual(models[0].cost, [
      { input: 0, output: 0, cache: { read: 0, write: 0 } },
    ])
  })

  it("derives the provider beside the compiled plugin", () => {
    assert.equal(
      providerFileUrl("file:///plugin/dist/index.js"),
      "file:///plugin/dist/provider.js",
    )
  })
})
```

Create `src/session-context.test.ts`:

```ts
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { CLAUDE_CODE_IDENTITY, injectClaudeIdentity } from "./session-context.ts"

describe("Claude Code session identity", () => {
  it("injects once for Anthropic and never for other providers", () => {
    const anthropic = {
      model: { providerID: "anthropic" },
      system: [{ type: "text", text: "Existing" }],
    }
    injectClaudeIdentity(anthropic as never)
    injectClaudeIdentity(anthropic as never)
    assert.equal(anthropic.system[0].text, CLAUDE_CODE_IDENTITY)
    assert.equal(
      anthropic.system.filter((part) => part.text === CLAUDE_CODE_IDENTITY).length,
      1,
    )

    const openai = { model: { providerID: "openai" }, system: [] as typeof anthropic.system }
    injectClaudeIdentity(openai as never)
    assert.deepEqual(openai.system, [])
  })
})
```

- [ ] **Step 2: Run both files and verify missing-module failures**

Run:

```bash
node --test --experimental-strip-types src/catalog.test.ts src/session-context.test.ts
```

Expected: FAIL because both implementation modules are absent.

- [ ] **Step 3: Implement the catalog transform**

Create `src/catalog.ts`:

```ts
import type { CatalogDraft } from "@opencode-ai/plugin/v2/catalog"

const ANTHROPIC_PACKAGES = new Set([
  "aisdk:@ai-sdk/anthropic",
  "@opencode-ai/ai/providers/anthropic",
])

export function providerFileUrl(metaUrl = import.meta.url): string {
  return new URL("./provider.js", metaUrl).href
}

export function applyAnthropicCatalog(
  draft: CatalogDraft,
  providerUrl = providerFileUrl(),
): void {
  const record = draft.provider.get("anthropic")
  if (!record) return
  draft.provider.update("anthropic", (provider) => {
    provider.integrationID = "anthropic"
    if (provider.package && ANTHROPIC_PACKAGES.has(provider.package)) {
      provider.package = providerUrl
    }
  })
  for (const model of record.models.values()) {
    draft.model.update("anthropic", model.id, (candidate) => {
      if (candidate.package && ANTHROPIC_PACKAGES.has(candidate.package)) {
        candidate.package = providerUrl
      }
      candidate.cost = candidate.cost.map((cost) => ({
        ...(cost.tier === undefined ? {} : { tier: cost.tier }),
        input: 0,
        output: 0,
        cache: { read: 0, write: 0 },
      }))
    })
  }
}
```

- [ ] **Step 4: Implement the session hook**

Create `src/session-context.ts`:

```ts
import { SystemPart } from "@opencode-ai/ai"
import type { SessionContext } from "@opencode-ai/plugin/v2/session"

export const CLAUDE_CODE_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude."

export function injectClaudeIdentity(context: SessionContext): void {
  if (context.model.providerID !== "anthropic") return
  if (context.system.some((part) => part.text.includes(CLAUDE_CODE_IDENTITY))) return
  context.system.unshift(SystemPart.make(CLAUDE_CODE_IDENTITY))
}
```

- [ ] **Step 5: Register catalog and session hooks**

Add both registrations to `src/index.ts` after the Integration registration:

```ts
await context.catalog.transform(applyAnthropicCatalog)
await context.session.hook("context", injectClaudeIdentity)
```

Rely on the plugin scope to dispose registrations. Do not return a cleanup that double-disposes them, and do not add a timer.

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
node --test --experimental-strip-types src/catalog.test.ts src/session-context.test.ts src/index.test.ts
pnpm run typecheck
```

Expected: all focused tests pass and TypeScript exits with code 0.

- [ ] **Step 7: Commit catalog and session behavior**

```bash
git add src/index.ts src/catalog.ts src/catalog.test.ts src/session-context.ts src/session-context.test.ts
git commit -m "feat: route Anthropic models through v2 provider"
```

## Task 4: Extract The Claude OAuth Fetch Pipeline

**Files:**
- Create: `src/claude-fetch.ts`
- Create: `src/claude-fetch.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write failing fixed-token transport tests**

Create `src/claude-fetch.test.ts` with focused tests for the behavior currently embedded in `src/index.ts`:

```ts
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createClaudeFetch } from "./claude-fetch.ts"

const requestBody = JSON.stringify({
  model: "claude-sonnet-4-6",
  system: [],
  messages: [{ role: "user", content: "hello" }],
  max_tokens: 32,
  stream: true,
})

describe("Claude OAuth fetch", () => {
  it("uses the Integration token as Bearer and removes x-api-key", async () => {
    let request: Request | undefined
    const send = createClaudeFetch({
      accessToken: "oauth-access",
      sleep: async () => {},
      upstream: async (input, init) => {
        request = new Request(input, init)
        return new Response("ok")
      },
    })
    await send("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "wrong" },
      body: requestBody,
    })
    assert.equal(request?.url, "https://api.anthropic.com/v1/messages?beta=true")
    assert.equal(request?.headers.get("authorization"), "Bearer oauth-access")
    assert.equal(request?.headers.get("x-api-key"), null)
  })

  it("passes 401 through once and retries 429/529", async () => {
    let unauthorizedCalls = 0
    const unauthorized = createClaudeFetch({
      accessToken: "oauth-access",
      upstream: async () => {
        unauthorizedCalls++
        return new Response("unauthorized", { status: 401 })
      },
    })
    assert.equal((await unauthorized("https://api.anthropic.com/v1/messages", { body: requestBody })).status, 401)
    assert.equal(unauthorizedCalls, 1)

    const statuses = [429, 529, 200]
    const retried = createClaudeFetch({
      accessToken: "oauth-access",
      sleep: async () => {},
      upstream: async () => new Response("body", { status: statuses.shift() ?? 200 }),
    })
    assert.equal((await retried("https://api.anthropic.com/v1/messages", { body: requestBody })).status, 200)
  })
})
```

Also migrate the existing header, retry cap, beta exclusion, and response stream assertions from `src/index.test.ts` into this file. Import `transformBody` directly from `src/transforms.ts`; do not recreate transform logic in tests.

- [ ] **Step 2: Run the test and verify the missing module failure**

Run: `node --test --experimental-strip-types src/claude-fetch.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/claude-fetch.ts`.

- [ ] **Step 3: Move the framework-independent HTTP helpers**

Create `src/claude-fetch.ts` by moving these existing implementations from commit `4ec411e`'s `src/index.ts` without semantic changes:

```bash
git show 4ec411e:src/index.ts
```

Move `getCliVersion`, `getUserAgent`, `getStainlessHeaders`, `buildRequestUrl`, `fetchWithRetry`, `buildRequestHeaders`, the session ID, retry cap, model ID parsing, beta exclusion loop, warning logs, and response transformation. Keep their current exports where tests consume them.

Replace only the credential lookup and 401 block with this factory boundary:

```ts
type FetchFn = typeof globalThis.fetch

export interface ClaudeFetchOptions {
  readonly accessToken: string
  readonly upstream?: FetchFn
  readonly sleep?: (milliseconds: number) => Promise<void>
  readonly retries?: number
}

export function createClaudeFetch(options: ClaudeFetchOptions): FetchFn {
  const upstream = options.upstream ?? globalThis.fetch
  const sleep = options.sleep ?? ((milliseconds) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const retries = options.retries ?? 3

  return async (input, init = {}) => {
    const bodyString = typeof init.body === "string" ? init.body : undefined
    let modelID = "unknown"
    if (bodyString) {
      try {
        modelID = (JSON.parse(bodyString) as { model?: string }).model ?? "unknown"
      } catch {}
    }
    const requestUrl = buildRequestUrl(input)
    const body = transformBody(init.body)
    const execute = (excluded = getExcludedBetas(modelID)) =>
      fetchWithRetry(
        requestUrl,
        {
          ...init,
          body,
          headers: buildRequestHeaders(
            input,
            init,
            options.accessToken,
            modelID,
            excluded,
          ),
        },
        retries,
        upstream,
        sleep,
      )

    let response = await execute()
    if (response.status === 401) return transformResponseStream(response)

    for (let attempt = 0; attempt < LONG_CONTEXT_BETAS.length; attempt++) {
      if (response.status !== 400 && response.status !== 429) break
      if (!isLongContextError(await response.clone().text())) break
      const beta = getNextBetaToExclude(modelID)
      if (!beta) break
      addExcludedBeta(modelID, beta)
      response = await execute(getExcludedBetas(modelID))
    }
    return transformResponseStream(response)
  }
}
```

Extend `fetchWithRetry` with the injectable sleeper while preserving the existing default:

```ts
export async function fetchWithRetry(
  input: RequestInfo | URL,
  init: RequestInit,
  retries = 3,
  fetchImpl: FetchFn = globalThis.fetch,
  sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<Response>
```

Use `await sleep(delay)` where the old code called `setTimeout` directly. Do not import or call `getCachedCredentials`, `syncAuthJson`, or any other v1 auth state from this module.

- [ ] **Step 4: Run focused tests and the existing transform suite**

Run:

```bash
node --test --experimental-strip-types src/claude-fetch.test.ts src/transforms.test.ts src/betas.test.ts
pnpm run typecheck
```

Expected: all focused tests pass and TypeScript exits with code 0.

- [ ] **Step 5: Commit the fetch pipeline**

```bash
git add src/claude-fetch.ts src/claude-fetch.test.ts src/index.test.ts
git commit -m "refactor: extract Claude OAuth fetch pipeline"
```

## Task 5: Build The Native Anthropic Provider Shim

**Files:**
- Create: `src/provider.ts`
- Create: `src/provider.test.ts`

- [ ] **Step 1: Write failing provider contract tests**

Create `src/provider.test.ts`:

```ts
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Effect, Layer } from "effect"
import { LLM, LLMClient } from "@opencode-ai/ai"
import { RequestExecutor } from "@opencode-ai/ai/route"
import { model } from "./provider.ts"

describe("Claude OAuth provider", () => {
  it("requires the Integration access token", () => {
    assert.throws(
      () => model("claude-sonnet-4-6", { limits: { context: 200_000, output: 64_000 } }),
      /Connect Anthropic in OpenCode v2/,
    )
  })

  it("runs the native Anthropic route through the private transformed fetch", async () => {
    let captured: Request | undefined
    const selected = model("claude-sonnet-4-6", {
      apiKey: "oauth-access",
      limits: { context: 200_000, output: 64_000 },
      fetch: async (input, init) => {
        captured = new Request(input, init)
        return new Response(
          [
            'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-6","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
            "",
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"ok"}}',
            "",
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
            "",
            'data: {"type":"content_block_stop","index":0}',
            "",
            'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
            "",
            'data: {"type":"message_stop"}',
            "",
          ].join("\n"),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const unusedExecutor = Layer.succeed(
      RequestExecutor.Service,
      RequestExecutor.Service.of({
        execute: () => Effect.die(new Error("global executor must not run")),
      }),
    )
    await Effect.runPromise(
      LLMClient.generate(LLM.request({ model: selected, prompt: "say ok" })).pipe(
        Effect.provide(LLMClient.layer.pipe(Layer.provide(unusedExecutor))),
      ),
    )
    assert.equal(captured?.headers.get("authorization"), "Bearer oauth-access")
    assert.equal(captured?.headers.get("x-api-key"), null)
    assert.equal(captured?.url, "https://api.anthropic.com/v1/messages?beta=true")
  })
})
```

- [ ] **Step 2: Run the provider tests and verify the missing module failure**

Run: `node --test --experimental-strip-types src/provider.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/provider.ts`.

- [ ] **Step 3: Implement a private executor backed by the transformed fetch**

Create `src/provider.ts`:

```ts
import type {
  ProviderPackageDefinition,
  ProviderPackageSettings,
} from "@opencode-ai/ai"
import * as AnthropicMessages from "@opencode-ai/ai/protocols/anthropic-messages"
import {
  HttpTransport,
  RequestExecutor,
  type TransportDef,
} from "@opencode-ai/ai/route"
import type { Interface as RequestExecutorInterface } from "@opencode-ai/ai/route/executor"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { createClaudeFetch } from "./claude-fetch.ts"

type FetchFn = typeof globalThis.fetch

export interface ClaudeProviderSettings extends ProviderPackageSettings {
  readonly apiKey?: string
  readonly baseURL?: string
  readonly fetch?: FetchFn
}

function requireAccessToken(settings: ClaudeProviderSettings): string {
  if (settings.apiKey) return settings.apiKey
  throw new Error(
    "Connect Anthropic in OpenCode v2 before using Claude Code OAuth models.",
  )
}

function executorUsing(fetch: FetchFn): RequestExecutorInterface {
  const fetchLayer = FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
    Layer.fresh,
  )
  const executorLayer = RequestExecutor.layer.pipe(Layer.provide(fetchLayer))
  return {
    execute: (request) =>
      Effect.flatMap(RequestExecutor.Service, (executor) =>
        executor.execute(request),
      ).pipe(Effect.provide(executorLayer)),
  }
}

function withExecutor<Body, Prepared, Frame>(
  transport: TransportDef<Body, Prepared, Frame>,
  http: RequestExecutorInterface,
): TransportDef<Body, Prepared, Frame> {
  return {
    id: `${transport.id}/claude-code-oauth`,
    prepare: transport.prepare,
    frames: (prepared, request, runtime) =>
      transport.frames(prepared, request, { ...runtime, http }),
  }
}

export const model: ProviderPackageDefinition<ClaudeProviderSettings>["model"] = (
  modelID,
  settings,
) => {
  const accessToken = requireAccessToken(settings)
  const transport = withExecutor(
    HttpTransport.sseJson.with<AnthropicMessages.AnthropicMessagesBody>(),
    executorUsing(
      createClaudeFetch({
        accessToken,
        upstream: settings.fetch ?? globalThis.fetch,
      }),
    ),
  )
  return AnthropicMessages.route
    .with({
      id: "claude-code-anthropic-messages",
      provider: "anthropic",
      endpoint: {
        baseURL: settings.baseURL ?? AnthropicMessages.DEFAULT_BASE_URL,
      },
      transport,
      headers:
        settings.headers === undefined ? undefined : { ...settings.headers },
      http:
        settings.body === undefined ? undefined : { body: { ...settings.body } },
      limits: settings.limits,
    })
    .model({ id: modelID })
}
```

The token is closed over by the private executor. Do not place it in provider metadata or read it from request defaults. `settings.fetch` is test-only; catalog settings remain JSON and production uses `globalThis.fetch`.

- [ ] **Step 4: Run provider, fetch, and type tests**

Run:

```bash
node --test --experimental-strip-types src/provider.test.ts src/claude-fetch.test.ts
pnpm run typecheck
```

Expected: both test files pass and TypeScript exits with code 0.

- [ ] **Step 5: Commit the provider shim**

```bash
git add src/provider.ts src/provider.test.ts
git commit -m "feat: add native Anthropic OAuth provider"
```

## Task 6: Complete Plugin Composition And Local Documentation

**Files:**
- Modify: `src/index.ts`
- Modify: `src/index.test.ts`
- Modify: `README.md`
- Modify: `installation.md`

- [ ] **Step 1: Add a failing setup registration test**

Extend `src/index.test.ts`:

```ts
it("registers Integration, catalog, and session context exactly once", async () => {
  const calls: string[] = []
  await plugin.setup({
    integration: {
      transform: async () => {
        calls.push("integration")
        return { dispose: async () => {} }
      },
    },
    catalog: {
      transform: async () => {
        calls.push("catalog")
        return { dispose: async () => {} }
      },
    },
    session: {
      hook: async (name: string) => {
        calls.push(`session:${name}`)
        return { dispose: async () => {} }
      },
    },
  } as never)
  assert.deepEqual(calls, ["integration", "catalog", "session:context"])
})
```

- [ ] **Step 2: Run the setup test and verify missing registrations**

Run: `node --test --experimental-strip-types src/index.test.ts`

Expected: FAIL until all three registrations are composed.

- [ ] **Step 3: Finalize the v2-only entrypoint**

Make `src/index.ts` exactly:

```ts
import { Plugin } from "@opencode-ai/plugin/v2"
import { applyAnthropicCatalog } from "./catalog.ts"
import { registerAnthropicIntegration } from "./integration.ts"
import { initLogger } from "./logger.ts"
import { injectClaudeIdentity } from "./session-context.ts"

const plugin = Plugin.define({
  id: "opencode-claude-auth",
  async setup(context) {
    initLogger()
    await context.integration.transform(registerAnthropicIntegration)
    await context.catalog.transform(applyAnthropicCatalog)
    await context.session.hook("context", injectClaudeIdentity)
  },
})

export default plugin
```

- [ ] **Step 4: Document local build and mandatory Integration connection**

Update `README.md` and `installation.md` to use the v2 plural config field and local file URL:

```json
{
  "plugins": [
    "file:///Users/jeresrc/dev/lab/opencode-claude-auth/opencode-claude-auth.js"
  ]
}
```

Document these exact commands and behavior:

```bash
pnpm install
pnpm run build
```

State that the user must open OpenCode v2 Integrations, connect Anthropic with the `Claude Code credentials` method, and reconnect to switch accounts. Remove v1 `plugin`, `opencode auth login`, automatic `auth.json` synchronization, background timer, and inference fallback claims.

- [ ] **Step 5: Run plugin tests and documentation searches**

Run:

```bash
node --test --experimental-strip-types src/index.test.ts src/integration.test.ts src/catalog.test.ts src/session-context.test.ts
rg '"plugin"\s*:|auth\.loader|auth\.json' README.md installation.md
```

Expected: tests pass. The search returns no stale singular config or v1 runtime claims.

- [ ] **Step 6: Commit composition and docs**

```bash
git add src/index.ts src/index.test.ts README.md installation.md
git commit -m "docs: document local OpenCode v2 setup"
```

## Task 7: Verify Build, Host Loading, And Live Inference

**Files:**
- None. This task verifies the committed implementation and local host behavior.

- [ ] **Step 1: Run the complete unit suite from a clean build state**

Run: `pnpm test`

Expected: zero failed, cancelled, skipped, or todo tests.

- [ ] **Step 2: Run static verification and build both entrypoints**

Run:

```bash
pnpm run typecheck
pnpm run lint
pnpm run build
node -e 'import("./opencode-claude-auth.js").then((m) => { if (m.default.id !== "opencode-claude-auth" || typeof m.default.setup !== "function") process.exit(1) })'
node -e 'import("./dist/provider.js").then((m) => { if (typeof m.model !== "function") process.exit(1) })'
```

Expected: every command exits 0; `dist/index.js`, `dist/provider.js`, and their declarations exist.

- [ ] **Step 3: Verify OpenCode has not changed**

Run:

```bash
git -C /Users/jeresrc/dev/lab/opencode-v2 status --short --branch
```

Expected: `## v2...origin/v2` with no changed paths.

- [ ] **Step 4: Load the plugin through an isolated v2 config**

Use a temporary directory outside both repositories and launch the cloned v2 CLI with inline config:

```bash
OPENCODE_CONFIG_CONTENT='{"plugins":["file:///Users/jeresrc/dev/lab/opencode-claude-auth/opencode-claude-auth.js"]}' \
bun run --cwd /Users/jeresrc/dev/lab/opencode-v2/packages/cli --conditions=browser src/index.ts
```

Expected: OpenCode starts without plugin import or activation errors, and the Integrations UI lists Anthropic with `Claude Code credentials`.

- [ ] **Step 5: Connect and run the approved low-cost smoke request**

In the isolated OpenCode session:

1. Connect Anthropic using `Claude Code credentials`.
2. Select the intended local Claude account.
3. Select the lowest-cost available Anthropic model.
4. Send `Reply with exactly: ok`.
5. Confirm the streamed response is `ok` and no `x-api-key`, auth, tool-name, or SSE parse error appears.

- [ ] **Step 6: Re-run final evidence commands**

Run:

```bash
pnpm test
pnpm run typecheck
pnpm run lint
pnpm run build
git status --short --branch
git -C /Users/jeresrc/dev/lab/opencode-v2 status --short --branch
```

Expected: all verification commands exit 0, the plugin branch contains only committed intentional changes, and OpenCode remains clean.
