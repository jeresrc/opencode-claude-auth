# opencode2 Daily Health Check Context

## Scope

This runbook is specifically for `/Users/jeresrc/.bun/bin/opencode2`, the current OpenCode 2 release from `@opencode/cli`, channel `latest`. Do not substitute the stable `opencode` binary.

Starting September 12, 2026 at 06:00 America/Argentina/Buenos_Aires, the daily check is authorized to diagnose and repair local bugs after collecting the required diagnostics. Targeted, reversible source/configuration edits, local plugin builds, and necessary opencode2 service restarts are allowed. Preserve unrelated changes and user sessions/data. Do not authenticate accounts, reveal or manually replace credentials, perform broad software upgrades, or install/remove unrelated plugins. Report account-login or external-service blockers. After repairs, repeat service/API/plugin checks and all three exact model tests; determine final status from the verified state, requiring zero failed plugins.

## Required checks

1. Confirm the `opencode2` binary exists and record its version.
2. Run `opencode2 service status`.
3. On `@opencode/cli` 2.0.14, query `opencode2 api get /api/info`; require exit 0, the same version as the CLI, and a positive running PID. `/api/health` was removed and returns 404. Only legacy beta versions use `/api/health` and `healthy: true`.
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
- Fable smoke-test result.
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
