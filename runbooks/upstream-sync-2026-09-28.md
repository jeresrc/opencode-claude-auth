# Upstream review: September 28, 2026

Reviewed `griffinmartin/opencode-claude-auth` from `87e6720` through `8aad811` (2.2.1), and fetched `jeresrc/opencode-claude-auth:v2` before publication.

The only functional upstream change is `662ee99`: advance the advertised Claude Code version from 2.1.257 to 2.1.280 for Opus 5.5. Our V2 fork already advertises 2.1.280. The remaining changes are upstream's release version and changelog; do not adopt its V1 entrypoint or relabel our V2 package as that release. The September 22 audit's intentionally deferred multi-account/async refresh adaptation remains deferred.

Local maintenance:

- Preserve Sonnet 5.5 effort with a specific model rule before the legacy Sonnet exclusion. Regression tests cover medium effort, adaptive thinking and the compatible effort beta while retaining the older Sonnet/Haiku rules.
- Publish the previously installed primary-credential recovery fix: a provider loaded in a separate module scope can discover the primary account and retry a stale bearer without plugin setup or Keychain writes. Its regression test verifies the actual 401/reload/retry sequence.
- Preserve SDK pins `@opencode/ai` and `@opencode/plugin` 2.0.14, Effect 4.0.0-rc.112, and Superpowers 6.4.1.

The reported Sonnet 5.5 failure was `ModelUnavailableError` in an existing worktree before any Anthropic request. A fresh location succeeded, the affected worktree reproduced the failure, and supported configuration reload made the same worktree succeed. This is a stale location catalog, not an authentication or minimum Claude Code version rejection. Keep the actual model ID and test the affected location; a successful global model listing alone is insufficient.

Standing maintenance instructions are in `AGENTS.md`. Each maintenance pass should review upstream, preserve local V2 compatibility, test/install locally, publish to the user's fork, and update this audit trail. See the health-check runbook for diagnostic cleanup.


## Verification

- Isolated build/typecheck passed; Node test suite: 352 passed, zero failed.
- Installed only the changed compiled model configuration, then used supported configuration reload; OpenCode stayed at 2.0.18 with the same service PID.
- Affected-worktree live tests passed: Sonnet 5.5 medium (1.7s), Opus 5.5 high (2.2s), Fable 5.1 (2.4s), Fable 5 (3.2s), each with its exact health marker and exit zero.
- Root and affected-worktree plugin inventories each had 95 active and zero failed plugins.
- Removed all seven sessions created for this investigation, including the failing reproduction; the final four deletions were individually verified via API 404. User work and the original failed session were preserved.
- The existing daily automation now tests Sonnet 5.5 as well and records the standing local-install/fork-publication maintenance workflow.
