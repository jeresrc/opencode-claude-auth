# Promise Boundary Fix Report

## Summary

- Fixed the OpenCode V2 OAuth registration boundary so `authorize`, auto `callback`, and `refresh` return real Promises when consumed through `@opencode-ai/plugin/v2/promise`.
- Preserved primary-only selection, legacy suffixed metadata migration, refresh reload/writeback semantics, and existing transform registration flow.
- Confirmed live `minion-opus-high` smoke returns `opencode-claude-auth-promise-smoke` with no `.then is not a function`, `401`, or `finish undefined` markers.

## Root Cause

- Entrypoint `src/index.ts` imports `@opencode-ai/plugin/v2/promise`.
- `src/integration.ts` registered OAuth callbacks using Effect values from `@opencode-ai/plugin/v2/effect/integration`.
- Installed `@opencode-ai/plugin@1.18.3` has a declaration mismatch: `dist/v2/promise/integration.d.ts` re-exports `IntegrationMethodRegistration` from `../effect/integration.js`, while the Promise runtime consumes callback results as Promises.
- This allowed TypeScript to accept Effect-returning `authorize`, auto `callback`, and `refresh`, but the runtime saw objects with `.pipe` and no `.then`.
- Commit `6266e8a` exposed the latent boundary bug because legacy metadata reconciliation now calls `oauth.connect`, which consumes the registered OAuth method through the Promise path.

## RED Evidence

- Added direct registration coverage where a consumer calls Promise semantics on captured `registerAnthropicIntegration` output.
- Added setup-level regression where legacy suffixed metadata triggers reconciliation, fake `oauth.connect` consumes the captured registration with `.then`, and status polling must complete.
- Pre-fix focused test command failed as expected:
  - `pnpm exec node --test --experimental-strip-types src/integration.test.ts src/index.test.ts`
  - Direct boundary failures showed `typeof authorizationPromise.then` and `typeof refreshPromise.then` were `undefined`.
  - Setup regression reached `connect` but did not reach `connect:authorized` or `status`, matching the Promise consumer failure path.

## Fix

- `src/integration.ts` now imports the draft type from `@opencode-ai/plugin/v2/promise`.
- `authorize` is an async function returning an authorization object whose auto `callback` is a real `Promise<ClaudeOAuthCredential>`.
- `refresh` is an async function returning a real `Promise<ClaudeOAuthCredential>`.
- A local Promise registration type documents the runtime contract because plugin `1.18.3` currently exposes the Effect registration type from the Promise subpath.
- The final `draft.method.update` cast is isolated to the declaration mismatch boundary; no Effect is returned to Promise consumers.

## Local Verification

- Focused tests: `pnpm exec node --test --experimental-strip-types src/integration.test.ts src/credential-sync.test.ts src/index.test.ts` exited 0, 24 pass.
- Typecheck: `pnpm run typecheck` exited 0.
- Lint/format: `pnpm run lint` exited 0.
- Build: `pnpm run build` exited 0.
- Full suite: `pnpm test` exited 0, 278 pass.
- Diff whitespace: `git diff --check` exited 0.

## Live Smoke

- Shared proxy path: `/Users/jeresrc/Library/Application Support/orca/opencode-hooks/shared/plugins/opencode-claude-auth.js`.
- Original proxy content: `export { default } from "file:///Users/jeresrc/dev/lab/opencode-claude-auth/opencode-claude-auth.js"`.
- Temporary proxy content: `export { default } from "file:///Users/jeresrc/dev/lab/opencode-claude-auth/.worktrees/v2-provider-sync/opencode-claude-auth.js"`.
- Reload used: `OPENCODE_CONFIG_DIR=/Users/jeresrc/Library/Application Support/orca/opencode-hooks/shared opencode2 api delete /api/debug/location`.
- API check: `/api/plugin` included `opencode-claude-auth`; `/api/agent` included `minion-opus-high`.
- Live command: `OPENCODE_CONFIG_DIR=/Users/jeresrc/Library/Application Support/orca/opencode-hooks/shared opencode2 run --agent minion-opus-high "Reply with exactly: opencode-claude-auth-promise-smoke"`.
- Live result: exit 0, output included `opencode-claude-auth-promise-smoke`.
- Forbidden markers: no `.then is not a function`, no `401`, no `finish undefined` appeared in the smoke output.
- Restore: proxy restored exactly to the original base content and location reload was requested.

## Notes

- One initial combined smoke wrapper was interrupted by the harness; I verified it left the proxy on the worktree path, restored the exact original content, then retried using split phases.
- No raw tokens, auth headers, or credential bodies were printed in this report.
