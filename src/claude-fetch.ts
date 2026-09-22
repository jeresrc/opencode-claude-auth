import { randomUUID } from "node:crypto"
import {
  addExcludedBeta,
  getExcludedBetas,
  getModelBetas,
  getModelExcludedBetas,
  getNextBetaToExclude,
  isLongContextError,
  LONG_CONTEXT_BETAS,
} from "./betas.ts"
import { log } from "./logger.ts"
import { config } from "./model-config.ts"
import type { ClaudeCredentials } from "./credentials.ts"
import {
  decodeReplayableBodyText,
  transformBody,
  transformResponseStream,
} from "./transforms.ts"
import { peekStreamOverload } from "./stream-retry.ts"

type FetchFn = typeof fetch
type SleepFn = (delayMs: number) => Promise<void> | void

export type ClaudeFetchOptions = {
  accessToken: string
  upstream?: FetchFn
  sleep?: SleepFn
  retries?: number
  authRecovery?: {
    reload: () => ClaudeCredentials | null
    refresh: () => ClaudeCredentials | null
  }
}

function getCliVersion(): string {
  return process.env.ANTHROPIC_CLI_VERSION ?? config.ccVersion
}

function getUserAgent(): string {
  return (
    process.env.ANTHROPIC_USER_AGENT ??
    `claude-cli/${getCliVersion()} (external, sdk-cli)`
  )
}

function getStainlessHeaders(): Record<string, string> {
  return {
    "x-stainless-arch": process.arch === "arm64" ? "arm64" : process.arch,
    "x-stainless-lang": "js",
    "x-stainless-os":
      process.platform === "darwin" ? "MacOS" : process.platform,
    "x-stainless-package-version": "0.81.0",
    "x-stainless-retry-count": "0",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": process.version,
    "x-stainless-timeout": "600",
  }
}

export function buildRequestUrl(input: RequestInfo | URL): string | URL {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url

  const url = new URL(raw)
  if (url.pathname === "/v1/messages" && !url.searchParams.has("beta")) {
    url.searchParams.set("beta", "true")
  }

  return typeof input === "string" ? url.toString() : url
}

const sessionId = randomUUID()

const DEFAULT_MAX_RETRY_DELAY_MS = 30_000
const MAX_ERROR_MESSAGE_LENGTH = 1000
// Bun uses runtime-native names such as ConnectionRefused; cross-fetch and
// undici-compatible callers can still surface POSIX-style error codes.
const TRANSIENT_TRANSPORT_ERROR_CODES = new Set([
  "ConnectionRefused",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETUNREACH",
  "EHOSTUNREACH",
])
const JWT_PATTERN =
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?![A-Za-z0-9_-])/g

function getMaxRetryDelayMs(): number {
  const env = process.env.OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS
  if (env) {
    const parsed = parseInt(env, 10)
    if (!Number.isNaN(parsed) && parsed > 0) return parsed
  }
  return DEFAULT_MAX_RETRY_DELAY_MS
}

async function defaultSleep(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs))
}

function isReplayableBody(body: BodyInit | null | undefined): boolean {
  return !(body instanceof ReadableStream)
}

function isReplayableRequest(
  input: RequestInfo | URL,
  init: RequestInit,
): boolean {
  if (typeof init.body !== "undefined") return isReplayableBody(init.body)
  return !(input instanceof Request && input.body)
}

function isTransientTransportError(error: unknown): boolean {
  const seen = new Set<unknown>()
  let current: unknown = error
  let foundTransient = false

  while (current && !seen.has(current)) {
    seen.add(current)
    if (!(current instanceof Error)) return false
    if (current.name === "AbortError") return false

    const code = "code" in current ? current.code : undefined
    if (
      typeof code === "string" &&
      (TRANSIENT_TRANSPORT_ERROR_CODES.has(code) ||
        TRANSIENT_TRANSPORT_ERROR_CODES.has(code.toUpperCase()))
    ) {
      foundTransient = true
    }

    const message = current.message.toUpperCase()
    for (const transientCode of TRANSIENT_TRANSPORT_ERROR_CODES) {
      if (new RegExp(`\\b${transientCode}\\b`).test(message)) {
        foundTransient = true
      }
    }

    current = current.cause
  }

  return foundTransient
}

export async function fetchWithRetry(
  input: RequestInfo | URL,
  init: RequestInit = {},
  retries = 3,
  upstream: FetchFn = fetch,
  sleep: SleepFn = defaultSleep,
): Promise<Response> {
  const attempts = Math.max(1, isReplayableRequest(input, init) ? retries : 1)
  for (let attempt = 0; attempt < attempts; attempt++) {
    let response: Response
    try {
      response = await upstream(input, init)
    } catch (error) {
      if (
        !init.signal?.aborted &&
        isTransientTransportError(error) &&
        attempt < attempts - 1
      ) {
        // Only pre-response failures are retried. This can replay billable
        // POSTs after a reset, so keep it limited to replayable bodies.
        const delayMs = (attempt + 1) * 2000
        log("fetch_transport_retry", { attempt: attempt + 1, delayMs })
        await sleep(delayMs)
        continue
      }
      throw error
    }
    const isRateLimit = response.status === 429 || response.status === 529
    const isTransientGateway =
      response.status === 502 ||
      response.status === 503 ||
      response.status === 504
    if ((isRateLimit || isTransientGateway) && attempt < attempts - 1) {
      const retryAfter = response.headers.get("retry-after")
      const parsed = retryAfter ? parseInt(retryAfter, 10) : NaN
      const delayMs = Number.isNaN(parsed)
        ? (attempt + 1) * 2000
        : parsed * 1000

      if (delayMs > getMaxRetryDelayMs()) {
        log(
          isRateLimit
            ? "fetch_rate_limited_quota"
            : "fetch_gateway_retry_quota",
          {
            status: response.status,
            retryAfter: retryAfter ?? "none",
            delayMs,
          },
        )
        return response
      }

      log(isRateLimit ? "fetch_rate_limited" : "fetch_gateway_retry", {
        status: response.status,
        attempt: attempt + 1,
        retryAfter: retryAfter ?? "none",
        delayMs,
      })
      await sleep(delayMs)
      continue
    }

    return response
  }

  return upstream(input, init)
}

function mergeHeaders(headers: Headers, source: HeadersInit | undefined): void {
  if (source instanceof Headers) {
    source.forEach((value, key) => {
      headers.set(key, value)
    })
    return
  }

  if (Array.isArray(source)) {
    for (const [key, value] of source) {
      if (typeof value !== "undefined") headers.set(key, String(value))
    }
    return
  }

  if (source) {
    for (const [key, value] of Object.entries(source)) {
      if (typeof value !== "undefined") headers.set(key, String(value))
    }
  }
}

export function buildRequestHeaders(
  input: RequestInfo | URL,
  init: RequestInit = {},
  accessToken: string,
  modelId = "unknown",
  excludedBetas?: Set<string>,
): Headers {
  const headers = new Headers()

  if (input instanceof Request) {
    input.headers.forEach((value, key) => {
      headers.set(key, value)
    })
  }

  mergeHeaders(headers, init.headers)

  const modelBetas = getModelBetas(modelId, excludedBetas)
  const modelExcludedBetas = getModelExcludedBetas(modelId)
  const incomingBeta = headers.get("anthropic-beta") ?? ""
  const mergedBetas = [
    ...new Set([
      ...modelBetas,
      ...incomingBeta
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ]),
  ].filter((beta) => !excludedBetas?.has(beta) && !modelExcludedBetas.has(beta))

  headers.set("authorization", `Bearer ${accessToken}`)
  headers.set("anthropic-version", "2023-06-01")
  headers.set("anthropic-beta", mergedBetas.join(","))
  headers.set("anthropic-dangerous-direct-browser-access", "true")
  headers.set("x-app", "cli")
  headers.set("user-agent", getUserAgent())
  headers.set("x-client-request-id", randomUUID())
  headers.set("X-Claude-Code-Session-Id", sessionId)
  for (const [key, value] of Object.entries(getStainlessHeaders())) {
    if (!headers.has(key)) headers.set(key, value)
  }
  headers.delete("x-api-key")

  return headers
}

function getModelId(body: BodyInit | null | undefined): string {
  const bodyText = decodeReplayableBodyText(body)
  if (bodyText === undefined) return "unknown"
  try {
    const model = (JSON.parse(bodyText) as { model?: unknown }).model
    return typeof model === "string" ? model : "unknown"
  } catch {
    return "unknown"
  }
}

async function getRequestBody(
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<BodyInit | null | undefined> {
  if (typeof init.body !== "undefined") return init.body
  if (!(input instanceof Request) || !input.body) return init.body
  return input.body
}

function warnOnErrorResponse(response: Response, modelId: string): void {
  if (response.ok) return

  const { status } = response
  response
    .clone()
    .text()
    .then((errorBody) => {
      let message = errorBody
      try {
        const parsed = JSON.parse(errorBody) as {
          error?: { type?: string; message?: string }
        }
        message = parsed.error?.message ?? parsed.error?.type ?? errorBody
      } catch {}
      message = sanitizeErrorMessage(message)
      log("fetch_error_response", { status, modelId, message })
    })
    .catch(() => {})
}

function sanitizeErrorMessage(message: string): string {
  let sanitized = message
    .replace(
      /Authorization:\s*Bearer\s+[^\s"']+/gi,
      "Authorization: Bearer REDACTED",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/g, "Bearer REDACTED")
    .replace(/\baccess_token=([^&\s"'{};,]+)/gi, "access_token=REDACTED")
    .replace(/("access_token"\s*:\s*")[^"]+(")/gi, "$1REDACTED$2")
    .replace(/("refresh_token"\s*:\s*")[^"]+(")/gi, "$1REDACTED$2")
    .replace(/\brefresh_token=([^&\s"'{};,]+)/gi, "refresh_token=REDACTED")
    .replace(JWT_PATTERN, "JWT_REDACTED")
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-REDACTED")

  if (sanitized.length > MAX_ERROR_MESSAGE_LENGTH) {
    sanitized = `${sanitized.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…[truncated]`
  }

  return sanitized
}

function logAuthRecoveryFailure(
  phase: "reload" | "refresh",
  err: unknown,
): void {
  log("auth_recovery_failed", {
    phase,
    error: err instanceof Error ? err.name : typeof err,
  })
}

export function createClaudeFetch(options: ClaudeFetchOptions): FetchFn {
  const upstream = options.upstream ?? fetch
  const sleep = options.sleep ?? defaultSleep
  const retries = options.retries ?? 3

  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestInit = init ?? {}
    const originalBody = await getRequestBody(input, requestInit)
    const modelId = getModelId(originalBody)
    const requestUrl = buildRequestUrl(input)
    const body = transformBody(originalBody)
    const isReplayable =
      isReplayableRequest(input, requestInit) && isReplayableBody(body)
    const effectiveRetries = isReplayable ? retries : 1
    const method =
      requestInit.method ??
      (input instanceof Request ? input.method : undefined)
    const signal =
      requestInit.signal !== undefined
        ? requestInit.signal
        : input instanceof Request
          ? input.signal
          : undefined

    let activeAccessToken = options.accessToken
    let headers = buildRequestHeaders(
      input,
      requestInit,
      activeAccessToken,
      modelId,
      getExcludedBetas(modelId),
    )

    const headerKeys: string[] = []
    headers.forEach((_, key) => headerKeys.push(key))
    const betas = (headers.get("anthropic-beta") ?? "")
      .split(",")
      .filter(Boolean)
    log("fetch_headers_built", { headerKeys, betas, modelId })

    const send = async (
      accessToken: string,
      retryAttempts = effectiveRetries,
    ): Promise<Response> => {
      headers = buildRequestHeaders(
        input,
        requestInit,
        accessToken,
        modelId,
        getExcludedBetas(modelId),
      )
      const retryInit = {
        ...requestInit,
        method,
        body,
        headers,
        signal,
      } as RequestInit & {
        duplex?: "half"
      }
      if (body instanceof ReadableStream && !("duplex" in retryInit)) {
        retryInit.duplex = "half"
      }

      return await fetchWithRetry(
        requestUrl,
        retryInit,
        retryAttempts,
        upstream,
        sleep,
      )
    }

    let authRecoverySent = false
    let response = await send(activeAccessToken)

    log("fetch_response", { status: response.status, modelId, retryAttempt: 0 })

    if (response.status === 401 && isReplayable && options.authRecovery) {
      let retryCreds: ClaudeCredentials | null = null
      let recoveryFailed = false

      try {
        const reloaded = options.authRecovery.reload()
        if (reloaded && reloaded.accessToken !== activeAccessToken) {
          retryCreds = reloaded
        }
      } catch (err) {
        recoveryFailed = true
        logAuthRecoveryFailure("reload", err)
      }

      if (!retryCreds && !recoveryFailed) {
        try {
          retryCreds = options.authRecovery.refresh()
        } catch (err) {
          recoveryFailed = true
          logAuthRecoveryFailure("refresh", err)
        }
      }

      if (retryCreds && retryCreds.accessToken !== activeAccessToken) {
        activeAccessToken = retryCreds.accessToken
        authRecoverySent = true
        response = await send(activeAccessToken, 1)
        log("fetch_response", {
          status: response.status,
          modelId,
          retryAttempt: 1,
        })
      }
    }

    for (let attempt = 0; attempt < LONG_CONTEXT_BETAS.length; attempt++) {
      if (!isReplayable) break
      if (authRecoverySent) break
      if (response.status !== 400 && response.status !== 429) break

      const responseBody = await response.clone().text()
      if (!isLongContextError(responseBody)) break

      const betaToExclude = getNextBetaToExclude(modelId)
      if (!betaToExclude) break

      addExcludedBeta(modelId, betaToExclude)
      log("fetch_beta_excluded", { modelId, excludedBeta: betaToExclude })

      const retryHeaders = buildRequestHeaders(
        input,
        requestInit,
        activeAccessToken,
        modelId,
        getExcludedBetas(modelId),
      )

      response = await fetchWithRetry(
        requestUrl,
        { ...requestInit, method, body, headers: retryHeaders, signal },
        effectiveRetries,
        upstream,
        sleep,
      )
    }

    // Anthropic can accept the request (HTTP 200) and then deliver
    // `overloaded_error` as the first SSE event instead of an HTTP 529.
    // Replay those with the same backoff policy as HTTP rate limits; errors
    // that arrive after content are passed through untouched.
    if (isReplayable) {
      for (let attempt = 1; attempt <= effectiveRetries; attempt++) {
        const peeked = await peekStreamOverload(response)
        response = peeked.response
        if (!peeked.overloaded) break
        if (attempt >= effectiveRetries) {
          log("fetch_stream_overloaded_exhausted", { modelId, attempt })
          break
        }

        const delayMs = attempt * 2000
        if (delayMs > getMaxRetryDelayMs()) {
          log("fetch_stream_overloaded_quota", { modelId, attempt, delayMs })
          break
        }

        log("fetch_stream_overloaded", { modelId, attempt, delayMs })
        await response.body?.cancel().catch(() => {})
        await sleep(delayMs)
        response = await send(activeAccessToken)
      }
    }

    warnOnErrorResponse(response, modelId)
    return transformResponseStream(response)
  }
}
