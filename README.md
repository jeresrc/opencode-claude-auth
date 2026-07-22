# opencode-claude-auth

Local OpenCode v2 plugin that lets Anthropic requests use an active Claude Code OAuth connection selected through OpenCode Integrations.

This branch is documented for local OpenCode v2 use only. It is not an npm install guide.

## Prerequisites

- OpenCode v2.
- Claude Code installed and authenticated on this machine.
- This repository checked out at `/Users/jeresrc/dev/lab/opencode-claude-auth`.

## Local installation

Build the local provider and wrapper:

```bash
pnpm install
pnpm run build
```

Configure OpenCode with the v2 plural `plugins` array and this file URL:

```json
{
  "plugins": [
    "file:///Users/jeresrc/dev/lab/opencode-claude-auth/opencode-claude-auth.js"
  ]
}
```

Then open OpenCode v2 **Integrations**, connect **Anthropic** using the **Claude Code credentials** method, and select the Claude Code account to use.

To select a different Keychain source, reconnect the Anthropic integration and choose that account. If Claude Code replaces the credentials inside the already selected source, the plugin reconciles that account when OpenCode starts. A live Integration connection is still required; the plugin uses its metadata to identify the selected source.

## Architecture

- `src/index.ts` composes the v2 plugin in this order: Integration, credential reconciliation, catalog, then session context.
- `src/credential-sync.ts` compares the active Anthropic Integration credential with its selected Keychain source on startup and persists a replacement through V2's automatic OAuth connection flow when they differ.
- `src/integration.ts` registers the Anthropic Integration OAuth method labeled **Claude Code credentials**. Authorization and refresh reread the selected local Claude Code OAuth source instead of refreshing stale persisted tokens.
- `src/catalog.ts` redirects Anthropic catalog entries to the local provider module via a `file://` provider URL and associates them with the Anthropic Integration.
- `src/provider.ts` exposes an AnthropicMessages provider route backed by the local parser and request executor.
- `src/claude-fetch.ts` keeps the private executor/createClaudeFetch path: it sets `Authorization: Bearer ...`, applies Anthropic request/response transforms, handles retries for retryable Anthropic responses, and preserves SSE streaming while transforming event data at event boundaries.
- On HTTP 401 after an in-place Claude Code login, restart OpenCode to reconcile the persisted Integration credential. Reconnect Anthropic manually only when selecting a different Keychain source.

## Supported models

Run `pnpm run test:models` after building to verify models available to your selected account.

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
