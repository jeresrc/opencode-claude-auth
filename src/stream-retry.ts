// Anthropic can accept a streaming request (HTTP 200) and then deliver
// `overloaded_error` as the first SSE event instead of failing with HTTP 529.
// The HTTP-level retry in claude-fetch.ts never sees that case, so callers use
// peekStreamOverload to inspect the first event and decide whether to replay
// the request. Only errors that arrive BEFORE any content are flagged:
// retrying after content has streamed would duplicate emitted events.

const OVERLOADED_ERROR_TYPE = "overloaded_error"
const EVENT_BOUNDARY = "\n\n"
// Stop peeking if the first event never terminates within this budget; real
// error events are tiny and message_start events are well under this size.
const MAX_PEEK_CHARS = 65_536

export type StreamOverloadPeek = {
  response: Response
  overloaded: boolean
}

function isEventStream(response: Response): boolean {
  const contentType = response.headers.get("content-type") ?? ""
  return contentType.includes("text/event-stream")
}

function isOverloadedEvent(event: string): boolean {
  const dataLines = event.split("\n").filter((line) => line.startsWith("data:"))
  if (dataLines.length === 0) return false

  const payload = dataLines
    .map((line) => line.slice("data:".length).trim())
    .join("\n")

  try {
    const parsed = JSON.parse(payload) as {
      type?: string
      error?: { type?: string }
    }
    return (
      parsed.type === "error" && parsed.error?.type === OVERLOADED_ERROR_TYPE
    )
  } catch {
    return false
  }
}

function rebuildResponse(
  original: Response,
  peeked: Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
  exhausted: boolean,
): Response {
  let index = 0
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < peeked.length) {
        controller.enqueue(peeked[index])
        index += 1
        return
      }
      if (exhausted) {
        controller.close()
        return
      }
      const { done, value } = await reader.read()
      if (done) {
        controller.close()
        return
      }
      controller.enqueue(value)
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })

  return new Response(stream, {
    status: original.status,
    statusText: original.statusText,
    headers: original.headers,
  })
}

/**
 * Peek at the first SSE event of a successful streaming response. Returns the
 * response (rebuilt so no bytes are lost) plus whether the stream opened with
 * an Anthropic `overloaded_error` event, which is safe to retry because no
 * content has been emitted yet.
 */
export async function peekStreamOverload(
  response: Response,
): Promise<StreamOverloadPeek> {
  if (!response.ok || !response.body || !isEventStream(response)) {
    return { response, overloaded: false }
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const peeked: Uint8Array[] = []
  let buffered = ""
  let exhausted = false

  while (buffered.indexOf(EVENT_BOUNDARY) === -1) {
    if (buffered.length > MAX_PEEK_CHARS) break
    const { done, value } = await reader.read()
    if (done) {
      exhausted = true
      buffered += decoder.decode()
      break
    }
    peeked.push(value)
    buffered += decoder.decode(value, { stream: true })
  }

  const boundary = buffered.indexOf(EVENT_BOUNDARY)
  const firstEvent = boundary === -1 ? buffered : buffered.slice(0, boundary)
  const overloaded = isOverloadedEvent(firstEvent)

  return {
    response: rebuildResponse(response, peeked, reader, exhausted),
    overloaded,
  }
}
