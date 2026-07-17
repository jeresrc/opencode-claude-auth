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
    assert.ok(warning.length < 1500, `warning was ${warning.length} chars`)
    assert.ok(logOutput.length < 2000, `log was ${logOutput.length} chars`)
    assert.ok(!warning.includes(secretBearer))
    assert.ok(!warning.includes(secretApiKey))
    assert.ok(!logOutput.includes(secretBearer))
    assert.ok(!logOutput.includes(secretApiKey))
    assert.ok(warning.includes("REDACTED"))
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
