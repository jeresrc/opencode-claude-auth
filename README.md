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

To change accounts, reconnect the Anthropic integration and select a different account. A live Integration connection is required; the plugin does not infer an account or fall back when no connection is active.

## Architecture

- `src/index.ts` composes the v2 plugin in this order: Integration, catalog, then session context.
- `src/integration.ts` registers the Anthropic Integration OAuth method labeled **Claude Code credentials**. Authorization returns the selected local Claude Code OAuth credential, and refresh proactively asks OpenCode to refresh the Integration credential using the selected source.
- `src/catalog.ts` redirects Anthropic catalog entries to the local provider module via a `file://` provider URL and associates them with the Anthropic Integration.
- `src/provider.ts` exposes an AnthropicMessages provider route backed by the local parser and request executor.
- `src/claude-fetch.ts` keeps the private executor/createClaudeFetch path: it sets `Authorization: Bearer ...`, applies Anthropic request/response transforms, handles retries for retryable Anthropic responses, and preserves SSE streaming while transforming event data at event boundaries.
- HTTP 401 means the saved Integration credential is no longer usable; reconnect Anthropic in OpenCode Integrations.

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
