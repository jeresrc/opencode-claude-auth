# Live Regression Root Cause

Date: 2026-07-27

## Scope

- Original target worktree from the checkpoint: `/Users/jeresrc/dev/lab/opencode-claude-auth/.worktrees/v2-provider-sync`.
- That worktree was removed during this investigation. The base repo now has the same branch history at `/Users/jeresrc/dev/lab/opencode-claude-auth`.
- Original failing HEAD from the checkpoint: `2e51191` (`fix: harden cleanup and debug logging`).
- Current repo HEAD while writing this report: `28f40b7` (`fix: return promises from V2 OAuth registration`).
- Original failing OpenCode service from the checkpoint: `opencode2 v0.0.0-next-16289`.
- Current OpenCode service during recheck: `opencode2 v0.0.0-next-16293`.
- Active Orca shared proxy path used by the live provider smoke: `/Users/jeresrc/Library/Application Support/orca/opencode-hooks/shared/plugins/opencode-claude-auth.js`.

## Symptom

Prior sanitized live smoke at `2e51191` loaded the worktree plugin, model, and `minion-opus-high` agent, then failed the request path with:

```text
Error: A0(()=>X(Q)).then is not a function. (In 'A0(()=>X(Q)).then((J)=>Y(T(J)),(J)=>Y(u9(J)))', 'A0(()=>X(Q)).then' is undefined)
```

No `finish undefined`, `401`, or provider catalog load failure marker was reported in that run.

## Current Recheck

- The first guarded recheck changed the wrong proxy (`~/.config/opencode/plugins/opencode-claude-auth.js`) and did not exercise the worktree package. The proxy was restored.
- The active proxy was then identified from OpenCode logs as Orca's shared proxy under `~/Library/Application Support/orca/opencode-hooks/shared/plugins/`.
- A guarded recheck against the active proxy confirmed `/api/model` reported `claude-opus-5` from the worktree provider package while the proxy was temporary.
- On the current service/HEAD, the live command passed:

```text
opencode2 run --agent minion-opus-high "Reply with exactly: opencode-claude-auth-root-cause-smoke"
exit 0
output included: opencode-claude-auth-root-cause-smoke
```

- The active proxy was restored to the base repo target and `/api/debug/location` reload was requested after the recheck.

This means the exact failure is no longer reproducible in the current environment because the repo and OpenCode service have both advanced past the checkpointed failure state.

## Root Cause

The plugin entrypoint uses the Promise OpenCode V2 plugin API:

```ts
import * as Plugin from "@opencode-ai/plugin/v2/promise"
```

At the failing commits, `src/integration.ts` registered OAuth handlers using Effect API shapes:

```ts
import type {
  IntegrationDraft,
  IntegrationMethodRegistration,
} from "@opencode-ai/plugin/v2/effect/integration"
import { Effect } from "effect"

authorize: (_inputs) => Effect.try(...)
callback: Effect.sync(...)
refresh: (credential) => Effect.try(...)
```

Those values are Effect objects, not Promises. Effect objects have Effect methods such as `.pipe`; they do not have `.then`.

The installed `@opencode-ai/plugin@1.18.3` declarations allowed this mismatch because the Promise integration declaration re-exported the Effect registration type:

```ts
// dist/v2/promise/integration.d.ts
import type {
  IntegrationDraft,
  IntegrationMethodRegistration,
} from "../effect/integration.js"
export type { IntegrationDraft, IntegrationMethodRegistration }
```

So TypeScript accepted Effect-returning OAuth callbacks in a plugin whose runtime was consumed through the Promise API. At runtime, OpenCode's Promise-side OAuth consumer called `.then` on the registered OAuth result, and the Effect value did not provide it. That is the source-level explanation for the minified `.then is not a function` error.

## Culprit Commit

Culprit in the requested regression window: `6266e8a` (`fix: migrate legacy primary credential metadata`).

Reasoning:

- `ff06e17` already had the latent Promise/Effect mismatch in `src/integration.ts`, but the known-good live smoke did not exercise the Promise OAuth registration path.
- `b0022ea` changed durable refresh writeback in `src/credentials.ts`; it did not add the Promise OAuth registration trigger.
- `6266e8a` changed credential reconciliation to migrate legacy suffixed primary credential metadata through the sole primary account and call `integration.oauth.connect(...)` during setup when the active credential was stale or legacy-shaped.
- That `oauth.connect` path consumes the registered OAuth method through the Promise API, which calls `.then` on `authorize(...)` and its auto `callback`.
- Because `authorize`, `callback`, and `refresh` were still Effect values at `6266e8a` and `2e51191`, the new reconciliation path exposed the latent API-boundary bug.
- `2e51191` only hardened cleanup/debug logging in the relevant source files. It did not introduce the OAuth Promise/Effect mismatch or the `oauth.connect` trigger.

So `6266e8a` is the regression trigger. The underlying defect was the earlier mixed API contract in `src/integration.ts`, but it became live-impacting only after `6266e8a` started exercising the Promise OAuth connection path during setup.

## Evidence

- `src/index.ts` at the failing state imported `@opencode-ai/plugin/v2/promise`.
- `src/integration.ts` at the failing state imported `@opencode-ai/plugin/v2/effect/integration` and returned `Effect.try(...)` / `Effect.sync(...)` from OAuth callbacks.
- Installed package evidence shows the Promise integration `.d.ts` re-exported the Effect `IntegrationMethodRegistration`, explaining why the type checker did not reject the mismatch.
- The follow-up commit `28f40b7` fixes only the boundary shape in `src/integration.ts`: `authorize` and `refresh` are async functions and the auto `callback` is a real `Promise`.
- The new regression coverage in `28f40b7` directly asserts Promise semantics:
  - `src/integration.test.ts` checks `typeof registration().authorize({}).then === "function"`.
  - `src/integration.test.ts` checks `typeof authorization.callback.then === "function"`.
  - `src/integration.test.ts` checks `typeof registration().refresh(...).then === "function"`.
  - `src/index.test.ts` simulates the legacy suffixed metadata reconciliation path and consumes the captured registration with `.then`, matching the live failure boundary.
- The existing sanitized promise-boundary fix report records the pre-fix focused test failure: `typeof authorizationPromise.then` and `typeof refreshPromise.then` were `undefined`.

## Minimal Fix Proposal

For the failing `2e51191` state, the minimal source fix is to keep the `6266e8a` legacy metadata migration but make `src/integration.ts` honor the Promise runtime contract:

- Import the draft type from `@opencode-ai/plugin/v2/promise`, not the Effect integration subpath.
- Return real Promises from OAuth `authorize` and `refresh`.
- Return a real Promise from auto `authorize(...).callback`.
- Keep any type cast isolated at `draft.method.update(...)` only to work around the current `@opencode-ai/plugin@1.18.3` declaration mismatch.
- Add or keep focused tests that call `.then` on `authorize`, auto `callback`, and `refresh`, plus the setup-level legacy metadata reconciliation regression.

The already-present `28f40b7` commit implements this minimal fix shape.

## Sanitization

- No raw OAuth tokens, authorization headers, cookies, passwords, or credential bodies are included here.
- Paths, commit IDs, command names, sanitized error text, and smoke marker strings are intentionally retained as diagnostic evidence.
