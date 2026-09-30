# Upstream review: September 29, 2026

Fetched `origin` (griffinmartin) and `fork` (jeresrc) before the media compatibility repair. Upstream remains `8aad811` (2.2.1), unchanged from the September 28 audit. The fork started at `1e5db05` on `v2`.

- Incorporated: a local request-boundary adapter for OpenCode 2.0.18 `Media.Asset` parts. The pinned 2.0.14 Anthropic protocol expects top-level `mediaType` and `data`; an attached screenshot instead supplied `media`, crashing before inference. Adapt inline bytes/base64, public URLs and Anthropic references without changing stored messages. Reject unsupported authenticated URLs and foreign references explicitly.
- Already equivalent: upstream's Claude Code protocol version 2.1.280 remains present; prior credential recovery and Sonnet 5.5 effort fixes remain installed.
- Deferred: the September 22 audit's V1 multi-account/async refresh adaptation remains deferred. No new upstream changes or dependency upgrades were needed. Preserve SDK 2.0.14, Effect 4.0.0-rc.112 and Superpowers 6.4.1.

Validation: the regression reproduced `part.mediaType.toLowerCase` before the patch; both new tests pass afterward, including legacy media, immutable history, PDFs, plain text, references and unsupported URL credentials. Isolated build/typecheck and all 354 Node tests pass. Installed only the changed provider and new media adapter artifacts. Configuration reload retained the old imported provider; restarted once after `/api/session/active` was empty. The affected worktree then passed an attached-image Opus probe and the four standard model checks. All diagnostic sessions are disposable and tracked/deleted by the health-check cleanup ledgers.

A separate child-session hang was caused by generated tool code `await new Promise(r=>r)`, which never resolves. Cancel that execution through the session API and resume the existing child with bounded waits; it is unrelated to OAuth or media encoding. Preserve the original parent/child sessions and their task scope.
