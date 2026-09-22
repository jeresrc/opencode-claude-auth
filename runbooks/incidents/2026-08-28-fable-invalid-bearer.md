# 2026-08-28 Fable Invalid Bearer Incident

## Impact

`anthropic/claude-fable-5` failed immediately in `opencode2` with `RequestExecutor.execute: Invalid bearer token`. The service, health API, model catalog, and custom Claude plugin were otherwise available.

## Root cause

Claude Code was logged out. Its macOS Keychain entry had been modified at approximately 06:41 local time and retained only an empty credential shell:

- Empty access token.
- Empty refresh token.
- `expiresAt: 0`.

The custom plugin validated credential field types but not non-empty values or a positive finite expiry. It could therefore treat the logged-out shell as a real Claude account and reconcile unusable credentials into the active Anthropic V2 integration.

A second durability gap was present: startup reconciliation ran before proactive credential refresh, while `syncAuthJson()` had no production caller. Valid refreshed credentials could remain in the source without reaching the fallback `auth.json` or the V2 integration in the correct order.

## Repair

- Reject empty access/refresh tokens and non-positive or non-finite expiry values.
- Synchronize valid source credentials to `auth.json` at startup and after successful refresh/reload paths.
- Run proactive refresh/synchronization before V2 integration reconciliation.
- Never synchronize a refresh result when source writeback fails.
- Keep `auth.json` permissions at `0600`.

## Verification requirements

- TypeScript typecheck passes.
- Build regenerates `dist`.
- Full test suite passes, including logged-out Keychain and refresh/sync ordering regressions.
- `claude auth status` reports logged in.
- Credential metadata is non-empty and unexpired without exposing values.
- `opencode2` service is restarted once to load the new build.
- A minimal `anthropic/claude-fable-5` request returns `FABLE_HEALTH_OK`.

## Related prior incidents

- 2026-08-25: `opencode2` update caused explicit plugins to disappear because the running service did not apply `OPENCODE_CONFIG`; a clean restart restored them.
- 2026-08-27: Fable reached Anthropic but returned rate-limit errors, confirming authentication was working at that time.
- 2026-08-28: failure changed to an immediate invalid bearer after Claude Code logout; this was an authentication incident, not a Fable availability incident.
