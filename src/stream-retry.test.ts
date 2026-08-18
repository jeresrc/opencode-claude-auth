import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { peekStreamOverload } from "./stream-retry.ts"

const OVERLOADED_EVENT =
  'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n'
const MESSAGE_START =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n'
const MESSAGE_STOP = 'event: message_stop\ndata: {"type":"message_stop"}\n\n'

function sseResponse(chunks: string[], init?: ResponseInit): Response {
  const encoder = new TextEncoder()
  let index = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]))
        index += 1
        return
      }
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
    ...init,
  })
}

describe("peekStreamOverload", () => {
  it("detects an overloaded first event and preserves the body", async () => {
    const original = sseResponse([OVERLOADED_EVENT])
    const peeked = await peekStreamOverload(original)

    assert.equal(peeked.overloaded, true)
    assert.equal(await peeked.response.text(), OVERLOADED_EVENT)
  })

  it("detects overloaded events split across chunks", async () => {
    const split = Math.floor(OVERLOADED_EVENT.length / 2)
    const original = sseResponse([
      OVERLOADED_EVENT.slice(0, split),
      OVERLOADED_EVENT.slice(split),
      MESSAGE_STOP,
    ])
    const peeked = await peekStreamOverload(original)

    assert.equal(peeked.overloaded, true)
    assert.equal(await peeked.response.text(), OVERLOADED_EVENT + MESSAGE_STOP)
  })

  it("detects overloaded events when the stream ends without a boundary", async () => {
    const truncated = OVERLOADED_EVENT.trimEnd()
    const original = sseResponse([truncated])
    const peeked = await peekStreamOverload(original)

    assert.equal(peeked.overloaded, true)
    assert.equal(await peeked.response.text(), truncated)
  })

  it("passes through streams whose first event is not an error", async () => {
    const original = sseResponse([MESSAGE_START, MESSAGE_STOP])
    const peeked = await peekStreamOverload(original)

    assert.equal(peeked.overloaded, false)
    assert.equal(await peeked.response.text(), MESSAGE_START + MESSAGE_STOP)
  })

  it("does not flag overloaded errors that arrive after content", async () => {
    const original = sseResponse([MESSAGE_START + OVERLOADED_EVENT])
    const peeked = await peekStreamOverload(original)

    assert.equal(peeked.overloaded, false)
    assert.equal(await peeked.response.text(), MESSAGE_START + OVERLOADED_EVENT)
  })

  it("ignores non-SSE responses", async () => {
    const original = new Response('{"ok":true}', {
      status: 200,
      headers: { "content-type": "application/json" },
    })
    const peeked = await peekStreamOverload(original)

    assert.equal(peeked.overloaded, false)
    assert.equal(peeked.response, original)
  })

  it("ignores non-2xx responses", async () => {
    const original = sseResponse([OVERLOADED_EVENT], { status: 529 })
    const peeked = await peekStreamOverload(original)

    assert.equal(peeked.overloaded, false)
    assert.equal(peeked.response, original)
  })

  it("ignores other in-stream error types", async () => {
    const invalidRequest =
      'event: error\ndata: {"type":"error","error":{"type":"invalid_request_error","message":"bad"}}\n\n'
    const original = sseResponse([invalidRequest])
    const peeked = await peekStreamOverload(original)

    assert.equal(peeked.overloaded, false)
    assert.equal(await peeked.response.text(), invalidRequest)
  })
})
