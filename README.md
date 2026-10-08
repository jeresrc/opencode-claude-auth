# opencode-claude-auth

Local OpenCode v2 plugin that lets Anthropic requests use an active Claude Code OAuth connection selected through OpenCode Integrations.

This branch is documented for local OpenCode v2 use only. It is not an npm install guide.

## Prerequisites

- OpenCode CLI and Desktop 2.0.25. The provider deliberately retains `@opencode/ai` and `@opencode/plugin` 2.0.14 with the host compatibility adapters; these dependency pins need not match the application version.
- Claude Code installed and authenticated on this machine.
- This repository checked out at `/Users/jeresrc/dev/lab/opencode-claude-auth`.

## Local installation

Build the local provider and wrapper:

```bash
bun install --frozen-lockfile
bun run build
```

Configure OpenCode with the v2 plural `plugins` array and a local directory containing an `index.js` re-export of this repository entrypoint:

```json
{
  "plugins": ["/Users/jeresrc/.config/opencode/plugins/claude-auth"]
}
```

Then open OpenCode v2 **Integrations** and connect **Anthropic** using the **Claude Code credentials** method. The plugin uses Claude Code's current primary account.

To change accounts, select the account in Claude Code or `cswap`, then restart OpenCode when its sessions are idle. The plugin reconciles that primary Keychain source on startup. It also recovers expired V1-imported OAuth connections that lack source metadata when exactly one primary Keychain account is available. Valid unidentified connections and unrelated OAuth methods are preserved.

## Architecture

- `src/index.ts` composes the v2 plugin in this order: Integration, credential reconciliation, provider, then session context.
- `src/credential-sync.ts` compares the active Anthropic Integration credential with its selected Keychain source on startup and persists a replacement through V2's automatic OAuth connection flow when they differ.
- `src/integration.ts` registers the Anthropic Integration OAuth method labeled **Claude Code credentials**. Authorization and refresh reread the selected local Claude Code OAuth source instead of refreshing stale persisted tokens.
- `src/catalog.ts` uses `provider.transform` to redirect Anthropic catalog entries to the local provider module via a `file://` provider URL and associates them with the Anthropic Integration.
- `src/provider.ts` exposes an AnthropicMessages provider route backed by the native protocol/transport and a private request executor. The transport preserves required beta headers, and normalizes host models across separate SDK module instances.
- `src/claude-fetch.ts` keeps the private executor/createClaudeFetch path: it sets `Authorization: Bearer ...`, applies Anthropic request/response transforms, handles retries for retryable Anthropic responses, and preserves SSE streaming while transforming event data at event boundaries.
- On HTTP 401 after an in-place Claude Code login, the request executor attempts bounded credential recovery. Restarting OpenCode also reconciles the persisted Integration credential.

## Supported models

The verified model IDs are `anthropic/claude-opus-5-5#high`, `anthropic/claude-fable-5-1`, and `anthropic/claude-fable-5`. Opus 5.5 requires the Claude Code protocol version `2.1.280` or newer, advertised by this build.

Fable 5.1 is available as `anthropic/claude-fable-5-1`, including OpenCode
variants such as `anthropic/claude-fable-5-1#high`.

As of October 8, 2026, live OpenCode requests with valid OAuth credentials return Anthropic's "Third-party apps now draw from your extra usage" rejection. The same accounts work through the official Claude Code CLI. Upstream 2.2.1 contains no newer repair for this rejection; the credential migration fix does not restore subscription access or enable extra usage. Model availability in the catalog does not guarantee inference access.

## Diagnostics

Enable debug logging when reproducing auth issues:

```bash
export CLAUDE_AUTH_DEBUG=1
```

Logs are written to `~/.local/share/opencode/claude-auth-debug.log` with secrets redacted. Disable with:

```bash
unset CLAUDE_AUTH_DEBUG
```

## Disclaimer

This plugin uses Claude Code OAuth credentials to authenticate Anthropic API requests through a local OpenCode v2 Integration. Anthropic may change this behavior or its OAuth infrastructure. Use at your own discretion.

## License

MIT

## Upstream maintenance

See the [latest upstream audit](runbooks/upstream-sync-2026-10-08.md) for reviewed upstream revisions and the V2 adaptations retained in this fork. Compacted tool history now uses upstream's lossless placeholder repair by default; `OPENCODE_CLAUDE_AUTH_TOOL_REPAIR=drop` selects the alternative whole-turn drop strategy. Unsigned reasoning from other providers is still removed only from outgoing requests.

Validation: `bun run typecheck`, `bun run test`, and `bun run build`. The operating runbook includes live model and plugin checks.
