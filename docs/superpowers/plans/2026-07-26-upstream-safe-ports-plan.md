# Upstream Safe Ports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Selectively port the approved upstream fixes into the V2 provider without importing the legacy upstream plugin architecture.

**Architecture:** Apply one upstream-safe behavior block per task with a failing test, minimal adaptation, green verification, and an independent commit. Keep all changes inside the current V2 request transform, model config, credential parsing, and provider fetch layers.

**Tech Stack:** TypeScript ESM, Node test runner with `--experimental-strip-types`, pnpm 10.32.1, Effect 4, upstream git commits `d056c7c`, `ab54ebb`, `686a543`, and `baf1ffd`.

## Global Constraints

- This plan depends on `docs/superpowers/plans/2026-07-26-v2-provider-compat-stream-plan.md` being complete and passing.
- Pin `@opencode-ai/ai` to `0.0.0-next-16255` and `@opencode-ai/plugin` to `1.18.3`.
- Preserve the current V2 architecture: `Plugin.define`, Integration V2, catalog transform, and native provider registration.
- Do not wholesale merge `origin/main` or port the legacy upstream `src/index.ts` architecture.
- Do not mutate Integration state except through existing sync/writeback paths.
- Update `repairToolPairs` so a `tool_result` is considered valid only when it matches the preceding adjacent `tool_use` by ID.
- Preserve upstream behavior for separated or orphaned tool pairs: repair when the upstream algorithm can safely restore validity, otherwise remove invalid orphaned pairs.
- Update model identity/config to match Claude CLI `2.1.217`.
- Sonnet models must not receive incompatible effort settings.
- Opus 5 high must preserve adaptive behavior and compatible effort settings.
- Use `Math.trunc` when persisting OAuth expiry values so fractional seconds become integer seconds and existing integer expiries remain unchanged.
- Avoid printing raw responses API bodies through `console.warn` in the TUI.
- Preserve the rate-limit notice path so users still receive actionable rate-limit feedback.
- Do not support multiple Claude accounts.
- Do not support suffixed account names or account-specific credential files.
- Do not support `CLAUDE_CONFIG_DIR`, even though upstream includes related behavior.

---

## Dependency And Plan Order

This is the second implementation plan. It must run after `2026-07-26-v2-provider-compat-stream-plan.md` so `pnpm test`, `pnpm run typecheck`, and `pnpm run build` already pass on the pinned runtime packages. `2026-07-26-primary-auth-resilience-plan.md` can run after this plan because its 401 and proactive refresh tests assume these transform/config/error-sanitization behaviors.

## File Map

- Modify `src/transforms.ts`: replace global orphan-only `repairToolPairs(messages: Message[]): Message[]` with adjacent-pair validation and keep request body effort stripping in `transformBody(body): BodyInit | null | undefined`.
- Modify `src/transforms.test.ts`: add adjacency regressions from upstream `d056c7c` and effort-body regressions for Sonnet and Opus 5 high.
- Modify `src/model-config.ts`: set `config.ccVersion` to `2.1.217`, remove `effort-2025-11-24` from `baseBetas`, add first-match `sonnet` rules, keep `haiku.disableEffort`, and add Opus 5 effort rules.
- Modify `src/betas.test.ts`: update tests that currently expect Haiku to exclude interleaved thinking and add exact Sonnet/Opus 5 beta rules.
- Modify `src/credentials.ts`: truncate OAuth `expiresAt` in `parseOAuthResponse`.
- Modify `src/credentials.test.ts`: add fractional `expires_in` regression.
- Modify `src/keychain.ts`: export `parseCredentials(raw: string): ClaudeCredentials | null` and truncate stored `expiresAt`.
- Modify `src/keychain.test.ts`: stop mirroring private parsing logic and test the exported parser against fractional stored expiry.
- Modify `src/claude-fetch.ts`: remove raw-response `console.warn` from non-OK response handling while keeping structured `log("fetch_error_response", ...)`.
- Modify `src/claude-fetch.test.ts`: assert no terminal warning for API errors, assert response body/headers survive unchanged, and keep rate-limit response semantics.
- Use existing `src/rate-limit-notice.test.ts`: verify the rate-limit notice path remains functional after the `console.warn` removal.

## Task 1: Port Adjacent Tool Pair Repair From `d056c7c`

**Files:**
- Modify: `src/transforms.ts`
- Modify: `src/transforms.test.ts`

**Interfaces:**
- Consumes: `repairToolPairs(messages: Message[]): Message[]`, where `Message` has `role?: string` and `content?: string | ContentBlock[]`.
- Produces: the same `repairToolPairs(messages: Message[]): Message[]` export, with adjacency-safe behavior consumed by `transformBody(body)` before JSON serialization.

- [ ] **Step 1: Write the failing adjacency tests**

Append these tests inside the existing `describe("repairToolPairs", () => { ... })` block in `src/transforms.test.ts`:

```ts
    it("removes pairs whose tool_result is not in the immediately following message", () => {
      const messages = [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_gap", name: "search" }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "compaction summary" }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_gap", content: "late" },
          ],
        },
      ]

      assert.deepEqual(repairToolPairs(messages), [
        {
          role: "user",
          content: [{ type: "text", text: "compaction summary" }],
        },
      ])
    })

    it("keeps adjacent pairs while dropping results split into a later message", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_a", name: "search" },
            { type: "tool_use", id: "toolu_b", name: "read" },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_a", content: "res_a" },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_b", content: "res_b" },
          ],
        },
      ]

      assert.deepEqual(repairToolPairs(messages), [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_a", name: "search" }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_a", content: "res_a" },
          ],
        },
      ])
    })

    it("removes reversed pairs where the tool_result precedes its tool_use", () => {
      const messages = [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_rev", content: "early" },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "answer" },
            { type: "tool_use", id: "toolu_rev", name: "search" },
          ],
        },
      ]

      assert.deepEqual(repairToolPairs(messages), [
        {
          role: "assistant",
          content: [{ type: "text", text: "answer" }],
        },
      ])
    })
```

- [ ] **Step 2: Run transforms tests and verify RED**

Run: `node --test --experimental-strip-types src/transforms.test.ts`

Expected: FAIL because the current implementation treats matching IDs anywhere in the history as valid and preserves separated or reversed pairs.

- [ ] **Step 3: Replace `repairToolPairs` with adjacent-pair validation**

Replace the whole `repairToolPairs(messages: Message[]): Message[]` function in `src/transforms.ts` with:

```ts
export function repairToolPairs(messages: Message[]): Message[] {
  const useMsgIndex = new Map<string, number>()
  const resultMsgIndex = new Map<string, number>()

  messages.forEach((message, index) => {
    if (!Array.isArray(message.content)) return
    for (const block of message.content) {
      const id = block["id"]
      if (block.type === "tool_use" && typeof id === "string") {
        if (!useMsgIndex.has(id)) useMsgIndex.set(id, index)
      }

      const toolUseId = block["tool_use_id"]
      if (block.type === "tool_result" && typeof toolUseId === "string") {
        if (!resultMsgIndex.has(toolUseId)) resultMsgIndex.set(toolUseId, index)
      }
    }
  })

  const isAdjacentPair = (id: string): boolean => {
    const useIndex = useMsgIndex.get(id)
    return useIndex !== undefined && resultMsgIndex.get(id) === useIndex + 1
  }

  const needsRepair =
    [...useMsgIndex.keys()].some((id) => !isAdjacentPair(id)) ||
    [...resultMsgIndex.keys()].some((id) => !isAdjacentPair(id))
  if (!needsRepair) return messages

  return messages
    .map((message, index) => {
      if (!Array.isArray(message.content)) return message

      const filtered = message.content.filter((block) => {
        const id = block["id"]
        if (block.type === "tool_use" && typeof id === "string") {
          return isAdjacentPair(id) && useMsgIndex.get(id) === index
        }

        const toolUseId = block["tool_use_id"]
        if (block.type === "tool_result" && typeof toolUseId === "string") {
          return (
            isAdjacentPair(toolUseId) &&
            resultMsgIndex.get(toolUseId) === index
          )
        }

        return true
      })

      return { ...message, content: filtered }
    })
    .filter(
      (message) =>
        !(Array.isArray(message.content) && message.content.length === 0),
    )
}
```

- [ ] **Step 4: Run focused and full transform checks**

Run:

```bash
node --test --experimental-strip-types src/transforms.test.ts
pnpm run typecheck
```

Expected: PASS for transforms tests and typecheck.

- [ ] **Step 5: Commit the tool-pair port**

```bash
git add src/transforms.ts src/transforms.test.ts
git commit -m "fix: enforce adjacent Anthropic tool pairs"
```

## Task 2: Port Claude CLI `2.1.217` Model Config And Effort Rules From `ab54ebb`

**Files:**
- Modify: `src/model-config.ts`
- Modify: `src/betas.test.ts`
- Modify: `src/transforms.test.ts`
- Modify: `src/transforms.ts`

**Interfaces:**
- Consumes: `config: ModelConfig`, `getModelOverride(modelId: string): ModelOverride | null`, `getModelBetas(modelId: string, excluded?: Set<string>): string[]`, and `transformBody(body)`.
- Produces: `config.ccVersion === "2.1.217"`, Sonnet effort beta/body stripping, Haiku effort stripping without removing interleaved thinking, and Opus 5 high effort/adaptive-thinking preservation.

- [ ] **Step 1: Write failing model config tests**

In `src/betas.test.ts`, replace the test named `getModelBetas excludes interleaved-thinking for haiku models` with:

```ts
  it("getModelBetas keeps interleaved thinking for haiku and excludes effort", () => {
    const models = ["claude-haiku-4-5", "claude-haiku-4-5-20251001"]
    for (const model of models) {
      const betas = getModelBetas(model)
      assert.ok(
        betas.includes("interleaved-thinking-2025-05-14"),
        `${model} should include interleaved-thinking beta`,
      )
      assert.ok(
        !betas.includes("effort-2025-11-24"),
        `${model} should exclude effort beta`,
      )
      assert.ok(betas.includes("claude-code-20250219"))
      assert.ok(betas.includes("oauth-2025-04-20"))
    }
  })
```

Append these tests inside the existing `describe("betas", () => { ... })` block:

```ts
  it("pins Claude CLI model config to 2.1.217", () => {
    assert.equal(config.ccVersion, "2.1.217")
    assert.ok(!config.baseBetas.includes("effort-2025-11-24"))
    assert.equal(
      config.baseBetas.filter((beta) => beta === "interleaved-thinking-2025-05-14")
        .length,
      1,
    )
  })

  it("Sonnet excludes effort beta before broad 4-6 effort rules can match", () => {
    const betas = getModelBetas("claude-sonnet-4-6")
    assert.ok(!betas.includes("effort-2025-11-24"))
    assert.deepEqual(getModelOverride("claude-sonnet-4-6"), {
      exclude: ["effort-2025-11-24"],
      disableEffort: true,
    })
  })

  it("Opus 5 high includes the compatible effort beta", () => {
    const betas = getModelBetas("claude-opus-5")
    assert.ok(betas.includes("effort-2025-11-24"))
  })
```

- [ ] **Step 2: Write failing body effort tests**

Append these tests to `src/transforms.test.ts` near the existing effort tests:

```ts
  it("transformBody strips incompatible effort fields for sonnet", () => {
    const input = JSON.stringify({
      model: "claude-sonnet-4-6",
      output_config: { effort: "high", max_tokens: 1024 },
      thinking: { type: "enabled", effort: "high" },
      messages: [{ role: "user", content: "test" }],
    })

    const output = transformBody(input)
    const parsed = JSON.parse(output as string) as {
      output_config?: { effort?: string; max_tokens?: number }
      thinking?: { effort?: string; type?: string }
    }

    assert.equal(parsed.output_config?.effort, undefined)
    assert.equal(parsed.output_config?.max_tokens, 1024)
    assert.equal(parsed.thinking?.effort, undefined)
    assert.equal(parsed.thinking?.type, "enabled")
  })

  it("transformBody preserves Opus 5 high adaptive thinking and effort", () => {
    const input = JSON.stringify({
      model: "claude-opus-5",
      output_config: { effort: "high" },
      thinking: { type: "adaptive", display: "omitted" },
      messages: [{ role: "user", content: "test" }],
    })

    const output = transformBody(input)
    const parsed = JSON.parse(output as string) as {
      output_config?: { effort?: string }
      thinking?: { type?: string; display?: string }
    }

    assert.equal(parsed.output_config?.effort, "high")
    assert.deepEqual(parsed.thinking, { type: "adaptive", display: "omitted" })
  })
```

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
node --test --experimental-strip-types src/betas.test.ts src/transforms.test.ts
```

Expected: FAIL because `config.ccVersion` is `2.1.185`, Haiku excludes interleaved thinking, Sonnet does not strip effort body fields, and Opus 5 does not add the effort beta.

- [ ] **Step 4: Replace the model config with the adapted `2.1.217` rules**

Replace the `config` object in `src/model-config.ts` with:

```ts
export const config: ModelConfig = {
  ccVersion: "2.1.217",
  baseBetas: [
    "claude-code-20250219",
    "oauth-2025-04-20",
    "interleaved-thinking-2025-05-14",
    "prompt-caching-scope-2026-01-05",
    "context-management-2025-06-27",
    "advisor-tool-2026-03-01",
    "thinking-token-count-2026-05-13",
    "extended-cache-ttl-2025-04-11",
  ],
  longContextBetas: [
    "context-1m-2025-08-07",
    "interleaved-thinking-2025-05-14",
  ],
  modelOverrides: {
    sonnet: {
      exclude: ["effort-2025-11-24"],
      disableEffort: true,
    },
    haiku: {
      exclude: ["effort-2025-11-24"],
      disableEffort: true,
    },
    "opus-5": {
      add: ["effort-2025-11-24"],
    },
    "4-6": {
      add: ["effort-2025-11-24"],
    },
    "4-7": {
      add: ["effort-2025-11-24"],
    },
  },
}
```

Keep `sonnet` before `4-6` and `4-7` because `getModelOverride` is first-match-wins.

- [ ] **Step 5: Reuse the existing effort stripping branch for Sonnet**

No new helper is needed in `src/transforms.ts`. The existing branch must continue to read:

```ts
    const modelId = parsed.model ?? ""
    const override = getModelOverride(modelId)
    if (override?.disableEffort) {
      if (parsed.output_config) {
        delete parsed.output_config.effort
        if (Object.keys(parsed.output_config).length === 0) {
          delete parsed.output_config
        }
      }
      if (parsed.thinking && "effort" in parsed.thinking) {
        delete parsed.thinking.effort
        if (Object.keys(parsed.thinking).length === 0) {
          delete parsed.thinking
        }
      }
    }
```

The model-config change makes this branch apply to Sonnet and Haiku while preserving Opus 5 high.

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
node --test --experimental-strip-types src/betas.test.ts src/transforms.test.ts
pnpm run typecheck
```

Expected: PASS for focused tests and typecheck.

- [ ] **Step 7: Commit the model config port**

```bash
git add src/model-config.ts src/betas.test.ts src/transforms.test.ts src/transforms.ts
git commit -m "fix: port Claude CLI model effort rules"
```

## Task 3: Port Fractional Expiry Truncation From `686a543`

**Files:**
- Modify: `src/credentials.ts`
- Modify: `src/credentials.test.ts`
- Modify: `src/keychain.ts`
- Modify: `src/keychain.test.ts`

**Interfaces:**
- Consumes: `parseOAuthResponse(raw: string, currentRefreshToken: string, now?: number): ClaudeCredentials | null` and credential JSON parsed by Keychain/file readers.
- Produces: integer `ClaudeCredentials.expiresAt` for OAuth refresh responses and stored credential ingress.

- [ ] **Step 1: Write failing OAuth fractional expiry test**

Append this test inside `describe("parseOAuthResponse", () => { ... })` in `src/credentials.test.ts`:

```ts
  it("truncates fractional expires_in to integer milliseconds", () => {
    const expiresIn = 28_800.000_901_1
    const raw = JSON.stringify({
      access_token: "sk-ant-oat01-new",
      expires_in: expiresIn,
    })

    const result = parseOAuthResponse(raw, currentRefresh, now)

    assert.ok(result)
    assert.equal(result.expiresAt, Math.trunc(now + expiresIn * 1000))
    assert.equal(Number.isInteger(result.expiresAt), true)
  })
```

- [ ] **Step 2: Write failing stored credential fractional expiry test**

In `src/keychain.test.ts`, change the import to include the real parser:

```ts
import {
  buildAccountLabels,
  parseCredentials,
  updateCredentialBlob,
  writeBackCredentials,
} from "./keychain.ts"
```

Delete the local mirrored `parseCredentials` function from `src/keychain.test.ts` and append this test inside `describe("parseCredentials", () => { ... })`:

```ts
  it("truncates a fractional stored expiresAt", () => {
    const raw = JSON.stringify({
      claudeAiOauth: {
        accessToken: "at-123",
        refreshToken: "rt-456",
        expiresAt: 1784891051785.9011,
      },
    })

    const result = parseCredentials(raw)

    assert.ok(result)
    assert.equal(result.expiresAt, 1784891051785)
    assert.equal(Number.isInteger(result.expiresAt), true)
  })
```

- [ ] **Step 3: Run expiry tests and verify RED**

Run:

```bash
node --test --experimental-strip-types src/credentials.test.ts src/keychain.test.ts
```

Expected: FAIL because `parseOAuthResponse` returns a fractional millisecond timestamp and `parseCredentials` is not exported from `src/keychain.ts`.

- [ ] **Step 4: Truncate OAuth and stored expiry values**

In `src/credentials.ts`, replace the `expiresAt` assignment in `parseOAuthResponse` with:

```ts
    expiresAt: Math.trunc(now + (data.expires_in ?? 36_000) * 1000),
```

In `src/keychain.ts`, export the parser and truncate stored expiry:

```ts
export function parseCredentials(raw: string): ClaudeCredentials | null {
```

and replace the return field with:

```ts
    expiresAt: Math.trunc(creds.expiresAt),
```

- [ ] **Step 5: Run expiry tests and typecheck**

Run:

```bash
node --test --experimental-strip-types src/credentials.test.ts src/keychain.test.ts
pnpm run typecheck
```

Expected: PASS for focused tests and typecheck.

- [ ] **Step 6: Commit the expiry port**

```bash
git add src/credentials.ts src/credentials.test.ts src/keychain.ts src/keychain.test.ts
git commit -m "fix: truncate OAuth credential expiries"
```

## Task 4: Port Raw API Warning Removal From `baf1ffd` Into V2 Fetch

**Files:**
- Modify: `src/claude-fetch.ts`
- Modify: `src/claude-fetch.test.ts`
- Test-only: `src/rate-limit-notice.test.ts`

**Interfaces:**
- Consumes: `warnOnErrorResponse(response: Response, modelId: string): void`, `log("fetch_error_response", ...)`, `createClaudeFetch(options: ClaudeFetchOptions): typeof fetch`, and `startRateLimitNotices(context)`.
- Produces: non-OK responses that keep status/headers/body unchanged, structured sanitized logs, zero `console.warn` writes for raw API errors, and unchanged rate-limit synthetic notice behavior.

- [ ] **Step 1: Write failing no-terminal-warning test**

Append this test inside `describe("Claude OAuth fetch pipeline", () => { ... })` in `src/claude-fetch.test.ts`:

```ts
  it("logs API errors without writing raw responses to console.warn", async () => {
    const logged: string[] = []
    initLogger({
      stream: {
        write(chunk: string) {
          logged.push(chunk)
          return true
        },
      } as never,
    })

    const originalWarn = console.warn
    const warnings: unknown[][] = []
    const errorBody = JSON.stringify({
      type: "error",
      error: {
        type: "rate_limit_error",
        message:
          "This request would exceed your account's rate limit. Please try again later.",
      },
    })
    const upstream = (async () =>
      new Response(errorBody, {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": "11218",
        },
      })) as typeof fetch
    const claudeFetch = createClaudeFetch({
      accessToken: "fixed-token",
      upstream,
      retries: 1,
    })

    try {
      console.warn = (...args: unknown[]) => {
        warnings.push(args)
      }
      const response = await claudeFetch(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          body: JSON.stringify({ model: "claude-opus-5", messages: [] }),
        },
      )

      assert.equal(response.status, 429)
      assert.equal(response.headers.get("retry-after"), "11218")
      assert.equal(await response.text(), errorBody)
      await new Promise((resolve) => setImmediate(resolve))
    } finally {
      console.warn = originalWarn
    }

    assert.deepEqual(warnings, [])
    const logOutput = logged.join("")
    assert.match(logOutput, /"event":"fetch_error_response"/)
    assert.match(logOutput, /"status":429/)
    assert.match(logOutput, /rate limit/)
  })
```

- [ ] **Step 2: Update existing sanitization tests to assert logs, not warnings**

In `src/claude-fetch.test.ts`, the existing tests named `sanitizes and truncates error bodies before logging or warning` and `redacts OAuth secrets embedded in error messages before logging or warning` must keep the same secret inputs but use these final assertions:

```ts
    const warning = warnings.join("\n")
    const logOutput = logged.join("")
    assert.equal(warning, "")
    assert.ok(logOutput.length < 2000, `log was ${logOutput.length} chars`)
    assert.ok(!logOutput.includes(secretBearer))
    assert.ok(!logOutput.includes(secretApiKey))
    assert.ok(logOutput.includes("REDACTED"))
```

and for the OAuth secret test:

```ts
    const warning = warnings.join("\n")
    const logOutput = logged.join("")
    assert.equal(warning, "")
    for (const secret of [
      bearerToken,
      accessToken,
      jsonAccessToken,
      refreshToken,
      jwt,
    ]) {
      assert.ok(!logOutput.includes(secret), `log leaked ${secret}`)
    }
    assert.ok(logOutput.includes("upstream OAuth failure"))
    assert.ok(logOutput.includes("REDACTED"))
```

- [ ] **Step 3: Run fetch tests and verify RED**

Run: `node --test --experimental-strip-types src/claude-fetch.test.ts`

Expected: FAIL because `warnOnErrorResponse` still calls `console.warn(...)` for non-OK responses.

- [ ] **Step 4: Remove only the raw terminal warning**

In `src/claude-fetch.ts`, replace the tail of `warnOnErrorResponse` with this log-only block:

```ts
      message = sanitizeErrorMessage(message)
      log("fetch_error_response", { status, modelId, message })
```

Remove these lines and do not replace them with another TUI write:

```ts
      console.warn(
        `opencode-claude-auth: API ${status} for ${modelId}: ${message}`,
      )
```

Keep `warnOnErrorResponse(response, modelId)` as the function name so existing call sites stay unchanged.

- [ ] **Step 5: Run fetch tests and rate-limit notice tests**

Run:

```bash
node --test --experimental-strip-types src/claude-fetch.test.ts src/rate-limit-notice.test.ts
pnpm run typecheck
```

Expected: PASS for fetch tests, PASS for rate-limit notice tests, and typecheck exits with code 0. This proves the TUI no longer receives raw API warning lines while the session-event-based rate-limit notice path still works.

- [ ] **Step 6: Commit the error-output port**

```bash
git add src/claude-fetch.ts src/claude-fetch.test.ts
git commit -m "fix: keep API errors out of terminal warnings"
```

## Final Verification

Run these exact commands after Task 4:

```bash
pnpm test
pnpm run typecheck
pnpm run build
node --test --experimental-strip-types src/transforms.test.ts src/betas.test.ts src/credentials.test.ts src/keychain.test.ts src/claude-fetch.test.ts src/rate-limit-notice.test.ts
git diff --check
```

Expected final state for this plan: all commands pass, each task is committed independently, upstream behavior is ported without legacy `src/index.ts` architecture, and `git status --short` shows only intentional committed changes from this plan.
