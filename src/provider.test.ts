import { execFile } from "node:child_process"
import test from "node:test"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

async function runBun(script: string): Promise<string> {
  const { stdout } = await execFileAsync("bun", ["--eval", script], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, CLAUDE_AUTH_DEBUG: "" },
  })
  return stdout
}

const commonImports = String.raw`
import assert from "node:assert/strict"
import { Effect, Layer, Stream } from "effect"
import { LLM, LLMClient } from "@opencode-ai/ai"
import { RequestExecutor } from "@opencode-ai/ai/route"
import { model } from "./src/provider.ts"
`

const textSse = String.raw`
event: message_start
data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"hello"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}

event: message_stop
data: {"type":"message_stop"}

`

const noStopReasonSse = String.raw`
event: message_start
data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"hello"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_stop
data: {"type":"message_stop"}

`

const toolSse = String.raw`
event: message_start
data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"mcp_Bash","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"cmd\":\"ls\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":2}}

event: message_stop
data: {"type":"message_stop"}

`

test("provider exports a ProviderPackage model function", async () => {
  await runBun(String.raw`
${commonImports}
assert.equal(typeof model, "function")
const selected = model("claude-sonnet-4-6", { apiKey: "access-token" })
assert.equal(selected.id, "claude-sonnet-4-6")
assert.equal(String(selected.provider), "anthropic")
assert.equal(selected.route.id, "anthropic-messages")
`)
})

test("provider requires an Anthropic OAuth access token from settings.apiKey", async () => {
  await runBun(String.raw`
import assert from "node:assert/strict"
import { model } from "./src/provider.ts"
assert.throws(
  () => model("claude-sonnet-4-6", {}),
  /Connect Anthropic in OpenCode v2/,
)
`)
})

test("settings.apiKey is sent as Bearer auth, never x-api-key", async () => {
  await runBun(String.raw`
${commonImports}
const calls = []
const fakeFetch = async (input, init) => {
  calls.push({
    url: String(input),
    headers: Object.fromEntries(new Headers(init?.headers).entries()),
  })
  return new Response(${JSON.stringify(textSse)}, {
    headers: { "content-type": "text/event-stream" },
  })
}
const selected = model("claude-sonnet-4-6", {
  apiKey: "oauth-access-token",
  baseURL: "https://provider.test/v1",
  headers: { "x-api-key": "must-not-send", "x-custom": "kept" },
  fetch: fakeFetch,
})
const globalExecutor = Layer.succeed(RequestExecutor.Service, {
  execute: () => Effect.die(new Error("global executor should not be used")),
})
const response = await Effect.runPromise(
  LLM.generate(LLM.request({ model: selected, prompt: "hello" })).pipe(
    Effect.provide(LLMClient.layer.pipe(Layer.provide(globalExecutor))),
  ),
)
assert.equal(response.text, "hello world")
assert.equal(calls.length, 1)
assert.equal(calls[0].headers.authorization, "Bearer oauth-access-token")
assert.equal(calls[0].headers["x-api-key"], undefined)
assert.equal(calls[0].headers["x-custom"], "kept")
`)
})

test("native Anthropic route sends /v1/messages?beta=true and parses SSE with LLMClient", async () => {
  await runBun(String.raw`
${commonImports}
const calls = []
const fakeFetch = async (input, init) => {
  calls.push({ url: String(input), init })
  return new Response(${JSON.stringify(textSse)}, {
    headers: { "content-type": "text/event-stream" },
  })
}
const selected = model("claude-sonnet-4-6", {
  apiKey: "oauth-access-token",
  baseURL: "https://provider.test/v1",
  fetch: fakeFetch,
})
const globalExecutor = Layer.succeed(RequestExecutor.Service, {
  execute: () => Effect.die(new Error("global executor should not be used")),
})
const response = await Effect.runPromise(
  LLM.generate(LLM.request({ model: selected, prompt: "hello" })).pipe(
    Effect.provide(LLMClient.layer.pipe(Layer.provide(globalExecutor))),
  ),
)
assert.equal(response.text, "hello world")
assert.equal(calls.length, 1)
const url = new URL(calls[0].url)
assert.equal(url.pathname, "/v1/messages")
assert.equal(url.searchParams.get("beta"), "true")
`)
})

test("request body tools and system prompt pass through Claude Code transforms", async () => {
  await runBun(String.raw`
${commonImports}
const calls = []
const fakeFetch = async (input, init) => {
  const bodyText = await new Response(init?.body).text()
  calls.push({ body: JSON.parse(bodyText) })
  return new Response(${JSON.stringify(textSse)}, {
    headers: { "content-type": "text/event-stream" },
  })
}
const selected = model("claude-sonnet-4-6", {
  apiKey: "oauth-access-token",
  baseURL: "https://provider.test/v1",
  fetch: fakeFetch,
})
const globalExecutor = Layer.succeed(RequestExecutor.Service, {
  execute: () => Effect.die(new Error("global executor should not be used")),
})
await Effect.runPromise(
  LLM.generate(
    LLM.request({
      model: selected,
      system: "OpenCode system instructions",
      prompt: "hello",
      tools: [
        { name: "bash", description: "Run a command", inputSchema: { type: "object" } },
      ],
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool-call", id: "toolu_1", name: "read", input: {} }],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              id: "toolu_1",
              name: "read",
              result: { type: "text", value: "ok" },
            },
          ],
        },
      ],
    }),
  ).pipe(Effect.provide(LLMClient.layer.pipe(Layer.provide(globalExecutor)))),
)
const body = calls[0].body
assert.match(body.system[0].text, /^x-anthropic-billing-header:/)
assert.equal(body.system.some((entry) => entry.text === "OpenCode system instructions"), false)
assert.ok(
  body.messages.some((message) =>
    message.role === "user" &&
    message.content.some((block) => block.text === "OpenCode system instructions"),
  ),
)
assert.equal(body.tools[0].name, "mcp_Bash")
assert.equal(body.messages[0].content[0].name, "mcp_Read")
`)
})

test("native provider detects haiku model from the Uint8Array body for beta overrides", async () => {
  await runBun(String.raw`
${commonImports}
const calls = []
const fakeFetch = async (input, init) => {
  calls.push({
    headers: Object.fromEntries(new Headers(init?.headers).entries()),
    bodyText: String(init?.body),
  })
  return new Response(${JSON.stringify(textSse)}, {
    headers: { "content-type": "text/event-stream" },
  })
}
const selected = model("claude-haiku-4-5", {
  apiKey: "oauth-access-token",
  baseURL: "https://provider.test/v1",
  fetch: fakeFetch,
})
const globalExecutor = Layer.succeed(RequestExecutor.Service, {
  execute: () => Effect.die(new Error("global executor should not be used")),
})
await Effect.runPromise(
  LLM.generate(LLM.request({ model: selected, prompt: "hello" })).pipe(
    Effect.provide(LLMClient.layer.pipe(Layer.provide(globalExecutor))),
  ),
)
assert.equal(calls.length, 1)
assert.equal(JSON.parse(calls[0].bodyText).model, "claude-haiku-4-5")
const betas = calls[0].headers["anthropic-beta"].split(",")
assert.ok(
  !betas.includes("interleaved-thinking-2025-05-14"),
  calls[0].headers["anthropic-beta"],
)
assert.ok(betas.includes("claude-code-20250219"))
`)
})

test("streamed mcp_ tool names are restored before AnthropicMessages parsing", async () => {
  await runBun(String.raw`
${commonImports}
const fakeFetch = async () =>
  new Response(${JSON.stringify(toolSse)}, {
    headers: { "content-type": "text/event-stream" },
  })
const selected = model("claude-sonnet-4-6", {
  apiKey: "oauth-access-token",
  baseURL: "https://provider.test/v1",
  fetch: fakeFetch,
})
const response = await Effect.runPromise(
  LLM.generate(LLM.request({ model: selected, prompt: "use a tool" })).pipe(
    Effect.provide(
      LLMClient.layer.pipe(
        Layer.provide(
          Layer.succeed(RequestExecutor.Service, {
            execute: () => Effect.die(new Error("global executor should not be used")),
          }),
        ),
      ),
    ),
  ),
)
assert.equal(response.toolCalls.length, 1)
assert.equal(response.toolCalls[0].name, "bash")
assert.deepEqual(response.toolCalls[0].input, { cmd: "ls" })
`)
})

test("settings metadata such as source is not forwarded to provider options or HTTP", async () => {
  await runBun(String.raw`
import assert from "node:assert/strict"
import { Effect } from "effect"
import { LLM, LLMClient } from "@opencode-ai/ai"
import { model } from "./src/provider.ts"

const selected = model("claude-sonnet-4-6", {
  apiKey: "oauth-access-token",
  source: "Claude Code-credentials",
  metadata: { source: "Claude Code-credentials" },
})
assert.equal(selected.route.defaults.providerOptions, undefined)
assert.equal(selected.route.defaults.http?.body?.source, undefined)
const prepared = await Effect.runPromise(
  LLMClient.prepare(LLM.request({ model: selected, prompt: "hello" })),
)
assert.equal(JSON.stringify(prepared.body).includes("Claude Code-credentials"), false)
`)
})

test("native stream terminal events without Anthropic stop reason use structured unknown", async () => {
  await runBun(String.raw`
${commonImports}
const fakeFetch = async () =>
  new Response(${JSON.stringify(noStopReasonSse)}, {
    headers: { "content-type": "text/event-stream" },
  })
const selected = model("claude-sonnet-4-6", {
  apiKey: "oauth-access-token",
  baseURL: "https://provider.test/v1",
  fetch: fakeFetch,
})
const events = await Effect.runPromise(
  Stream.runCollect(LLM.stream(LLM.request({ model: selected, prompt: "hello" }))).pipe(
    Effect.provide(
      LLMClient.layer.pipe(
        Layer.provide(
          Layer.succeed(RequestExecutor.Service, {
            execute: () => Effect.die(new Error("global executor should not be used")),
          }),
        ),
      ),
    ),
  ),
)
const terminal = events.filter(
  (event) => event.type === "step-finish" || event.type === "finish",
)

assert.deepEqual(terminal.map((event) => event.reason), [
  { normalized: "unknown", raw: undefined },
  { normalized: "unknown", raw: undefined },
])
`)
})

test("protocol fallback normalizes missing route terminal reasons before route guards", async () => {
  await runBun(String.raw`
import assert from "node:assert/strict"
import { Effect, Layer, Schema, Stream } from "effect"
import { LLM, LLMClient } from "@opencode-ai/ai"
import { Endpoint, Protocol, RequestExecutor, Route } from "@opencode-ai/ai/route"
import { withTerminalFinishReasonFallback } from "./src/provider.ts"

const frames = [
  { type: "step-finish", index: 0 },
  { type: "finish" },
]
const protocol = withTerminalFinishReasonFallback(Protocol.make({
  id: "fallback-test",
  body: {
    schema: Schema.Struct({}),
    from: () => Effect.succeed({}),
  },
  stream: {
    event: Schema.Struct({
      type: Schema.String,
      index: Schema.optional(Schema.Number),
      message: Schema.optional(Schema.String),
    }),
    initial: () => undefined,
    step: (state, event) => Effect.succeed([state, [event]]),
  },
}))
const route = Route.make({
  id: "fallback-test",
  provider: "anthropic",
  protocol,
  endpoint: Endpoint.path("/messages", { baseURL: "https://provider.test/v1" }),
  transport: {
    id: "fallback-test",
    prepare: () => Effect.succeed({}),
    frames: () => Stream.fromIterable(frames),
  },
})
const selected = route.model({ id: "claude-sonnet-4-6" })
const events = await Effect.runPromise(
  Stream.runCollect(LLM.stream(LLM.request({ model: selected, prompt: "hello" }))).pipe(
    Effect.provide(
      LLMClient.layer.pipe(
        Layer.provide(
          Layer.succeed(RequestExecutor.Service, {
            execute: () => Effect.die(new Error("global executor should not be used")),
          }),
        ),
      ),
    ),
  ),
)
const terminal = events.filter(
  (event) => event.type === "step-finish" || event.type === "finish",
)

assert.equal(events.some((event) => event.type === "provider-error"), false)
assert.deepEqual(terminal, [
  { type: "step-finish", index: 0, reason: { normalized: "unknown" } },
  { type: "finish", reason: { normalized: "unknown" } },
])
`)
})

test("protocol fallback rejects present invalid finish reasons and preserves valid reasons", async () => {
  await runBun(String.raw`
import assert from "node:assert/strict"
import { Effect, Layer, Schema, Stream } from "effect"
import { LLM, LLMClient } from "@opencode-ai/ai"
import { Endpoint, Protocol, RequestExecutor, Route } from "@opencode-ai/ai/route"
import { withTerminalFinishReasonFallback } from "./src/provider.ts"

function routeFor(frames) {
  const protocol = withTerminalFinishReasonFallback(Protocol.make({
    id: "fallback-test",
    body: {
      schema: Schema.Struct({}),
      from: () => Effect.succeed({}),
    },
    stream: {
      event: Schema.Struct({
        type: Schema.String,
        index: Schema.optional(Schema.Number),
        reason: Schema.optional(Schema.Unknown),
      }),
      initial: () => undefined,
      step: (state, event) => Effect.succeed([state, [event]]),
    },
  }))

  return Route.make({
    id: "fallback-test",
    provider: "anthropic",
    protocol,
    endpoint: Endpoint.path("/messages", { baseURL: "https://provider.test/v1" }),
    transport: {
      id: "fallback-test",
      prepare: () => Effect.succeed({}),
      frames: () => Stream.fromIterable(frames),
    },
  }).model({ id: "claude-sonnet-4-6" })
}

const run = (frames) => Effect.runPromise(
  Stream.runCollect(LLM.stream(LLM.request({ model: routeFor(frames), prompt: "hello" }))).pipe(
    Effect.provide(
      LLMClient.layer.pipe(
        Layer.provide(
          Layer.succeed(RequestExecutor.Service, {
            execute: () => Effect.die(new Error("global executor should not be used")),
          }),
        ),
      ),
    ),
  ),
)

await assert.rejects(
  () => run([{ type: "finish", reason: null }]),
  /terminal finish event/,
)
await assert.rejects(
  () => run([{ type: "finish", reason: "stop" }]),
  /terminal finish event/,
)
await assert.rejects(
  () => run([{ type: "finish", reason: { raw: "stop" } }]),
  /terminal finish event/,
)

const reason = { normalized: "stop", raw: "end_turn" }
const events = await run([
  { type: "step-finish", index: 0, reason },
  { type: "finish", reason },
])
const terminal = events.filter(
  (event) => event.type === "step-finish" || event.type === "finish",
)

assert.deepEqual(terminal.map((event) => event.reason), [reason, reason])
`)
})

test("native stream terminal events preserve structured Anthropic finish reasons", async () => {
  await runBun(String.raw`
${commonImports}
const fakeFetch = async () =>
  new Response(${JSON.stringify(textSse)}, {
    headers: { "content-type": "text/event-stream" },
  })
const selected = model("claude-sonnet-4-6", {
  apiKey: "oauth-access-token",
  baseURL: "https://provider.test/v1",
  fetch: fakeFetch,
})
const events = await Effect.runPromise(
  Stream.runCollect(LLM.stream(LLM.request({ model: selected, prompt: "hello" }))).pipe(
    Effect.provide(
      LLMClient.layer.pipe(
        Layer.provide(
          Layer.succeed(RequestExecutor.Service, {
            execute: () => Effect.die(new Error("global executor should not be used")),
          }),
        ),
      ),
    ),
  ),
)
const step = events.find((event) => event.type === "step-finish")
const finish = events.find((event) => event.type === "finish")
const reason = { normalized: "stop", raw: "end_turn" }

assert.deepEqual(step?.reason, reason)
assert.deepEqual(finish?.reason, reason)
`)
})
