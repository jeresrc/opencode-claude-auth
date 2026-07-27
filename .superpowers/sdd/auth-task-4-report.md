# Primary Auth Resilience Task 4 Report

## Summary

- Added auth recovery coverage proving rejected JWTs, refresh tokens, and raw 401 bodies are not emitted to logs or `console.warn`.
- Added logger redaction coverage for token-like secrets embedded in error message strings.
- Updated `redactValue` to sanitize embedded Bearer JWTs, JWTs, OAuth query/body token fields, JSON token fields, and Anthropic API keys.
- No multi-account, core auth, or new feature behavior was added.

## TDD Evidence

- RED: `node --test --experimental-strip-types src/claude-fetch.test.ts src/logger.test.ts`
- RED result: failed only on `redacts token-like strings in error messages`; actual string still contained the embedded JWT and `refresh_token=secret-refresh`.
- GREEN: `node --test --experimental-strip-types src/claude-fetch.test.ts src/credentials.test.ts src/logger.test.ts`
- GREEN result: 82 tests passed, 0 failed.

## Gates

- `node --test --experimental-strip-types src/claude-fetch.test.ts src/credentials.test.ts src/logger.test.ts`: 82 passed, 0 failed.
- `pnpm run typecheck`: passed with exit code 0.
- `pnpm test`: 250 passed, 0 failed.
- `pnpm run lint`: oxlint found 0 warnings and 0 errors; oxfmt check passed.

## Files Changed

- `src/claude-fetch.test.ts`
- `src/logger.test.ts`
- `src/logger.ts`
- `.superpowers/sdd/auth-task-4-report.md`

## Notes

- `src/credentials.test.ts` was included in the focused gate as required by the brief, but did not need source changes for Task 4.
- Changes were made on top of the existing approved implementation in this worktree; no push was performed.

## Review fixes

- Added RED coverage for recursive logger redaction across nested objects, arrays, and `Error` objects containing Bearer tokens, real JWTs, OAuth token fields, and `sk-ant` keys while preserving `status`, `modelId`, `phase`, and `type` context.
- Added RED coverage for cyclic structured log data with stable `[Circular]` output and no leaked secret fragments.
- Added RED coverage for logger-level generic opaque `Bearer <token>` redaction, non-JWT `eyJ...` strings staying intact, context-preserving JWT replacement, and JWT segments ending in `-` or `_` leaving no token/remnant.
- Added focused `claude-fetch` coverage for logged API errors to ensure the private error-message sanitizer no longer leaves `JWT_REDACTED-` or `JWT_REDACTED_` remnants before logger redaction.
- Updated `src/logger.ts` to recurse through plain objects and arrays with `WeakSet` cycle safety, serialize `Error` objects as sanitized `name`, `message`, and `stack`, redact snake_case OAuth token keys, redact generic Bearer tokens, and replace only real three-segment base64url JWTs.
- Updated `src/claude-fetch.ts` JWT matching to the same real-JWT criterion without trailing word-boundary behavior.

### Review verification

- RED: `node --test --experimental-strip-types src/logger.test.ts` failed on the new recursive/generic/JWT/cyclic assertions before the logger implementation change.
- RED: `node --test --experimental-strip-types src/claude-fetch.test.ts` failed on `does not leave JWT segment remnants in logged API errors` before the claude-fetch sanitizer change.
- Focused: `node --test --experimental-strip-types src/logger.test.ts src/claude-fetch.test.ts src/credentials.test.ts`: 89 passed, 0 failed.
- Full: `pnpm test`: 257 passed, 0 failed.
- Typecheck: `pnpm run typecheck`: exited 0.
- Lint: `pnpm run lint`: oxlint found 0 warnings and 0 errors; oxfmt check passed.
