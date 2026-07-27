import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"
import { resetExcludedBetas } from "./betas.ts"
import {
  buildRequestHeaders,
  buildRequestUrl,
  createClaudeFetch,
  fetchWithRetry,
} from "./claude-fetch.ts"
import { closeLogger, initLogger } from "./logger.ts"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

afterEach(() => {
  resetExcludedBetas()
  closeLogger()
  delete process.env.ANTHROPIC_BETA_FLAGS
  delete process.env.OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS
})

function parseBody(init: RequestInit | undefined): Record<string, unknown> {
  assert.equal(typeof init?.body, "string")
  return JSON.parse(init.body as string) as Record<string, unknown>
}

async function text(response: Response): Promise<string> {
  return response.text()
}

describe("Claude OAuth fetch pipeline", () => {
  it("adds beta=true to /v1/messages URLs while preserving existing query params", () => {
    assert.equal(
      buildRequestUrl("https://api.anthropic.com/v1/messages?foo=bar"),
      "https://api.anthropic.com/v1/messages?foo=bar&beta=true",
    )

    assert.equal(
      buildRequestUrl("https://api.anthropic.com/v1/messages?beta=false"),
      "https://api.anthropic.com/v1/messages?beta=false",
    )

    assert.equal(
      buildRequestUrl("https://api.anthropic.com/v1/models"),
      "https://api.anthropic.com/v1/models",
    )
  })

  it("sets Claude OAuth headers, removes x-api-key, and merges beta flags", () => {
    const input = new Request("https://api.anthropic.com/v1/messages", {
      headers: { "x-from-request": "kept" },
    })

    const headers = buildRequestHeaders(
      input,
      {
        headers: {
          "anthropic-beta": "custom-beta, claude-code-20250219",
          "x-api-key": "sk-ant-old",
          "x-custom": "keep-me",
          "x-stainless-runtime": "custom-runtime",
        },
      },
      "access-token",
      "claude-sonnet-4-6",
    )

    assert.equal(headers.get("authorization"), "Bearer access-token")
    assert.equal(headers.get("x-api-key"), null)
    assert.equal(headers.get("anthropic-version"), "2023-06-01")
    assert.equal(
      headers.get("anthropic-dangerous-direct-browser-access"),
      "true",
    )
    assert.equal(headers.get("x-app"), "cli")
    assert.equal(headers.get("x-from-request"), "kept")
    assert.equal(headers.get("x-custom"), "keep-me")
    assert.equal(headers.get("x-stainless-lang"), "js")
    assert.equal(headers.get("x-stainless-runtime"), "custom-runtime")
    assert.match(headers.get("user-agent") ?? "", /claude-cli\/.+sdk-cli/)
    assert.match(headers.get("x-client-request-id") ?? "", UUID_RE)
    assert.match(headers.get("x-claude-code-session-id") ?? "", UUID_RE)
    assert.equal(headers.get("x-anthropic-billing-header"), null)

    const betas = (headers.get("anthropic-beta") ?? "").split(",")
    assert.ok(betas.includes("custom-beta"))
    assert.ok(betas.includes("claude-code-20250219"))
    assert.ok(betas.includes("advisor-tool-2026-03-01"))
    assert.equal(
      betas.filter((beta) => beta === "claude-code-20250219").length,
      1,
    )
  })

  it("filters excluded beta flags after merging model and incoming betas", () => {
    const headers = buildRequestHeaders(
      "https://api.anthropic.com/v1/messages",
      {
        headers: {
          "anthropic-beta":
            "incoming-beta,context-1m-2025-08-07,interleaved-thinking-2025-05-14",
        },
      },
      "access-token",
      "claude-sonnet-4-6",
      new Set(["context-1m-2025-08-07", "interleaved-thinking-2025-05-14"]),
    )

    const betas = (headers.get("anthropic-beta") ?? "").split(",")
    assert.ok(betas.includes("incoming-beta"))
    assert.ok(!betas.includes("context-1m-2025-08-07"))
    assert.ok(!betas.includes("interleaved-thinking-2025-05-14"))
  })

  it("filters model-specific beta exclusions after merging incoming betas", () => {
    const headers = buildRequestHeaders(
      "https://api.anthropic.com/v1/messages",
      {
        headers: {
          "anthropic-beta": "effort-2025-11-24, custom-allowed-beta",
        },
      },
      "access-token",
      "claude-sonnet-4-6",
    )

    const betas = (headers.get("anthropic-beta") ?? "").split(",")
    assert.ok(!betas.includes("effort-2025-11-24"))
    assert.ok(betas.includes("custom-allowed-beta"))
  })

  it("keeps effort beta for opus 5 after merging incoming betas", () => {
    const headers = buildRequestHeaders(
      "https://api.anthropic.com/v1/messages",
      {
        headers: {
          "anthropic-beta": "effort-2025-11-24, custom-allowed-beta",
        },
      },
      "access-token",
      "claude-opus-5",
    )

    const betas = (headers.get("anthropic-beta") ?? "").split(",")
    assert.ok(betas.includes("effort-2025-11-24"))
    assert.ok(betas.includes("custom-allowed-beta"))
  })

  it("transforms request bodies through billing, system, and tool-name rewrites", async () => {
    let sentInit: RequestInit | undefined
    const upstream = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentInit = init
      return new Response("ok")
    }) as typeof fetch
    const claudeFetch = createClaudeFetch({
      accessToken: "fixed-token",
      upstream,
    })

    await claudeFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        system: [{ type: "text", text: "OpenCode instructions" }],
        tools: [{ name: "bash", description: "Run shell" }],
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hello" },
              { type: "tool_use", id: "toolu_1", name: "read", input: {} },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_1", content: "ok" },
            ],
          },
        ],
      }),
    })

    const body = parseBody(sentInit)
    const system = body.system as Array<{ text: string }>
    const tools = body.tools as Array<{ name: string }>
    const messages = body.messages as Array<{
      content: Array<Record<string, unknown>>
    }>

    assert.match(system[0].text, /^x-anthropic-billing-header:/)
    assert.equal(
      system.some((entry) => entry.text === "OpenCode instructions"),
      false,
    )
    assert.equal(messages[0].content[0].text, "OpenCode instructions")
    assert.equal(tools[0].name, "mcp_Bash")
    assert.equal(messages[0].content[2].name, "mcp_Read")
  })

  it("detects model ids from string request bodies before building beta headers", async () => {
    process.env.ANTHROPIC_BETA_FLAGS = "effort-2025-11-24,claude-code-20250219"
    let betaHeader = ""
    const upstream = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      betaHeader = new Headers(init?.headers).get("anthropic-beta") ?? ""
      return new Response("ok")
    }) as typeof fetch
    const claudeFetch = createClaudeFetch({
      accessToken: "fixed-token",
      upstream,
    })

    await claudeFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-haiku-4-5", messages: [] }),
    })

    assert.ok(!betaHeader.includes("effort-2025-11-24"))
    assert.ok(betaHeader.includes("claude-code-20250219"))
  })

  it("detects model ids from Uint8Array request bodies before building beta headers", async () => {
    process.env.ANTHROPIC_BETA_FLAGS = "effort-2025-11-24,claude-code-20250219"
    let betaHeader = ""
    const upstream = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      betaHeader = new Headers(init?.headers).get("anthropic-beta") ?? ""
      return new Response("ok")
    }) as typeof fetch
    const claudeFetch = createClaudeFetch({
      accessToken: "fixed-token",
      upstream,
    })

    await claudeFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: new TextEncoder().encode(
        JSON.stringify({ model: "claude-haiku-4-5", messages: [] }),
      ),
    })

    assert.ok(!betaHeader.includes("effort-2025-11-24"))
    assert.ok(betaHeader.includes("claude-code-20250219"))
  })

  it("falls back to unknown for malformed byte request bodies", async () => {
    let betaHeader = ""
    const upstream = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      betaHeader = new Headers(init?.headers).get("anthropic-beta") ?? ""
      return new Response("ok")
    }) as typeof fetch
    const claudeFetch = createClaudeFetch({
      accessToken: "fixed-token",
      upstream,
    })

    await claudeFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: new TextEncoder().encode("{not-json"),
    })

    assert.ok(betaHeader.includes("interleaved-thinking-2025-05-14"))
  })

  it("does not consume one-shot streams while attempting model detection", async () => {
    let betaHeader = ""
    let forwardedBody = ""
    const upstream = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      assert.ok(init?.body instanceof ReadableStream)
      betaHeader = new Headers(init.headers).get("anthropic-beta") ?? ""
      forwardedBody = await new Response(init.body).text()
      return new Response("ok")
    }) as typeof fetch
    const claudeFetch = createClaudeFetch({
      accessToken: "fixed-token",
      upstream,
    })
    const bodyText = JSON.stringify({ model: "claude-haiku-4-5", messages: [] })

    await claudeFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(bodyText))
          controller.close()
        },
      }),
    })

    assert.equal(forwardedBody, bodyText)
    assert.ok(betaHeader.includes("interleaved-thinking-2025-05-14"))
  })

  it("returns 401 responses after exactly one upstream call with no credential fallback", async () => {
    const originalWarn = console.warn
    let calls = 0
    const upstream = (async () => {
      calls += 1
      return new Response("unauthorized", { status: 401 })
    }) as typeof fetch
    const claudeFetch = createClaudeFetch({
      accessToken: "fixed-token",
      upstream,
      sleep: async () => {},
      retries: 3,
    })

    try {
      console.warn = () => {}
      const response = await claudeFetch(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
        },
      )

      assert.equal(response.status, 401)
      assert.equal(await text(response), "unauthorized")
      assert.equal(calls, 1)
    } finally {
      console.warn = originalWarn
    }
  })

  it("retries a 401 once with a reloaded primary token when it rotated externally", async () => {
    let calls = 0
    const authHeaders: string[] = []
    const upstream = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1
      authHeaders.push(new Headers(init?.headers).get("authorization") ?? "")
      return new Response(calls === 1 ? "unauthorized" : "ok", {
        status: calls === 1 ? 401 : 200,
      })
    }) as typeof fetch

    const claudeFetch = createClaudeFetch({
      accessToken: "old-token",
      upstream,
      retries: 1,
      authRecovery: {
        reload: () => ({
          accessToken: "rotated-token",
          refreshToken: "rotated-refresh",
          expiresAt: Date.now() + 10 * 60_000,
        }),
        refresh: () => {
          throw new Error("refresh must not run after external rotation")
        },
      },
    })

    const response = await claudeFetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
      },
    )

    assert.equal(response.status, 200)
    assert.equal(calls, 2)
    assert.deepEqual(authHeaders, ["Bearer old-token", "Bearer rotated-token"])
  })

  it("falls back to one OAuth refresh on 401 when reload returns the rejected token", async () => {
    let calls = 0
    const authHeaders: string[] = []
    const upstream = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1
      authHeaders.push(new Headers(init?.headers).get("authorization") ?? "")
      return new Response(calls === 1 ? "unauthorized" : "ok", {
        status: calls === 1 ? 401 : 200,
      })
    }) as typeof fetch

    const claudeFetch = createClaudeFetch({
      accessToken: "rejected-token",
      upstream,
      retries: 1,
      authRecovery: {
        reload: () => ({
          accessToken: "rejected-token",
          refreshToken: "refresh-token",
          expiresAt: Date.now() + 10 * 60_000,
        }),
        refresh: () => ({
          accessToken: "oauth-refreshed-token",
          refreshToken: "new-refresh",
          expiresAt: Date.now() + 10 * 60_000,
        }),
      },
    })

    const response = await claudeFetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
      },
    )

    assert.equal(response.status, 200)
    assert.equal(calls, 2)
    assert.deepEqual(authHeaders, [
      "Bearer rejected-token",
      "Bearer oauth-refreshed-token",
    ])
  })

  it("does not loop when the retry also returns 401", async () => {
    let calls = 0
    const upstream = (async () => {
      calls += 1
      return new Response("unauthorized", { status: 401 })
    }) as typeof fetch
    const claudeFetch = createClaudeFetch({
      accessToken: "rejected-token",
      upstream,
      retries: 1,
      authRecovery: {
        reload: () => ({
          accessToken: "rotated-token",
          refreshToken: "rotated-refresh",
          expiresAt: Date.now() + 10 * 60_000,
        }),
        refresh: () => null,
      },
    })

    const response = await claudeFetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
      },
    )

    assert.equal(response.status, 401)
    assert.equal(await response.text(), "unauthorized")
    assert.equal(calls, 2)
  })

  it("returns the original 401 when auth reload throws without consuming the body", async () => {
    let calls = 0
    let refreshCalls = 0
    const upstream = (async () => {
      calls += 1
      return new Response("unauthorized reload body", { status: 401 })
    }) as typeof fetch
    const claudeFetch = createClaudeFetch({
      accessToken: "rejected-token",
      upstream,
      retries: 1,
      authRecovery: {
        reload: () => {
          throw new Error("reload failed with secret-token")
        },
        refresh: () => {
          refreshCalls += 1
          return {
            accessToken: "oauth-refreshed-token",
            refreshToken: "new-refresh",
            expiresAt: Date.now() + 10 * 60_000,
          }
        },
      },
    })

    const response = await claudeFetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
      },
    )

    assert.equal(response.status, 401)
    assert.equal(await response.text(), "unauthorized reload body")
    assert.equal(calls, 1)
    assert.equal(refreshCalls, 0)
  })

  it("returns the original 401 when auth refresh throws without consuming the body", async () => {
    let calls = 0
    const upstream = (async () => {
      calls += 1
      return new Response("unauthorized refresh body", { status: 401 })
    }) as typeof fetch
    const claudeFetch = createClaudeFetch({
      accessToken: "rejected-token",
      upstream,
      retries: 1,
      authRecovery: {
        reload: () => ({
          accessToken: "rejected-token",
          refreshToken: "refresh-token",
          expiresAt: Date.now() + 10 * 60_000,
        }),
        refresh: () => {
          throw new Error("refresh failed with secret-token")
        },
      },
    })

    const response = await claudeFetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
      },
    )

    assert.equal(response.status, 401)
    assert.equal(await response.text(), "unauthorized refresh body")
    assert.equal(calls, 1)
  })

  for (const status of [429, 529] as const) {
    it(`does not rate-limit retry the recovered auth attempt when it returns ${status}`, async () => {
      let calls = 0
      const slept: number[] = []
      const upstream = (async () => {
        calls += 1
        if (calls === 1) {
          return new Response("unauthorized", { status: 401 })
        }
        return new Response(`recovered ${status}`, { status })
      }) as typeof fetch
      const claudeFetch = createClaudeFetch({
        accessToken: "rejected-token",
        upstream,
        retries: 4,
        sleep: async (ms) => {
          slept.push(ms)
        },
        authRecovery: {
          reload: () => ({
            accessToken: "rotated-token",
            refreshToken: "rotated-refresh",
            expiresAt: Date.now() + 10 * 60_000,
          }),
          refresh: () => null,
        },
      })

      const response = await claudeFetch(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
        },
      )

      assert.equal(response.status, status)
      assert.equal(await response.text(), `recovered ${status}`)
      assert.equal(calls, 2)
      assert.deepEqual(slept, [])
    })
  }

  it("propagates a Request signal to the initial upstream send", async () => {
    const controller = new AbortController()
    const request = new Request("https://api.anthropic.com/v1/messages", {
      signal: controller.signal,
    })
    let seenSignal: AbortSignal | null | undefined
    const upstream = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenSignal = init?.signal
      return new Response("ok")
    }) as typeof fetch
    const claudeFetch = createClaudeFetch({
      accessToken: "fixed-token",
      upstream,
    })

    const response = await claudeFetch(request)

    assert.equal(response.status, 200)
    assert.equal(seenSignal, request.signal)
  })

  it("propagates a Request signal to the 401 recovery send", async () => {
    const controller = new AbortController()
    const request = new Request("https://api.anthropic.com/v1/messages", {
      signal: controller.signal,
    })
    const seenSignals: Array<AbortSignal | null | undefined> = []
    let calls = 0
    const upstream = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1
      seenSignals.push(init?.signal)
      return new Response(calls === 1 ? "unauthorized" : "ok", {
        status: calls === 1 ? 401 : 200,
      })
    }) as typeof fetch
    const claudeFetch = createClaudeFetch({
      accessToken: "rejected-token",
      upstream,
      retries: 1,
      authRecovery: {
        reload: () => ({
          accessToken: "rotated-token",
          refreshToken: "rotated-refresh",
          expiresAt: Date.now() + 10 * 60_000,
        }),
        refresh: () => null,
      },
    })

    const response = await claudeFetch(request)

    assert.equal(response.status, 200)
    assert.equal(calls, 2)
    assert.equal(seenSignals[0], request.signal)
    assert.equal(seenSignals[1], request.signal)
  })

  it("uses init.signal instead of Request.signal when both are present", async () => {
    const requestController = new AbortController()
    const initController = new AbortController()
    const request = new Request("https://api.anthropic.com/v1/messages", {
      signal: requestController.signal,
    })
    let seenSignal: AbortSignal | null | undefined
    const upstream = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenSignal = init?.signal
      return new Response("ok")
    }) as typeof fetch
    const claudeFetch = createClaudeFetch({
      accessToken: "fixed-token",
      upstream,
    })

    const response = await claudeFetch(request, {
      signal: initController.signal,
    })

    assert.equal(response.status, 200)
    assert.equal(seenSignal, initController.signal)
  })

  it("does not retry 401 recovery for a consumed one-shot request body", async () => {
    let calls = 0
    let recoveryCalls = 0
    let forwardedBody = ""
    const upstream = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1
      assert.ok(init?.body instanceof ReadableStream)
      forwardedBody = await new Response(init.body).text()
      return new Response("unauthorized", { status: 401 })
    }) as typeof fetch
    const claudeFetch = createClaudeFetch({
      accessToken: "rejected-token",
      upstream,
      retries: 3,
      authRecovery: {
        reload: () => {
          recoveryCalls += 1
          return {
            accessToken: "rotated-token",
            refreshToken: "rotated-refresh",
            expiresAt: Date.now() + 10 * 60_000,
          }
        },
        refresh: () => {
          recoveryCalls += 1
          return {
            accessToken: "oauth-refreshed-token",
            refreshToken: "new-refresh",
            expiresAt: Date.now() + 10 * 60_000,
          }
        },
      },
    })
    const bodyText = JSON.stringify({
      model: "claude-sonnet-4-6",
      messages: [],
    })

    const response = await claudeFetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(bodyText))
            controller.close()
          },
        }),
      },
    )

    assert.equal(response.status, 401)
    assert.equal(await response.text(), "unauthorized")
    assert.equal(calls, 1)
    assert.equal(recoveryCalls, 0)
    assert.equal(forwardedBody, bodyText)
  })

  it("does not consume or retry 401 recovery for a Request stream body", async () => {
    let calls = 0
    let recoveryCalls = 0
    let forwardedBody = ""
    const upstream = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1
      assert.ok(init?.body instanceof ReadableStream)
      forwardedBody = await new Response(init.body).text()
      return new Response("unauthorized", { status: 401 })
    }) as typeof fetch
    const claudeFetch = createClaudeFetch({
      accessToken: "rejected-token",
      upstream,
      retries: 3,
      authRecovery: {
        reload: () => {
          recoveryCalls += 1
          return {
            accessToken: "rotated-token",
            refreshToken: "rotated-refresh",
            expiresAt: Date.now() + 10 * 60_000,
          }
        },
        refresh: () => {
          recoveryCalls += 1
          return {
            accessToken: "oauth-refreshed-token",
            refreshToken: "new-refresh",
            expiresAt: Date.now() + 10 * 60_000,
          }
        },
      },
    })
    const bodyText = JSON.stringify({
      model: "claude-sonnet-4-6",
      messages: [],
    })
    const request = new Request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(bodyText))
          controller.close()
        },
      }),
      duplex: "half",
    })

    const response = await claudeFetch(request)

    assert.equal(response.status, 401)
    assert.equal(await response.text(), "unauthorized")
    assert.equal(calls, 1)
    assert.equal(recoveryCalls, 0)
    assert.equal(forwardedBody, bodyText)
  })

  it("retries 429 and 529 responses using the injected sleeper", async () => {
    const statuses = [429, 529, 200]
    const slept: number[] = []
    let calls = 0
    const upstream = (async () => {
      const status = statuses[calls++]
      return new Response(status === 200 ? "ok" : "retry", { status })
    }) as typeof fetch

    const response = await fetchWithRetry(
      "https://example.test",
      {},
      4,
      upstream,
      async (ms) => {
        slept.push(ms)
      },
    )

    assert.equal(response.status, 200)
    assert.equal(calls, 3)
    assert.deepEqual(slept, [2000, 4000])
  })

  it("does not retry retryable responses when the request body is a one-shot stream", async () => {
    const originalWarn = console.warn
    let calls = 0
    const upstream = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1
      assert.ok(init?.body instanceof ReadableStream)
      await new Response(init.body).text()
      return new Response("rate limited", { status: 429 })
    }) as typeof fetch
    const claudeFetch = createClaudeFetch({
      accessToken: "fixed-token",
      upstream,
      sleep: async () => {},
      retries: 3,
    })

    try {
      console.warn = () => {}
      const response = await claudeFetch(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"model":"claude"}'))
              controller.close()
            },
          }),
        },
      )

      assert.equal(response.status, 429)
      assert.equal(await text(response), "rate limited")
      assert.equal(calls, 1)
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      console.warn = originalWarn
    }
  })

  it("honors retry-after delay caps and env overrides without sleeping when capped", async () => {
    let calls = 0
    const slept: number[] = []
    const capped = (async () => {
      calls += 1
      return new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "31" },
      })
    }) as typeof fetch

    const cappedResponse = await fetchWithRetry(
      "https://example.test",
      {},
      3,
      capped,
      async (ms) => {
        slept.push(ms)
      },
    )
    assert.equal(cappedResponse.status, 429)
    assert.equal(calls, 1)
    assert.deepEqual(slept, [])

    process.env.OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS = "500"
    calls = 0
    const envCapped = (async () => {
      calls += 1
      return new Response("rate limited", {
        status: 529,
        headers: { "retry-after": "1" },
      })
    }) as typeof fetch

    const envCappedResponse = await fetchWithRetry(
      "https://example.test",
      {},
      3,
      envCapped,
      async (ms) => {
        slept.push(ms)
      },
    )
    assert.equal(envCappedResponse.status, 529)
    assert.equal(calls, 1)
    assert.deepEqual(slept, [])
  })

  it("excludes long-context beta flags and retries the request", async () => {
    process.env.ANTHROPIC_BETA_FLAGS =
      "context-1m-2025-08-07,interleaved-thinking-2025-05-14,custom-beta"
    const betaHeaders: string[] = []
    let calls = 0
    const upstream = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      betaHeaders.push(new Headers(init?.headers).get("anthropic-beta") ?? "")
      calls += 1
      if (calls === 1) {
        return new Response(
          JSON.stringify({
            error: {
              message: "Extra usage is required for long context requests",
            },
          }),
          { status: 400 },
        )
      }
      return new Response("ok", { status: 200 })
    }) as typeof fetch
    const claudeFetch = createClaudeFetch({
      accessToken: "fixed-token",
      upstream,
      sleep: async () => {},
    })

    const response = await claudeFetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
      },
    )

    assert.equal(response.status, 200)
    assert.equal(calls, 2)
    assert.ok(betaHeaders[0].includes("context-1m-2025-08-07"))
    assert.ok(!betaHeaders[1].includes("context-1m-2025-08-07"))
    assert.ok(betaHeaders[1].includes("interleaved-thinking-2025-05-14"))
    assert.ok(betaHeaders[1].includes("custom-beta"))
  })

  it("does not run beta retries when the request body is a one-shot stream", async () => {
    const originalWarn = console.warn
    let calls = 0
    const upstream = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1
      assert.ok(init?.body instanceof ReadableStream)
      await new Response(init.body).text()
      return new Response(
        JSON.stringify({
          error: {
            message: "Extra usage is required for long context requests",
          },
        }),
        { status: 400 },
      )
    }) as typeof fetch
    const claudeFetch = createClaudeFetch({
      accessToken: "fixed-token",
      upstream,
      sleep: async () => {},
      retries: 3,
    })

    try {
      console.warn = () => {}
      const response = await claudeFetch(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"model":"claude"}'))
              controller.close()
            },
          }),
        },
      )

      assert.equal(response.status, 400)
      assert.equal(calls, 1)
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      console.warn = originalWarn
    }
  })

  it("logs API errors without writing raw responses to console.warn", async () => {
    const logged: string[] = []
    initLogger({
      stream: {
        write(chunk: string) {
          logged.push(chunk)
          return true
        },
      } as never,
    })

    const originalWarn = console.warn
    const warnings: unknown[][] = []
    const errorBody = JSON.stringify({
      type: "error",
      error: {
        type: "rate_limit_error",
        message:
          "This request would exceed your account's rate limit. Please try again later.",
      },
    })
    const upstream = (async () =>
      new Response(errorBody, {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": "11218",
        },
      })) as typeof fetch
    const claudeFetch = createClaudeFetch({
      accessToken: "fixed-token",
      upstream,
      retries: 1,
    })

    try {
      console.warn = (...args: unknown[]) => {
        warnings.push(args)
      }
      const response = await claudeFetch(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          body: JSON.stringify({ model: "claude-opus-5", messages: [] }),
        },
      )

      assert.equal(response.status, 429)
      assert.equal(response.headers.get("retry-after"), "11218")
      assert.equal(await response.text(), errorBody)
      await new Promise((resolve) => setImmediate(resolve))
    } finally {
      console.warn = originalWarn
    }

    assert.deepEqual(warnings, [])
    const logOutput = logged.join("")
    assert.match(logOutput, /"event":"fetch_error_response"/)
    assert.match(logOutput, /"status":429/)
    assert.match(logOutput, /rate limit/)
  })

  it("sanitizes and truncates error bodies before logging or warning", async () => {
    const logged: string[] = []
    initLogger({
      stream: {
        write(chunk: string) {
          logged.push(chunk)
          return true
        },
      } as never,
    })
    const originalWarn = console.warn
    const warnings: string[] = []
    const secretBearer = "Authorization: Bearer secret-token-value"
    const secretApiKey = "sk-ant-api03-secret-token-value"
    const largeBody = `${secretBearer}\n${secretApiKey}\n${"x".repeat(5000)}`
    const upstream = (async () =>
      new Response(largeBody, { status: 500 })) as typeof fetch
    const claudeFetch = createClaudeFetch({
      accessToken: "fixed-token",
      upstream,
    })

    try {
      console.warn = (message: string) => {
        warnings.push(message)
      }
      const response = await claudeFetch(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
        },
      )
      await response.text()
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      console.warn = originalWarn
    }

    const warning = warnings.join("\n")
    const logOutput = logged.join("")
    assert.equal(warning, "")
    assert.ok(logOutput.length < 2000, `log was ${logOutput.length} chars`)
    assert.ok(!logOutput.includes(secretBearer))
    assert.ok(!logOutput.includes(secretApiKey))
    assert.ok(logOutput.includes("REDACTED"))
  })

  it("redacts OAuth secrets embedded in error messages before logging or warning", async () => {
    const logged: string[] = []
    initLogger({
      stream: {
        write(chunk: string) {
          logged.push(chunk)
          return true
        },
      } as never,
    })
    const originalWarn = console.warn
    const warnings: string[] = []
    const bearerToken = "secret-token-value"
    const accessToken = "oauth-access-secret-123"
    const jsonAccessToken = "oauth-access-secret-JSON"
    const refreshToken = "oauth-refresh-secret-456"
    const jwt = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature"
    const errorBody = JSON.stringify({
      error: {
        message: `upstream OAuth failure: Bearer ${bearerToken}; access_token=${accessToken}; {"access_token":"${jsonAccessToken}","refresh_token":"${refreshToken}"}; jwt=${jwt}`,
      },
    })
    const upstream = (async () =>
      new Response(errorBody, { status: 500 })) as typeof fetch
    const claudeFetch = createClaudeFetch({
      accessToken: "fixed-token",
      upstream,
    })

    try {
      console.warn = (message: string) => {
        warnings.push(message)
      }
      const response = await claudeFetch(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
        },
      )
      await response.text()
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      console.warn = originalWarn
    }

    const warning = warnings.join("\n")
    const logOutput = logged.join("")
    assert.equal(warning, "")
    for (const secret of [
      bearerToken,
      accessToken,
      jsonAccessToken,
      refreshToken,
      jwt,
    ]) {
      assert.ok(!logOutput.includes(secret), `log leaked ${secret}`)
    }
    assert.ok(logOutput.includes("upstream OAuth failure"))
    assert.ok(logOutput.includes("REDACTED"))
  })

  it("transforms streamed response tool names back to OpenCode names", async () => {
    const upstream = (async () =>
      new Response(
        'event: content_block_start\ndata: {"content_block":{"type":"tool_use","name":"mcp_Bash"}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      )) as typeof fetch
    const claudeFetch = createClaudeFetch({
      accessToken: "fixed-token",
      upstream,
    })

    const response = await claudeFetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
      },
    )

    assert.equal(
      await text(response),
      'event: content_block_start\ndata: {"content_block":{"type":"tool_use","name": "bash"}}\n\n',
    )
  })

  it("preserves headers from Request inputs when forwarding upstream", async () => {
    let forwardedInput: RequestInfo | URL | undefined
    let forwardedHeaders: Headers | undefined
    const upstream = (async (input: RequestInfo | URL, init?: RequestInit) => {
      forwardedInput = input
      forwardedHeaders = new Headers(init?.headers)
      return new Response("ok")
    }) as typeof fetch
    const claudeFetch = createClaudeFetch({
      accessToken: "fixed-token",
      upstream,
    })

    const request = new Request(
      "https://api.anthropic.com/v1/messages?foo=bar",
      {
        headers: {
          "x-from-request": "keep-request",
          "x-api-key": "remove-me",
        },
      },
    )

    await claudeFetch(request, {
      method: "POST",
      headers: { "x-from-init": "keep-init" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    })

    assert.equal(
      forwardedInput instanceof URL
        ? forwardedInput.toString()
        : forwardedInput,
      "https://api.anthropic.com/v1/messages?foo=bar&beta=true",
    )
    assert.equal(forwardedHeaders?.get("x-from-request"), "keep-request")
    assert.equal(forwardedHeaders?.get("x-from-init"), "keep-init")
    assert.equal(forwardedHeaders?.get("x-api-key"), null)
    assert.equal(forwardedHeaders?.get("authorization"), "Bearer fixed-token")
  })
})
