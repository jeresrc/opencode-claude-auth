# Anthropic Thinking Output Limit Design

## Goal

Prevent high-effort Anthropic requests from exhausting a 4096-token protocol fallback or violating Anthropic's requirement that `max_tokens` exceed an explicit thinking budget.

## Upstream Reference

The original plugin's closed PR #143, commit `2b8de45`, repairs invalid explicit budgets by setting `thinking.budget_tokens` to 80% of `max_tokens`. It was closed for inactivity rather than rejected. Upstream V2 PR #274, through commit `3dbf3e3`, ports the provider architecture but does not include that guard and forwards provider limits unchanged.

## Design

The V2 native Anthropic route will default its output limit to 32000 tokens only when provider settings do not supply explicit limits. Explicit provider limits remain authoritative.

The existing raw request-body transform will port commit `2b8de45`'s defensive rule: when numeric `thinking.budget_tokens` is greater than or equal to numeric `max_tokens`, reduce the budget to `Math.floor(max_tokens * 0.8)`. Valid budgets and adaptive thinking requests remain unchanged.

`minion-opus-high` remains pinned to `anthropic/claude-opus-5#high`.

## Verification

Tests will cover the 32000 route default, preservation of explicit provider limits, invalid equal and greater budgets, and valid budgets. After the full suite, the plugin will be rebuilt and the service restarted. Verification will run the requested agent-only CLI command and inspect persisted session data, then exercise the actual Subagent tool path because OpenCode V2 stores primary-session model selection separately from agent selection.
