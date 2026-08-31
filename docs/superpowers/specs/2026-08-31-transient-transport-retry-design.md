# Transient Transport Retry Design

## Problem

Anthropic streaming requests fail visibly when Bun's `fetch` throws a transient transport error before returning an HTTP response. The existing retry loop handles retryable HTTP statuses but does not catch errors such as `ECONNRESET`, so a replayable request is not retried.

The failing Fable session continued successfully at the same context size after manual retries. This rules out a deterministic payload or context limit. Upstream has the same transport gap and no fix to port.

## Design

Extend `fetchWithRetry` to classify transient transport errors by standard network error codes found on an error or its cause chain. For replayable requests, retry those failures with the existing bounded linear backoff. Preserve the final error when attempts are exhausted.

Do not retry abort errors, application exceptions, or one-shot streaming request bodies. Do not add a custom connection agent, change keep-alive behavior, alter body encoding, or modify provider/model settings.

## Testing

Add regression coverage showing that a large replayable JSON body is sent unchanged after an `ECONNRESET` and succeeds on the next attempt. Add coverage showing that a non-replayable stream still receives one attempt only. Run the focused test, full suite, typecheck, and build.

## Deployment

The service loads `dist/provider.js`, so rebuild the plugin and restart the OpenCode service before validating the heavy session live.
