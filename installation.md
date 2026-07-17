# Install opencode-claude-auth locally for OpenCode v2

These instructions are for the local branch at `/Users/jeresrc/dev/lab/opencode-claude-auth` and OpenCode v2 only.

## 1. Build the local plugin

From this repository:

```bash
pnpm install
pnpm run build
```

## 2. Configure OpenCode v2

Edit your OpenCode configuration and add the local file URL to the plural `plugins` array:

```json
{
  "plugins": [
    "file:///Users/jeresrc/dev/lab/opencode-claude-auth/opencode-claude-auth.js"
  ]
}
```

## 3. Connect Anthropic in Integrations

1. Start or restart OpenCode v2.
2. Open **Integrations**.
3. Choose **Anthropic**.
4. Choose the **Claude Code credentials** method.
5. Select the Claude Code account to use.

The connection must remain active. There is no automatic account inference and no fallback when Anthropic is not connected through Integrations.

To change accounts, reconnect the Anthropic integration and select a different Claude Code account.

## What this installs

The local v2 plugin registers an Anthropic Integration OAuth method, redirects Anthropic catalog entries to the local `file://` provider, and routes AnthropicMessages requests through the local parser and private executor/createClaudeFetch implementation. Requests use Bearer OAuth tokens, Anthropic transforms, retry handling, and SSE-safe stream transforms.

If Anthropic requests start returning 401, reconnect Anthropic in OpenCode Integrations so OpenCode can store a fresh Integration credential.
