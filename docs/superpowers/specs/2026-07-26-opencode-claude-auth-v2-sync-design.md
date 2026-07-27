# OpenCode Claude Auth V2 Sync Design

Date: 2026-07-26
Branch: `v2`
Current HEAD: `e085dde8edb90fb8485fe3aa93976d49bc4de2b6`

## Goals

- Align the V2 plugin implementation with the local OpenCode runtime by pinning `@opencode-ai/ai` to `1.17.20` and `@opencode-ai/plugin` to `1.18.3`.
- Preserve the current V2 architecture: `Plugin.define`, Integration V2, catalog transform, and native provider registration.
- Add a provider-local stream wrapper that guarantees OpenCode receives a valid finish reason for terminal stream events without changing OpenCode core.
- Safely port selected upstream fixes that apply to this V2 provider: tool pair repair, model identity/config, OAuth expiry truncation, 401 retry behavior, proactive refresh, and sanitized TUI error handling.
- Make auth resilient for the primary Claude account only, using the existing primary Keychain service and default file source.
- Add tests that lock the expected contracts before implementation is considered complete.

## Non-Goals

- Do not support multiple Claude accounts.
- Do not support suffixed account names or account-specific credential files.
- Do not support `CLAUDE_CONFIG_DIR`, even though upstream includes related behavior.
- Do not wholesale merge `origin/main` or port the legacy upstream `src/index.ts` architecture.
- Do not mutate Integration state except through existing sync/writeback paths.
- Do not change OpenCode core to solve provider-local behavior.

## Current State and Rationale

- Current branch: `v2`.
- Current HEAD: `e085dde8edb90fb8485fe3aa93976d49bc4de2b6`.
- Upstream `origin/main`: `63a6a93` representing OpenCode `2.1.4`-era upstream state.
- Merge-base: `4ec411e`.
- Branch divergence: `v2` is ahead by 20 commits and behind by 14 commits.
- A wholesale merge is intentionally out of scope because upstream currently includes legacy/provider architecture that does not match this branch's V2 plugin design.
- Current dependency state uses provider `next-15707`; target runtime alignment is `@opencode-ai/ai@1.17.20` and `@opencode-ai/plugin@1.18.3`.
- Candidate upstream changes to port selectively:
  - `d056c7c`: tool adjacency handling.
  - `ab54ebb`: model config, effort rules, and part of 401 handling.
  - `686a543`: fractional OAuth expiry handling.
  - `0242e85`: 401 retry handling.
  - `ed1d735`: proactive refresh behavior.
  - `baf1ffd`: avoid raw responses API errors in TUI while preserving useful notices.

## Architecture

### Block A: V2 Base Alignment

- Pin `@opencode-ai/ai` to `1.17.20` and `@opencode-ai/plugin` to `1.18.3`.
- Adapt only real type/API incompatibilities discovered after pinning.
- Keep the provider on the current V2 shape:
  - `Plugin.define` remains the plugin entrypoint.
  - Integration V2 remains the auth/integration boundary.
  - The catalog transform remains the model catalog adaptation layer.
  - Native provider registration remains the provider exposure mechanism.
- Add a contract test that loads the built plugin/provider the same way OpenCode does, so dependency drift or export shape regressions fail in CI.

### Block B: Robust Stream Closing

- Wrap `route.streamPrepared` in `src/provider.ts`.
- Intercept terminal stream events emitted by `AnthropicMessages.route` before they reach OpenCode session event conversion.
- For `step-finish` and `finish` events:
  - Preserve every valid upstream `reason` value exactly as emitted.
  - Convert only `undefined` or missing `reason` to `"unknown"`.
- Do not patch OpenCode core or global SDK behavior.
- Keep the fix provider-local so the provider owns the compatibility boundary between Anthropic-style SSE and OpenCode's session event expectations.

### Block C: Safe Upstream Ports

- Update `repairToolPairs` so a `tool_result` is considered valid only when it matches the preceding adjacent `tool_use` by ID.
- Preserve upstream behavior for separated or orphaned tool pairs: repair when the upstream algorithm can safely restore validity, otherwise remove invalid orphaned pairs.
- Update model identity/config to match Claude CLI `2.1.217`.
- Apply the correct effort rules by model:
  - Sonnet models must not receive incompatible effort settings.
  - Opus 5 high must preserve adaptive behavior and compatible effort settings.
- Use `Math.trunc` when persisting OAuth expiry values so fractional seconds become integer seconds and existing integer expiries remain unchanged.
- Avoid printing raw responses API bodies through `console.warn` in the TUI.
- Preserve the rate-limit notice path so users still receive actionable rate-limit feedback.

### Block D: Primary-Only Auth Resilience

- Treat the primary Keychain service and existing default credential file as the only credential sources.
- On startup, load primary credentials through the existing sync path.
- Start a proactive refresh timer that runs every 5 minutes.
- Refresh proactively when the active credential expires in less than 1 hour.
- On plugin unload/cleanup, cancel the proactive refresh timer.
- On a 401 from Claude:
  - Reload the primary credential source.
  - If the token changed externally, retry the request once with the reloaded token.
  - If the token did not change and refresh is possible, refresh, persist through existing writeback, and retry once.
  - Never perform more than one retry for a single request.
- Do not add suffixed accounts, fallback account probing, multi-account routing, or `CLAUDE_CONFIG_DIR` lookup.

## Data Flows

### Provider Stream Flow

1. Anthropic emits SSE events.
2. `AnthropicMessages.route` prepares the OpenCode-compatible stream.
3. The provider-local wrapper around `route.streamPrepared` inspects terminal events.
4. For `step-finish` and `finish`, the wrapper applies `reason ?? "unknown"`.
5. OpenCode converts the event into `SessionEvent.Step.Ended` with a defined reason.

### Auth Startup and Proactive Refresh Flow

1. Plugin startup loads the primary credential through the existing Integration sync path.
2. The provider stores the active primary token in the existing auth state shape.
3. A 5-minute timer checks whether the credential expires in less than 1 hour.
4. If refresh is required and possible, refresh succeeds through the primary source and persists through existing writeback.
5. If refresh fails, the provider logs a sanitized warning and continues using the current credential until it expires or a request forces 401 handling.

### 401 Recovery Flow

1. A Claude request returns 401.
2. The provider captures the original failure without exposing raw response bodies to the TUI.
3. The provider reloads the primary credential source.
4. If the token differs from the one used for the failed request, retry once with the reloaded token.
5. If the token is unchanged and refresh is possible, refresh and persist through existing writeback, then retry once.
6. If reload/refresh fails or the single retry also returns 401, return the original or equivalent 401 failure.

## Error Handling

- Proactive refresh failure:
  - Log a sanitized message with no tokens, secrets, or raw response body.
  - Continue with the current credential.
- 401 reload/refresh failure:
  - Return the original or equivalent 401 error to OpenCode.
  - Do not surface raw Claude response bodies in the TUI.
- Second 401 after retry:
  - Stop immediately and return the 401.
  - Do not loop or attempt another reload/refresh.
- Missing stream finish reason:
  - Use `"unknown"` only when the reason is absent or `undefined`.
  - Preserve valid reasons unchanged.
- Integration state:
  - Only existing sync/writeback mechanisms may change persisted state.

## Testing

- Provider stream tests:
  - Red case: terminal `step-finish` and `finish` events without `reason` fail before the wrapper.
  - Green case: missing reasons become `"unknown"`.
  - Valid reasons remain unchanged.
- Tool pair tests:
  - Adjacent matching `tool_use`/`tool_result` remains valid.
  - Separated pairs are repaired or removed according to the upstream-safe algorithm.
  - Orphaned tool results are removed.
- Model config tests:
  - Claude CLI identity reports `2.1.217`.
  - Sonnet does not receive incompatible effort settings.
  - Opus 5 high keeps adaptive behavior and compatible effort configuration.
- Expiry tests:
  - Fractional expiry values are truncated to integers.
  - Integer expiry values remain unchanged.
- 401 and refresh tests:
  - External token rotation reloads the primary credential and retries once.
  - Expiring credentials refresh, persist, and retry once.
  - A second 401 does not trigger a retry loop.
  - The proactive timer uses a 1-hour refresh threshold and cleanup cancels the timer.
  - Logs and TUI output do not include secrets or raw response bodies.
- Contract test:
  - The built plugin/provider loads through the same exported contract OpenCode expects.

## Rollout and Verification

- Implement after this design in an isolated worktree.
- Keep commits separated by logical block.
- Required verification commands after implementation:
  - `pnpm test`
  - `pnpm run typecheck`
  - `pnpm run build`
  - `opencode2 api get /api/plugin`
  - A real `minion-opus-high` smoke test.
- Final implementation review must include the expected diff/worktree status and confirm that only intended files changed.

## Commit Sequence

1. V2 base dependency alignment and plugin/provider load contract test.
2. Provider-local terminal stream reason wrapper and tests.
3. Safe upstream ports for tool pairs, model config, expiry truncation, and TUI error sanitization.
4. Primary-only auth resilience: proactive refresh, 401 reload/refresh retry, cleanup, and tests.
5. Final verification fixes, if required, without broadening scope.

## Risks

- Dependency pinning may expose type/API differences that are not visible until the build runs.
- Stream event shape assumptions may differ between the local OpenCode runtime and upstream SDK versions; the contract test should catch export/load drift, while stream tests should catch terminal event drift.
- Selective upstream ports can miss implicit dependencies from adjacent upstream commits; each port should be reduced to the behavior required by this V2 provider.
- Auth retry behavior can accidentally loop if retry state is not request-scoped; tests must assert exactly one retry.
- Sanitizing TUI errors must not hide the existing rate-limit notice users rely on.
- Proactive refresh must not mutate Integration state outside existing sync/writeback flows.
