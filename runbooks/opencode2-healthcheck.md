# opencode2 Daily Health Check Context

## Scope

This runbook is specifically for `/Users/jeresrc/.bun/bin/opencode2`, the current OpenCode 2 release from `@opencode/cli`, channel `latest`. Use this canonical entrypoint for health checks. Since September 27, 2026, `opencode` and `oc` also resolve to this same OpenCode 2 launcher; no V1 command remains installed.

Starting September 12, 2026 at 06:00 America/Argentina/Buenos_Aires, the daily check is authorized to diagnose and repair local bugs after collecting the required diagnostics. Targeted, reversible source/configuration edits, local plugin builds, and necessary opencode2 service restarts are allowed. Preserve unrelated changes and user sessions/data. Do not authenticate accounts, reveal or manually replace credentials, perform broad software upgrades, or install/remove unrelated plugins. Report account-login or external-service blockers. After repairs, repeat service/API/plugin checks and all three exact model tests; determine final status from the verified state, requiring zero failed plugins.

## Required checks

1. Confirm the `opencode2` binary exists and record its version.
2. Run `opencode2 service status`.
3. On current `@opencode/cli` 2.x (2.0.25 as of October 8), query `opencode2 api get /api/info`; require exit 0, the same version as the CLI, and a positive running PID. `/api/health` was removed and returns 404. Only legacy beta versions use `/api/health` and `healthy: true`.
4. Query `opencode2 api get /api/plugin` and compare it with the explicit plugins in `/Users/jeresrc/.config/opencode/opencode.json`. Parse this file as JSONC and accept both `plugin` and `plugins`. For configured local directories, compare the active source with their resolved `index.js` or `index.ts`, rather than requiring the directory string to equal the API's source file.
5. Require plugin ID `opencode-claude-auth` to be active. Its current entrypoint is `/Users/jeresrc/.config/opencode/plugins/claude-auth/index.js`, which re-exports `/Users/jeresrc/dev/lab/opencode-claude-auth/opencode-claude-auth.js`. Require both files and the underlying build output to exist; inspect the re-export to verify the original implementation is still used.
6. Run `claude auth status` and require `loggedIn: true` with a non-`none` authentication method.
7. Inspect Claude credential metadata without printing credentials:
   - The primary `Claude Code-credentials` source must contain non-empty access and refresh tokens and a finite, positive, future expiry.
   - The Anthropic entry in `/Users/jeresrc/.local/share/opencode/auth.json` must contain non-empty access and refresh tokens and a future expiry.
   - Report only presence, lengths, expiry timestamps, and short SHA-256 fingerprints. Never print credential values.
8. Run minimal smoke tests for Opus 5.5 and both Fable generations:

   ```sh
   /Users/jeresrc/.bun/bin/opencode2 run --model anthropic/claude-opus-5-5#high --format json 'Reply with only OPUS_5_5_HEALTH_OK.' </dev/null
   /Users/jeresrc/.bun/bin/opencode2 run --model anthropic/claude-fable-5-1 --format json 'Reply with only FABLE_5_1_HEALTH_OK.' </dev/null
   /Users/jeresrc/.bun/bin/opencode2 run --model anthropic/claude-fable-5 --format json 'Reply with only FABLE_HEALTH_OK.' </dev/null
   ```

   Require successful exits and the expected responses. Fable 5.1 requires
   the plugin to advertise Claude Code `2.1.251` or newer; Opus 5.5 requires `2.1.280` or newer. The current fork advertises `2.1.280`.
   When invoking through Python, use `stdin=subprocess.DEVNULL`; inherited
   script input can be appended to the prompt by the CLI.

9. After a CLI migration or a report of missing history, verify session visibility, not just database row preservation. Resolve each affected project with `opencode2 api get /api/location -H 'x-opencode-directory:/absolute/project/path'`, compare its `project.id` with saved `session_v2.project_id`, and run `opencode2 session list` from the affected directory. Require historical root sessions to appear and their messages to load. A mismatch that hides history is an incident even when all original database IDs remain present.

## Incident classification

Report `INCIDENT` when any required command fails, the API is unhealthy, any plugin has failed, an explicit plugin is not active, a local plugin path is missing, Claude Code is logged out, credential metadata is empty/expired/invalid, or any model smoke test fails. Distinguish detected pre-repair incidents from the verified final status.

Classify authentication failures separately from transient upstream failures:

- `Invalid bearer token` or HTTP 401: authentication incident.
- `Third-party apps now draw from your extra usage`: rejected request; first verify that the private Claude fetch actually executes under the host fetch context. On October 8, a local transport bypass produced this message with valid credentials and was repaired without changing billing settings. The message alone does not prove a subscription restriction. Do not enable extra usage automatically or treat a successful `cswap`/Claude Code probe as a successful OpenCode model test.
- HTTP 429 or 529: rate-limit/overload incident.
- HTTP 502, 503, or 504 after retries: transient gateway incident.
- An Opus 5.5 rejection requiring Claude Code 2.1.280 or newer, or Fable 5.1 requiring 2.1.251 or newer: custom-plugin version compatibility regression.
- Any missing explicitly configured plugin after an `opencode2` update: likely post-update plugin-loading regression.

## Known regression signatures

- OpenCode 2 updates have previously restarted the service without applying `OPENCODE_CONFIG`, causing explicit plugins to disappear.
- On 2026-09-07, `0.0.0-beta-19242` logged `configured plugin path must be a directory` for all five explicitly configured plugin files, despite the public configuration guide documenting file paths. The current local workaround is five directories under `/Users/jeresrc/.config/opencode/plugins/`, each with an `index.js` entrypoint. Do not interpret this as a universal V2 restriction.
- The service must load `/Users/jeresrc/.config/opencode/opencode.json`. The persistent service environment sets `OPENCODE_CONFIG_DIR=/Users/jeresrc/.config/opencode` and `OPENCODE_CONFIG=/Users/jeresrc/.config/opencode/opencode.json`. If loading regresses, inspect `/api/config` and safe process-environment metadata; an already-open Orca client has previously recreated the daemon with its old config directory. Repair the source of incorrect configuration selection, restart when necessary, and verify the configured plugins.
- On 2026-09-09, the five plugin directories were explicitly registered with absolute paths in that configuration. Orca's shared `opencode.json` is a symlink to it; absolute entries keep these plugins available when Orca overrides the configuration directory. Do not remove the explicit entries just because global directory discovery also finds them.
- OAuth refresh must invoke `node`, not `process.execPath`: inside the compiled OpenCode executable, the latter launches `opencode2 -e` and fails with CLI help instead of refreshing. This was corrected and verified with a real credential renewal on 2026-09-09; inspect Node availability in the service's PATH if it recurs.
- Orca's generator in `/Applications/Orca.app/Contents/Resources/app.asar` (`out/main/index.js`) rewrites `opencode-hooks/shared/plugins/orca-opencode-status.js` with a default `{ id, server }` export, incompatible with this preview's `{ id, setup/effect }` loader. Editing only the generated file is temporary. On September 12, the redundant discovery was prevented with `/Users/jeresrc/.config/opencode/bin/opencode2`: `/Users/jeresrc/.bun/bin/opencode2` now links to this launcher, which executes the unchanged preview binary at `/Users/jeresrc/.bun/install/global/node_modules/@opencode-ai/cli/bin/opencode2.exe`. It replaces only Orca's generated shared/overlay config directories with the intended user config directory, preserving unrelated config selection, arguments, exit codes, and Orca hook environment. The explicitly configured `orca-opencode-status-compat` remains active and imports the unmodified generated source for event handling. Never remove that required adapter or its imported source to obtain a green check.
- Check the launcher symlink after CLI updates: an installer may replace it. Reapply this narrow launcher only if the same incompatible discovery recurs and the real preview executable path remains valid. Orca regeneration itself does not overwrite the launcher. Direct execution of `opencode2.exe` bypasses the guard; use the required `/Users/jeresrc/.bun/bin/opencode2` entrypoint. Rollback metadata is `/Users/jeresrc/.codex/automations/salud-diaria-de-opencode2/launcher-backup-2026-09-12.json`; restoring its original symlink target reverses the entrypoint change.
- Repair tests: `python3 /Users/jeresrc/.codex/automations/salud-diaria-de-opencode2/tests/launcher_test.py` verifies config selection, argument/exit propagation, and preserved hook environment. `bun /Users/jeresrc/.codex/automations/salud-diaria-de-opencode2/tests/orca_adapter_test.mjs` verifies busy/idle forwarding and disposal using synthetic hook coordinates and intercepted HTTP, without contacting Orca.
- Claude Code logout can leave a `Claude Code-credentials` Keychain shell with empty token strings and `expiresAt: 0`. This is not a valid account and must never be reconciled into OpenCode.
- The custom Claude plugin must refresh/synchronize valid source credentials before reconciling the active V2 Anthropic integration.
- The root plugin file is a wrapper around `dist/index.js`; validate the build output rather than using the wrapper timestamp as the build timestamp.

## Report format

Return concise English with:

- Overall `OK` or `INCIDENT`.
- `opencode2` version and service/API health.
- Active and failed plugin counts.
- Claude login and credential-metadata health.
- Opus 5.5 high, Fable 5.1, and Fable 5 smoke-test results.
- Version change and likely post-update regression when prior-run context is available.
- For each issue: component, path/source, summarized error, and recommended next action.

## September 22, 2026 migration

- The user authorized migration to `@opencode/cli@latest`, plugin compatibility repairs, upstream synchronization and fork publication. Installed release: **2.0.14**. This does not authorize unattended broad upgrades on future health checks.
- `/Users/jeresrc/.bun/bin/opencode2` still points to the Orca-safe launcher. Its current target is `/Users/jeresrc/.local/share/opencode2-runtime/node_modules/@opencode/cli/bin/opencode.exe`. This separate package prefix avoids overwriting the stable `opencode` alias. The historical raw beta target above is retained only for rollback.
- Package updates must also review the Claude fork's pinned SDK/Effect dependencies. Current versions: `@opencode/ai` and `@opencode/plugin` **2.0.14**, Effect **4.0.0-rc.112**. Do not point the launcher back at the old package during normal checks.
- Current plugin API uses `provider.transform`/`ProviderEditor`, `IntegrationEditor`, Effect-returning protocol `onHalt`, and generation `maxTokens`. Use the native Anthropic transport so body features carry required beta headers. Its local SDK validates `LanguageModel` with `instanceof`, requiring a boundary normalization for the compiled host's separate SDK instance.
- Superpowers fork is synchronized with upstream **6.4.1**. Skills require `path`, and the bootstrap skips child sessions. Orca compatibility uses `context.session` on current hosts, while retaining support for old `context.client`.
- Default model and `minion-opus-high` now use **Claude Opus 5.5**, variant **high**. Initial empty plugin inventories during startup must be retried after initialization; final success still requires every configured plugin active and zero failures.
- Old beta TUI processes cannot talk to the new service (`/api/health` vs `/api/info`) and can repeatedly try to spawn obsolete daemons. Four idle beta TUIs were terminated with no active sessions. Reopen saved conversations with the `opencode2` launcher.
- Private rollback material (source/config snapshots and consistent SQLite backup) is at `/Users/jeresrc/.local/share/opencode2-migration/2026-09-22`. Never overwrite a newer live database with this backup: preserve subsequent sessions and stop the service before any coordinated rollback. Current session data was migrated in place without deleting conversations.
- Validate Orca using both `bun .../tests/orca_adapter_test.mjs` and the same command with `--modern`. Launcher tests now target the current package location.

## September 22 session visibility repair

- The initial migration verification preserved every session/message ID but missed project-filter visibility. Sandia had 243 sessions (7 roots) under an older project ID, while its current resolver selected another ID for the same canonical repository. SBD had the same issue for 144 sessions (27 roots). The mismatch already existed in the pre-migration backup; the new client's project-scoped list exposed it.
- Reconciled only `session_v2.project_id` for those two proven same-canonical-project mappings in one SQLite transaction. Preserved session IDs, directories, parent links, messages, timestamps, models and every other row field. No project deletion, backup restore, service restart, or active-session interruption. Checked that no affected session was running before applying. Private exact rollback rows and audit are in the migration backup directory as `session-project-repair-before.json` and `session-visibility-audit.json`.
- Sandia now lists all 8 root conversations from Shipworm, including `ses_f5a613c73ffeIODXRw6YZT2cUC` (Configurar personal/main como único origin activo), whose 1,187 messages load in the real TUI. Existing child sessions remain attached. Other live projects were audited; only those two stale project identities required repair.
- Do not merge projects based only on similar names. Prove the resolver's canonical repository matches the stored project worktree, preserve a per-row rollback journal, and avoid affected running sessions. The session move API returns early for an unchanged directory, so it does not repair this identity mismatch. Treat this as a targeted projection repair, not permission to restore an old database over new work.


## Orca verification scope (September 24, 2026)

- The September 12 redundant-discovery repair remains valid: require the explicitly configured adapter active and zero failed plugins. Both legacy and modern adapter tests verify event handling with synthetic hook coordinates; they do not verify actual Orca pane delivery.
- On September 23, the shared daemon lacked Orca hook coordinates, so an active adapter could silently deliver no status. On September 24, the replacement daemon had non-empty hook port/token, pane key, and endpoint variables (presence inspected without exposing values). This removes the observed missing-environment condition but does not establish correct routing across live panes.
- Keep per-pane busy/idle/attention delivery explicitly unverified until exercised end to end. Do not repair routing by assigning one terminal's pane identity globally to the shared daemon. Successful service/plugin/model checks establish inference health, not complete Orca UI integration.


## September 25 bearer recovery and Orca duplicate IDs

- A later September 25 incident reproduced `Invalid bearer token` on all three models although Claude remained logged in and both stores had future expiries. The primary Keychain credential had rotated while OpenCode retained an older credential. Future expiry alone does not prove server acceptance.
- `reloadPrimaryCredentials` now reads and seeds the primary account when invoked in a provider module scope that has not run plugin setup. Previously it returned null before reading Keychain, preventing the existing single-retry 401 recovery. A regression test covers a fresh module, a stale integration bearer, successful reload/retry, and zero Keychain writes. Rebuild and restart when needed; do not manually copy credentials.
- Orca 1.4.210 generated both `plugins/orca-opencode-status.js` and `plugins/orca-opencode2-status.js` with ID `orca-opencode-status`. The opencode2 copy failed duplicate-ID validation. Its default ID was corrected to `orca-opencode2-status`, retaining its `/hook/opencode2` endpoint, agent guard and setup function. The explicit compat adapter remains active. Final inventory after this repair: 93 active, zero failed.
- The installed Orca generator in app.asar still hardcodes the common ID; regeneration may restore the collision. Check both generated copies after Orca changes and preserve distinct IDs. The app bundle was not modified. Backup of the affected generated file and compiled credential module: `/Users/jeresrc/.codex/automations/salud-diaria-de-opencode2/repair-2026-09-25/`.
- Run the repository test script (`bun run test`, which uses Node), not Bun's native test runner. Provider tests can invoke a build; run broad verification in an isolated source/dist copy when user sessions are active to avoid rebuilding hot-loaded modules.


## September 27, 2026 V1 retirement

- The user authorized retiring OpenCode V1 across this Mac. `/Users/jeresrc/.bun/bin/opencode` and `/Users/jeresrc/.bun/bin/oc` now link to `opencode2`, which retains the Orca-safe launcher and the separate `@opencode/cli` runtime. The interactive zsh alias `oc` explicitly selects `opencode2`; old shells with `oc=opencode` also reach V2 through the replaced executable link.
- Removed global `opencode-ai@1.18.18` and obsolete `@opencode-ai/cli@0.0.0-beta-19242` using Bun, including their global manifest/lock entries. Archived the unused platform binary packages. Other installed package versions are unchanged. Do not reinstall these packages or restore their historical executable links during routine checks.
- The active Orca profile already has `settings.agentCmdOverrides.opencode = "opencode2"`. Keep the `opencode` agent identity and historical session metadata; that identity now invokes V2 and does not imply a V1 executable.
- Rollback material is at `/Users/jeresrc/.local/share/opencode2-migration/2026-09-27-command-aliases/`: original package manifest/lock, command-link map, shell aliases and retired packages. No session database or credentials were changed.
- Future health checks should also verify that `opencode`, `oc` and `opencode2` resolve to the same launcher, including interactive zsh and executable PATH lookup.
- During command retirement, the pre-existing desktop-managed service reported 2.0.18 while the dedicated CLI was still 2.0.14. The user explicitly authorized alignment, so the dedicated runtime was upgraded to exact `@opencode/cli@2.0.18` in isolated staging, its unchanged postinstall inspected/executed, then installed at the preserved runtime path. Desktop service and all three commands now match 2.0.18. No service restart or session interruption was required; the existing desktop service PID remained unchanged. The prior runtime is backed up alongside the retirement material. This targeted authorization does not permit unrelated unattended upgrades.
- Orca regenerated the duplicate default ID in `~/.config/opencode/plugins/orca-opencode2-status.js`. Corrected it again to `orca-opencode2-status`; the live service reloaded it automatically and reached 95 active / zero failed plugins without restart. The generator recurrence risk documented above remains.

- Claude fork dependencies remain pinned to `@opencode/ai` / `@opencode/plugin` 2.0.14 and Effect 4.0.0-rc.112; reviewed the existing boundary compatibility and preserved these working pins. Superpowers 6.4.1 is unchanged. Verify actual plugin loading and all three model tests before changing SDK pins solely to match CLI version numbers.
- Bun global `node_modules/.bin/opencode`, `opencode2` and `oc` also forward to the canonical commands; package removal had left stale internal links, which were corrected.


## Desktop authentication over Tailscale (September 27, 2026)

- User reported `auth failed` in Desktop (corrected initial wording of migration failed). Desktop/CLI/service already match 2.0.18. Actual V1 migration endpoint `/api/experimental/migration/v1` reports `completed`.
- Confirmed upstream/shipped Desktop `windows/security.ts` only attaches the sidecar Basic credential to `http://127.0.0.1/*` and `http://localhost/*`. A configured service hostname of `100.78.113.69` is adopted unchanged, so Desktop renderer requests omit auth and return401; the existing service credential succeeds with200. CLI inference success does not establish Desktop connectivity.
- Mac Tailscale is Running/Online, health reports no errors, and a ping to msi-server succeeds. The user requires preserving Tailscale access. Do not disconnect/log out/reset Tailscale or weaken server authentication.
- September 27 preference (superseded by the explicit October 8 iOS request below): Desktop connects only to the local server; Mac Tailscale connectivity must remain active. Service hostname was `127.0.0.1`, with no Tailscale Serve/Funnel forwarding at that time. Tailscale itself remains Running/Online with no health errors. Existing service password is unchanged; unauthenticated localhost requests return401 and authenticated requests200.
- Applied after the user explicitly authorized restarting despite the active deployment and resuming it afterward. Backed up `service.json` privately, changed only hostname, restarted once, verified2.0.18 PID47645 on127.0.0.1:49374. Desktop automatically reconnected and displayed project/session history. Resumed the existing child session `ses_f1a6bf755ffeuLOBL173iYIbis` (Release offline-first stack to prod), preserving its parent and worktree, with one prompt to inspect actual deployment state before repeating steps. Prompt consumed; session running. Do not send duplicate resume prompts. Artifacts and private config backup: `/Users/jeresrc/.local/share/opencode2-migration/2026-09-27-desktop-auth/`.
- Desktop2.0.18 includes Settings > Local Server > Worktrees with inventory, disk management, linked sessions and deletion safeguards. Its current Loading state is caused by the auth incident. Backend capability/UI source confirmed; actual worktree listing must be verified after connection repair.

- Post-repair verification:95active/0failed plugins; all three exact model smoke tests pass. Desktop sidebar enabled via Preferences > Tabs > Vertical and verified visually. This sidebar lists open sessions; Home provides project/session discovery. No Desktop application-bundle or credential modification.


## Mandatory diagnostic-session cleanup (September 27, 2026)

The user explicitly authorized deleting OpenCode health-check sessions after every check. This exception applies only to disposable diagnostic sessions, never user work or the Codex automation task.

- Capture and persist every session ID created by initial model probes, retries, repair diagnostics and post-repair verification, including failures and untitled sessions. Use structured output and a small per-run cleanup ledger. If no ID is emitted, reconcile the command time window, run directory and exact diagnostic prompt; do not match broad words such as "health" or "smoke" in titles.
- Save sanitized results and failure evidence in automation memory/artifacts first. Then, in a finally-style step on both OK and INCIDENT outcomes, delete all sessions owned by that run with `/Users/jeresrc/.bun/bin/opencode2 session delete <sessionID>` or the supported session API. Stop a running diagnostic only when its ownership by the check is proven.
- Verify that every recorded ID is absent from the service. Retry briefly and report remaining IDs as a cleanup incident. Carry safely identified leftovers in the ledger into the next run. Never write directly to the session database or delete unrelated descendants.
- Keeping the diagnostic results in automation records is sufficient; do not retain OpenCode test conversations as the evidence store.


## Sonnet 5.5 and fork maintenance (September 28, 2026)

- A reported `ModelUnavailableError: anthropic/claude-sonnet-5-5` reproduced only in the existing `misty-comet` worktree. The same model worked in a fresh location. Supported `opencode2 reload` refreshed location catalogs and made the affected worktree succeed without restarting the service. Always test the failing location; the global model list alone is insufficient evidence.
- The Claude Auth fork now gives `sonnet-5-5` a specific effort-compatible rule before the legacy Sonnet exclusion, preserving requested medium effort and adaptive thinking. The protocol version remains 2.1.280; this incident did not require changing it or upgrading packages.
- Include `anthropic/claude-sonnet-5-5#medium` with the exact prompt `Reply with only SONNET_5_5_HEALTH_OK.` in future model checks and diagnostic cleanup. Require exit zero and the exact response.
- The user's standing preference is to maintain the installed local `opencode-claude-auth` and publish tested fixes to `jeresrc/opencode-claude-auth:v2`, considering upstream changes. Before plugin maintenance, fetch both remotes and review the delta from the latest upstream audit. Record incorporated, already-equivalent and deferred changes. Preserve V2 SDK compatibility and existing fork fixes; do not blindly merge upstream V1 code or upgrade unrelated packages.
- See `AGENTS.md` and `upstream-sync-2026-09-28.md` for the durable workflow and upstream 2.2.1 audit.

## September 29, 2026 attached-image and stalled-tool repair

- OpenCode 2.0.18 supplies `Media.Asset` under a media part's `media` field, while the fork's pinned 2.0.14 Anthropic protocol expects `mediaType` and `data`. A screenshot in a user prompt caused `TypeError: undefined is not an object (evaluating 'part.mediaType.toLowerCase')` before inference. Text-only health probes did not detect this incompatibility.
- `src/media-compat.ts` now adapts outgoing media at the provider protocol boundary, preserving stored history, legacy media, filenames and metadata. Supports inline bytes/base64, public URLs and Anthropic file references; explicitly rejects foreign references and authenticated URLs unsupported by the pinned SDK. No dependency upgrade or credential change.
- Validate media regressions with a disposable Opus session containing a small synthetic PNG, in the affected worktree. Apply the same immediate session ledger and verified cleanup requirements. Do not remove the user's attachment or rewrite their messages to make inference succeed.
- Supported reload did not evict the imported provider module during this repair. After an empty active-session check, one service restart loaded the verified build; attached-image Opus and all four standard model probes passed. Preserve working SDK/Effect pins.
- A concurrent child hang used `await new Promise(r=>r)` inside `execute`; returning the resolver from a Promise executor does not settle it. Interrupt the proven stuck session through `/api/session/{id}/interrupt?resume=false`, then resume that existing session with instructions to inspect current state and use bounded waits. Do not duplicate the task or repeat already completed external actions blindly.
- Audit: `upstream-sync-2026-09-29.md`. Sanitized evidence, build backup and cleanup ledgers: `/Users/jeresrc/.codex/automations/salud-diaria-de-opencode2/opus-repair-2026-09-29/`.


## October 8, 2026 host fetch context repair

- OpenCode 2.0.25 supplies a host `FetchHttpClient.Fetch` reference. Effect merges that execution context into its HTTP client, so providing a private fetch only while constructing the executor lets the host fetch bypass `createClaudeFetch`, including its existing auth, request transforms and recovery. Bind the same private fetch with `Effect.provideService` around transport execution too. Preserve host HTTP middleware and the pinned SDK/Effect versions.
- The provider regression test supplies an outer host fetch and requires zero host calls, one private call, OAuth headers, transformed system content and one successful host middleware invocation. Keep this coverage when changing the executor.
- All four model probes, real file-read/shell execution and an attached synthetic image passed after this repair. The earlier provider-side restriction diagnosis was superseded by the reproduced local context bug. CLIProxyAPI and upstream issue 292 were reviewed as references; the installed implementation remains the native plugin.


## October 8, 2026 Desktop and iOS coexistence

- The user explicitly requires keeping the paired iOS connection through Tailscale while repairing Desktop. This supersedes the September 27 preference against forwarding. Running `opencode service set hostname 100.78.113.69` reproduced the Desktop authentication failure on 2.0.25: its renderer still injects sidecar credentials only for localhost/127.0.0.1. The authenticated Tailscale endpoint worked while the local endpoint was unavailable.
- Keep the service hostname `127.0.0.1`. Persistent Tailscale Serve TCP forwarding maps `100.78.113.69:49374` to `127.0.0.1:49374`, installed with `tailscale serve --bg --tcp=49374 tcp://127.0.0.1:49374`. This preserves the iOS endpoint and supports HTTP/WebSocket traffic on the same server. Preserve the pre-existing HTTPS Serve route `https://m4.taildcd106.ts.net` to that same local service. No Funnel/public exposure or password change.
- For future pairing, use `opencode pair --url http://100.78.113.69:49374` (or the existing HTTPS tailnet hostname). `--url` changes the advertised pairing address without changing the service bind address. Do not switch the service hostname back to the Tailscale IP or a wildcard as a pairing workaround. Pairing links are one-use credentials; do not store them in public audit output.
- The user approved restarting and resuming the active “Merge captain: progressive merge” child session `ses_ee3352526ffeXaQMRvXCveo8QB`. Its parent resumed the child after the initial interruption; the service restart retained that same child, which was running again afterward. Avoid duplicate resume prompts when automatic recovery has already resumed it. Original Desktop tabs and session contents remained visible.
- Verified all three origins (loopback, original Tailscale IP/port and HTTPS tailnet hostname) return 401 without credentials and 200 with the unchanged service credential, reporting the same PID. Desktop visibly loaded the working child session after reconnecting; 94 plugins active, zero failed. Opus 5.5 high, Fable 5.1, Fable 5 and Sonnet 5.5 medium all returned their expected replies; all four diagnostic sessions were deleted and verified absent. This verifies the remote endpoint from the Mac; physical iOS UI operation still requires the user's device.
- Private configuration backups, proposed configuration, prior Serve configuration and sanitized connectivity results: `~/.local/share/opencode2-migration/2026-10-08-desktop-ios/`. Model probes and verified disposable-session cleanup: `/Users/jeresrc/Documents/ChatGPT/opencode2/desktop-ios-2026-10-08-checks.json`. To undo only the added TCP forward, use `tailscale serve --tcp=49374 off`; never reset all Serve configuration, which would remove the pre-existing HTTPS route too.
