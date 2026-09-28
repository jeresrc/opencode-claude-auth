# Local fork maintenance

- This checkout is the user's native OpenCode V2 fork. Keep its local installation and `jeresrc/opencode-claude-auth` fork current with reviewed, compatible upstream changes, and publish tested maintenance changes to the fork's `v2` branch when maintaining this plugin.
- Fetch `origin` (griffinmartin upstream) and `fork` (jeresrc), inspect changes since the last `runbooks/upstream-sync-*.md` audit, and document what was incorporated, already equivalent, or deferred. Do not blindly replace the V2 entrypoint or pinned SDK/Effect dependencies with upstream's V1 implementation. Push to `fork`, never upstream `origin`.
- Preserve unrelated work. Run tests with `bun run test` (Node), not Bun's test runner. Use an isolated source/build copy when tests rebuild modules while user sessions are active; install only the verified build.
- For newly released models, reproduce failures in the affected worktree as well as a fresh location. A stale per-location catalog can produce `ModelUnavailableError` despite another location listing the model. Try supported configuration reload before changing model IDs or upgrading packages; preserve active sessions.
- Validate the repaired model and the runbook's Opus/Fable smoke tests, keep sanitized evidence, and delete all diagnostic sessions, including failed attempts. Never delete user work sessions.
- Never add coding-agent Co-Authored-By trailers. Use English Conventional Commit messages.
