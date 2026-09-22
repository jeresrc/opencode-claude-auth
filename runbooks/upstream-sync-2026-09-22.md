# Upstream review: September 22, 2026

## Claude Auth

Reviewed `griffinmartin/opencode-claude-auth` through `87e6720` (release 2.2.0). This fork targets native OpenCode V2; upstream main still uses the V1 plugin SDK, so its entrypoint and dependency graph cannot replace ours wholesale.

Imported compatible upstream improvements:

- `8de49c8`: preserve signed thinking during compaction repair, default placeholder tool results, optional whole-turn drop, fixed-point adjacency repair and its regression tests.
- `5532c37`: parse future absolute `expires_at` milliseconds, retaining fractional-expiry normalization and adding invalid-metadata guards.
- `09a13b4`: reviewed Claude protocol version update; advanced further to **2.1.280**, the minimum required by live Opus 5.5 responses.

Retained local fixes for primary credential selection, rejecting logged-out Keychain shells, refreshing through Node rather than the compiled host, durable writeback, proactive refresh, startup Integration reconciliation, HTTP 401 recovery, safe streaming/transport retries, and unsigned cross-provider reasoning.

Upstream's multi-account discovery and asynchronous credential refresh/backoff refactor were reviewed but are not blindly merged into this synchronous, primary-account V2 integration. Their V1 entrypoint and account-selection assumptions require a separate adaptation; they are not prerequisites for the verified migration. Do not claim this fork is byte-for-byte synchronized with upstream main.

The V2 migration uses `@opencode/ai`/`@opencode/plugin` 2.0.14 with Effect 4.0.0-rc.112, provider transforms, native Anthropic beta negotiation, and cross-module model normalization. Live checks include Opus 5.5 high, both Fable generations, tool execution and conversation continuation.

## Superpowers

Merged `obra/superpowers` through `5bf4e78` (**6.4.1**) into `jeresrc/superpowers:v2`. Adopted its official dual V1/V2 plugin, updated bundled skills, multiline frontmatter parsing, current tool names, child-session bootstrap suppression, bounded session cache, and per-skill registration isolation. Retained package exports and tests against the real 2.0.14 Skill schema; runtime no longer requires the plugin SDK.

## Other local plugins

Orca status, Clawd-on-Desk and Orchestrator are local adapters, not separate installed upstream packages. Preserve Orca's generated app-owned source and the redundant-discovery guard. Adapted Orca's session client boundary; verified lifecycle forwarding in old and current context shapes. Verified Clawd permission forwarding tests. Updated the Orchestrator Opus minion to 5.5 high.
