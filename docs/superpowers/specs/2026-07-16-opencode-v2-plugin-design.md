# OpenCode v2 Plugin Design

## Goal

Port `opencode-claude-auth` to the public OpenCode v2 plugin API for local use. The `v2` branch targets OpenCode v2 only. It does not preserve the v1 plugin contract, prepare an npm release, or modify the OpenCode checkout.

The port must retain the request compatibility required by Claude Code OAuth while using OpenCode v2 Integrations as the only credential source at inference time.

## Constraints

- Make all product changes in this repository on branch `v2`.
- Do not modify `/Users/jeresrc/dev/lab/opencode-v2`.
- Use the Promise plugin API from `@opencode-ai/plugin/v2`.
- Require an active OpenCode v2 Integration connection before inference. Do not fall back silently to local credentials.
- Continue reading Claude Code Keychain or `.credentials.json` entries when establishing a connection.
- Reuse public OpenCode Anthropic protocol and route exports rather than copying their request lowering or stream parser.
- Optimize for local operation against the sibling OpenCode v2 checkout. Package versioning and publication compatibility are out of scope.

## Approach

OpenCode v2 routes `aisdk:@ai-sdk/anthropic` directly through its native `AnthropicMessages` transport before public AI SDK hooks execute. The plugin will avoid that branch by replacing each Anthropic model's `package` through `catalog.transform` with a `file://` URL for a provider module built by this repository.

The provider module will reuse `AnthropicMessages.route` and `AnthropicMessages.protocol` from the public `@opencode-ai/ai` package. It will replace only the transport layer, where the plugin needs control over the final URL, headers, serialized request body, retries, and raw response stream.

This is preferred over redirecting through a synthetic AI SDK package identity because it preserves OpenCode's native Anthropic request conversion and parser without depending on unrelated AI SDK routing behavior.

## Components

### V2 Plugin Entrypoint

The default export will be a v2 Promise plugin object with a stable ID and `setup(context)` function. Setup will:

1. Initialize logging.
2. Register the Anthropic Integration method.
3. Register the Anthropic catalog transform.
4. Register the session context hook for Claude Code identity.
5. Return cleanup that disposes registrations owned outside the plugin scope, if any.

The v1 `auth.loader` hook, legacy plugin function export, periodic `auth.json` synchronization, and background sync timer will be removed from the v2 runtime path.

### Anthropic Integration

The plugin will register an OAuth Integration method for `anthropic`.

- Prompts list the Claude Code accounts currently available from Keychain or `.credentials.json`.
- Authorization selects the requested account and returns an OpenCode v2 OAuth credential containing access token, refresh token, expiry, method ID, and source metadata.
- Source metadata identifies the original account so refresh can update the correct Keychain item or credential file.
- Refresh reuses the existing direct OAuth refresh and write-back behavior, including its existing CLI fallback where applicable.
- Reconnecting through the Integration UI is the account-switching mechanism.

There is no inference-time fallback to `getCachedCredentials()`. If no active Anthropic connection exists, model creation fails with an actionable connection error.

### Catalog Transform

The catalog transform will target Anthropic models based on their effective provider/package identity. It will:

- replace their effective package with the built provider module's absolute `file://` URL;
- preserve provider ID, model ID, limits, capabilities, variants, and model metadata;
- set subscription-backed model costs to zero, matching current behavior;
- leave non-Anthropic providers untouched.

The provider URL is derived from `import.meta.url` so the plugin can be loaded from any local path after build.

### Provider And Transport Shim

The provider module will export the `model(modelID, settings)` contract expected by OpenCode v2 custom provider packages. It will construct the model from the public Anthropic route and install a custom transport.

OpenCode passes the active Integration OAuth token to a custom provider through provider settings. Because custom packages receive OAuth access tokens in the generic API-key slot, the shim will deliberately interpret that value as a Bearer token. A missing token produces a clear error rather than attempting anonymous or local fallback auth.

The transport will reuse existing plugin behavior:

- add `?beta=true` to `/v1/messages` requests;
- replace API-key auth with `Authorization: Bearer`;
- set Anthropic, Claude Code, Stainless, request, and session headers;
- apply model-aware beta selection;
- transform the final Anthropic request body, including system layout, billing marker, tool names, orphan repair, and effort compatibility;
- retry transient 429/529 responses within the configured cap;
- surface an unexpected 401 so the user can reconnect; OpenCode refreshes expiring Integration credentials before model creation, but does not expose a force-refresh operation to the provider transport;
- progressively exclude rejected long-context beta flags;
- transform raw response/SSE tool names before OpenCode's Anthropic protocol parser consumes the stream.

Existing transformation helpers will remain framework-independent. Transport-specific adaptation will be isolated in the provider module.

### Session Context

The v2 `session.hook("context")` hook will prepend the Claude Code identity only for Anthropic models and only when it is not already present. The post-serialization body transform remains responsible for enforcing the exact system-array layout expected by Claude Code OAuth.

## Request Flow

1. The user connects Anthropic through the OpenCode v2 Integration UI and selects a discovered Claude account.
2. OpenCode stores the OAuth credential and resolves or refreshes it before model creation.
3. The catalog supplies the Anthropic model with the provider shim's `file://` package.
4. OpenCode imports the provider module and passes the resolved credential in its settings.
5. OpenCode's public Anthropic protocol converts abstract messages and tools into an Anthropic request body.
6. The custom transport transforms the serialized request, applies OAuth headers, and sends it.
7. The transport performs bounded HTTP retries and rewrites the raw response stream.
8. OpenCode's public Anthropic parser consumes the transformed SSE and emits normal v2 model events.

## Error Handling

- Missing active connection: fail with instructions to connect Anthropic in OpenCode v2.
- No Claude accounts during authorization: fail with instructions to authenticate using Claude Code first.
- Invalid account selection: fail authorization without changing existing credentials.
- Refresh failure: propagate the failure and never send an expired token.
- Unexpected 401 after model creation: surface the provider response and instruct the user to reconnect; do not retry with the same rejected access token.
- Unsupported or malformed request bodies: preserve the existing safe no-op behavior where possible; fail before network I/O when OAuth-critical fields cannot be produced.
- Retry exhaustion: return the last provider response so OpenCode can classify and display it.
- Plugin cleanup/reload: rely on v2 registration scopes and explicit cleanup; do not leave intervals or global listeners behind.

## Testing

### Unit And Contract Tests

- Preserve existing credential, Keychain, signing, beta, logging, body, and SSE tests.
- Replace v1 hook-shape tests with v2 plugin contract tests.
- Verify the Integration method's prompts, authorization result, source metadata, and refresh behavior.
- Verify the catalog transform changes only Anthropic models and preserves model metadata.
- Verify the provider module rejects missing credentials.
- Exercise the custom transport with a fake upstream fetch for URL, Bearer auth, headers, body transforms, 401 passthrough, 429/529 retries, beta retries, and transformed SSE.
- Verify session identity injection is Anthropic-only and idempotent.

### Build And Local Integration

- Typecheck and build against the sibling OpenCode v2 plugin and AI packages.
- Run the complete plugin test suite.
- Load the built plugin from a temporary OpenCode configuration outside the OpenCode repository.
- Confirm the Integration appears and can create an active Anthropic connection.
- Run one low-cost live smoke request through OpenCode v2 and verify a normal streamed response.
- Confirm both repositories' worktrees afterward; the OpenCode worktree must remain unchanged.

## Non-Goals

- OpenCode source changes or patches.
- V1 compatibility on this branch.
- npm publication, semantic version selection, or compatibility across multiple v2 snapshots.
- Replacing OpenCode's Anthropic request converter or stream state machine.
- Supporting inference without an active v2 Integration connection.

## Known Risks

- The public v2 plugin and `@opencode-ai/ai` contracts are still evolving.
- A custom `file://` provider package is supported but less direct than a first-class transport hook.
- Anthropic may change private OAuth validation requirements, headers, beta flags, or Claude Code fingerprints.
- Static tests cannot prove which private headers remain mandatory; the live smoke test is required for confidence.
- OpenCode's generic custom-provider settings name an OAuth access token `apiKey`; the shim must keep the intentional Bearer reinterpretation explicit and tested.
- The public Integration API refreshes expiring credentials before model creation but does not let a provider force refresh after an unexpected 401.
