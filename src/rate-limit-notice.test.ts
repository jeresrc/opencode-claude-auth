import assert from "node:assert/strict"
import test from "node:test"
import {
  RATE_LIMIT_NOTICE_DESCRIPTION,
  RATE_LIMIT_NOTICE_TEXT,
  startRateLimitNotices,
  type RateLimitNoticeContext,
} from "./rate-limit-notice.ts"

type TestEvent = {
  type: string
  properties?: Record<string, unknown>
  data?: Record<string, unknown>
}

function stepStarted(sessionID: string, providerID: string): TestEvent {
  return {
    type: "session.step.started",
    properties: { sessionID, model: { id: "model", providerID } },
  }
}

function executionStarted(sessionID: string): TestEvent {
  return { type: "session.execution.started", properties: { sessionID } }
}

function executionFailed(
  sessionID: string,
  error: { type: string; message: string },
): TestEvent {
  return {
    type: "session.execution.failed",
    properties: { sessionID, error },
  }
}

function sessionDeleted(sessionID: string): TestEvent {
  return { type: "session.deleted", properties: { sessionID } }
}

function executionSucceeded(sessionID: string): TestEvent {
  return { type: "session.execution.succeeded", properties: { sessionID } }
}

function executionInterrupted(sessionID: string): TestEvent {
  return { type: "session.execution.interrupted", properties: { sessionID } }
}

function createEventStream() {
  const events: TestEvent[] = []
  let waiting:
    | {
        resolve: (result: IteratorResult<TestEvent>) => void
      }
    | undefined
  let closed = false
  let returnCalls = 0

  const iterator: AsyncIterator<TestEvent> = {
    next: async () => {
      if (events.length > 0) return { value: events.shift()!, done: false }
      if (closed) return { value: undefined, done: true }
      return await new Promise<IteratorResult<TestEvent>>((resolve) => {
        waiting = { resolve }
      })
    },
    return: async () => {
      returnCalls++
      closed = true
      waiting?.resolve({ value: undefined, done: true })
      return { value: undefined, done: true }
    },
  }

  const iterable: AsyncIterable<TestEvent> = {
    [Symbol.asyncIterator]: () => iterator,
  }

  return {
    iterable,
    push(event: TestEvent) {
      if (waiting) {
        const current = waiting
        waiting = undefined
        current.resolve({ value: event, done: false })
        return
      }
      events.push(event)
    },
    async close() {
      closed = true
      waiting?.resolve({ value: undefined, done: true })
      await Promise.resolve()
    },
    get returnCalls() {
      return returnCalls
    },
  }
}

function createContext(
  stream: AsyncIterable<TestEvent>,
  sessionInfoByID: Record<string, unknown> = {},
) {
  const syntheticCalls: unknown[] = []
  let syntheticFailure: Error | undefined
  let subscribeCalls = 0
  const context = {
    event: {
      subscribe: () => {
        subscribeCalls++
        return stream
      },
    },
    session: {
      synthetic: async (input: unknown) => {
        if (syntheticFailure) throw syntheticFailure
        syntheticCalls.push(input)
      },
      get: ({ sessionID }: { sessionID: string }) => sessionInfoByID[sessionID],
    },
  } satisfies RateLimitNoticeContext

  return {
    context,
    syntheticCalls,
    get subscribeCalls() {
      return subscribeCalls
    },
    failSynthetic(error: Error) {
      syntheticFailure = error
    },
  }
}

async function waitForProcessing() {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

test("shares one event subscription across concurrent starts and keeps the first starter active", async () => {
  const firstStream = createEventStream()
  const secondStream = createEventStream()
  const first = createContext(firstStream.iterable)
  const second = createContext(secondStream.iterable)
  const cleanups: Array<() => Promise<void>> = []

  try {
    cleanups.push(
      await startRateLimitNotices(first.context, {
        dedupeMs: 30_000,
        now: () => 1_000,
      }),
    )
    cleanups.push(
      await startRateLimitNotices(second.context, {
        dedupeMs: 0,
        now: () => 999_000,
      }),
    )

    assert.equal(first.subscribeCalls, 1)
    assert.equal(second.subscribeCalls, 0)

    firstStream.push(stepStarted("session-1", "anthropic"))
    firstStream.push(
      executionFailed("session-1", {
        type: "provider_error",
        message: "HTTP 429 Too Many Requests",
      }),
    )
    await waitForProcessing()

    assert.equal(first.syntheticCalls.length, 1)
    assert.deepEqual(second.syntheticCalls, [])
  } finally {
    for (const cleanup of cleanups.toReversed()) await cleanup()
    await firstStream.close()
    await secondStream.close()
  }
})

test("reference-counts cleanup and allows a fresh listener after the final cleanup", async () => {
  const stream = createEventStream()
  const owner = createContext(stream.iterable)
  const cleanups: Array<() => Promise<void>> = []

  try {
    cleanups.push(await startRateLimitNotices(owner.context))
    cleanups.push(await startRateLimitNotices(owner.context))

    assert.equal(owner.subscribeCalls, 1)

    await cleanups[0]()
    await cleanups[0]()
    assert.equal(stream.returnCalls, 0)

    stream.push(stepStarted("session-1", "anthropic"))
    stream.push(
      executionFailed("session-1", {
        type: "rate_limit_error",
        message: "rate_limit_error",
      }),
    )
    await waitForProcessing()
    assert.equal(owner.syntheticCalls.length, 1)

    await cleanups[1]()
    await cleanups[1]()
    assert.equal(stream.returnCalls, 1)

    const freshStream = createEventStream()
    const freshOwner = createContext(freshStream.iterable)
    cleanups.push(await startRateLimitNotices(freshOwner.context))
    assert.equal(freshOwner.subscribeCalls, 1)

    await cleanups[2]()
    assert.equal(freshStream.returnCalls, 1)
    await freshStream.close()
  } finally {
    for (const cleanup of cleanups.toReversed()) await cleanup()
    await stream.close()
  }
})

test("replaces an ended active listener before its cleanup runs", async () => {
  const firstStream = createEventStream()
  const secondStream = createEventStream()
  const first = createContext(firstStream.iterable)
  const second = createContext(secondStream.iterable)
  const cleanups: Array<() => Promise<void>> = []

  try {
    cleanups.push(await startRateLimitNotices(first.context))
    assert.equal(first.subscribeCalls, 1)

    await firstStream.close()
    await waitForProcessing()

    cleanups.push(await startRateLimitNotices(second.context))
    assert.equal(second.subscribeCalls, 1)

    secondStream.push(stepStarted("session-1", "anthropic"))
    secondStream.push(
      executionFailed("session-1", {
        type: "provider_error",
        message: "HTTP 429 Too Many Requests",
      }),
    )
    await waitForProcessing()

    assert.deepEqual(second.syntheticCalls, [
      {
        sessionID: "session-1",
        text: RATE_LIMIT_NOTICE_TEXT,
        description: RATE_LIMIT_NOTICE_DESCRIPTION,
        resume: false,
      },
    ])
  } finally {
    for (const cleanup of cleanups.toReversed()) await cleanup()
    await firstStream.close()
    await secondStream.close()
  }
})

test("adds approved synthetic notice for Anthropic HTTP 429 failures", async () => {
  const stream = createEventStream()
  const { context, syntheticCalls } = createContext(stream.iterable)

  const cleanup = await startRateLimitNotices(context)
  stream.push(stepStarted("session-1", "anthropic"))
  stream.push(
    executionFailed("session-1", {
      type: "provider_error",
      message: "HTTP 429 Too Many Requests",
    }),
  )
  await waitForProcessing()
  await stream.close()
  await cleanup()

  assert.deepEqual(syntheticCalls, [
    {
      sessionID: "session-1",
      text: RATE_LIMIT_NOTICE_TEXT,
      description: RATE_LIMIT_NOTICE_DESCRIPTION,
      resume: false,
    },
  ])
})

test("adds approved synthetic notice when execution fails before any step starts", async () => {
  const stream = createEventStream()
  const { context, syntheticCalls } = createContext(stream.iterable, {
    "session-1": { model: { providerID: "anthropic" } },
  })

  const cleanup = await startRateLimitNotices(context)
  stream.push(executionStarted("session-1"))
  stream.push(
    executionFailed("session-1", {
      type: "provider_error",
      message: "HTTP 429 Too Many Requests",
    }),
  )
  await waitForProcessing()
  await stream.close()
  await cleanup()

  assert.deepEqual(syntheticCalls, [
    {
      sessionID: "session-1",
      text: RATE_LIMIT_NOTICE_TEXT,
      description: RATE_LIMIT_NOTICE_DESCRIPTION,
      resume: false,
    },
  ])
})

test("adds approved synthetic notice for canonical provider.rate-limit failures without HTTP 429", async () => {
  const stream = createEventStream()
  const { context, syntheticCalls } = createContext(stream.iterable)

  const cleanup = await startRateLimitNotices(context)
  stream.push(stepStarted("session-1", "anthropic"))
  stream.push(
    executionFailed("session-1", {
      type: "provider.rate-limit",
      message: "quota exceeded",
    }),
  )
  await waitForProcessing()
  await stream.close()
  await cleanup()

  assert.equal(syntheticCalls.length, 1)
})

test("adds approved synthetic notice for data-shaped rate-limit events", async () => {
  const stream = createEventStream()
  const { context, syntheticCalls } = createContext(stream.iterable)

  const cleanup = await startRateLimitNotices(context)
  stream.push({
    type: "session.step.started",
    data: { sessionID: "session-1", model: { providerID: "anthropic" } },
  })
  stream.push({
    type: "session.execution.failed",
    data: {
      sessionID: "session-1",
      error: { type: "provider_error", message: "rate limit exceeded" },
    },
  })
  await waitForProcessing()
  await stream.close()
  await cleanup()

  assert.equal(syntheticCalls.length, 1)
})

test("adds approved synthetic notice for clear text rate-limit failures", async () => {
  const stream = createEventStream()
  const { context, syntheticCalls } = createContext(stream.iterable)

  const cleanup = await startRateLimitNotices(context)
  const messages = [
    "rate limit exceeded",
    "rate-limit exceeded",
    "rate_limit exceeded",
    "too many requests",
  ]
  for (const [index, message] of messages.entries()) {
    const sessionID = `session-${index}`
    stream.push(stepStarted(sessionID, "anthropic"))
    stream.push(
      executionFailed(sessionID, {
        type: "provider_error",
        message,
      }),
    )
  }
  await waitForProcessing()
  await stream.close()
  await cleanup()

  assert.equal(syntheticCalls.length, messages.length)
})

test("does not notify for non-Anthropic HTTP 429 failures", async () => {
  const stream = createEventStream()
  const { context, syntheticCalls } = createContext(stream.iterable)

  const cleanup = await startRateLimitNotices(context)
  stream.push(stepStarted("session-1", "openai"))
  stream.push(
    executionFailed("session-1", {
      type: "provider_error",
      message: "HTTP 429 Too Many Requests",
    }),
  )
  await waitForProcessing()
  await stream.close()
  await cleanup()

  assert.deepEqual(syntheticCalls, [])
})

test("does not notify for Anthropic failures that are not rate limits", async () => {
  const stream = createEventStream()
  const { context, syntheticCalls } = createContext(stream.iterable)

  const cleanup = await startRateLimitNotices(context)
  stream.push(stepStarted("session-1", "anthropic"))
  stream.push(
    executionFailed("session-1", {
      type: "provider_error",
      message: "HTTP 500 Internal Server Error",
    }),
  )
  await waitForProcessing()
  await stream.close()
  await cleanup()

  assert.deepEqual(syntheticCalls, [])
})

test("deduplicates Anthropic rate-limit notices per session for 30 seconds", async () => {
  let time = 1_000
  const stream = createEventStream()
  const { context, syntheticCalls } = createContext(stream.iterable)

  const cleanup = await startRateLimitNotices(context, { now: () => time })
  stream.push(stepStarted("session-1", "anthropic"))
  stream.push(
    executionFailed("session-1", {
      type: "rate_limit_error",
      message: "rate_limit_error",
    }),
  )
  await waitForProcessing()

  time += 29_999
  stream.push(stepStarted("session-1", "anthropic"))
  stream.push(
    executionFailed("session-1", {
      type: "rate_limit_error",
      message: "rate_limit_error",
    }),
  )
  await waitForProcessing()

  time += 1
  stream.push(stepStarted("session-1", "anthropic"))
  stream.push(
    executionFailed("session-1", {
      type: "rate_limit_error",
      message: "rate_limit_error",
    }),
  )
  await waitForProcessing()
  await stream.close()
  await cleanup()

  assert.equal(syntheticCalls.length, 2)
})

test("removes provider tracking when sessions are deleted", async () => {
  const stream = createEventStream()
  const { context, syntheticCalls } = createContext(stream.iterable)

  const cleanup = await startRateLimitNotices(context)
  stream.push(stepStarted("session-1", "anthropic"))
  stream.push(sessionDeleted("session-1"))
  stream.push(
    executionFailed("session-1", {
      type: "rate_limit_error",
      message: "rate_limit_error",
    }),
  )
  await waitForProcessing()
  await stream.close()
  await cleanup()

  assert.deepEqual(syntheticCalls, [])
})

test("clears provider tracking on terminal execution events to avoid stale Anthropic false positives", async () => {
  const stream = createEventStream()
  const { context, syntheticCalls } = createContext(stream.iterable)
  let time = 1_000

  const cleanup = await startRateLimitNotices(context, { now: () => time })

  stream.push(stepStarted("succeeded-session", "anthropic"))
  stream.push(executionSucceeded("succeeded-session"))
  stream.push(
    executionFailed("succeeded-session", {
      type: "provider_error",
      message: "HTTP 429 Too Many Requests",
    }),
  )

  stream.push(stepStarted("interrupted-session", "anthropic"))
  stream.push(executionInterrupted("interrupted-session"))
  stream.push(
    executionFailed("interrupted-session", {
      type: "provider_error",
      message: "HTTP 429 Too Many Requests",
    }),
  )

  stream.push(stepStarted("failed-session", "anthropic"))
  stream.push(
    executionFailed("failed-session", {
      type: "rate_limit_error",
      message: "rate_limit_error",
    }),
  )
  time += 30_000
  stream.push(
    executionFailed("failed-session", {
      type: "provider_error",
      message: "HTTP 429 Too Many Requests",
    }),
  )

  await waitForProcessing()
  await stream.close()
  await cleanup()

  assert.deepEqual(syntheticCalls, [
    {
      sessionID: "failed-session",
      text: RATE_LIMIT_NOTICE_TEXT,
      description: RATE_LIMIT_NOTICE_DESCRIPTION,
      resume: false,
    },
  ])
})

test("synthetic notification failures never escape the subscriber", async () => {
  const stream = createEventStream()
  const { context, syntheticCalls, failSynthetic } = createContext(
    stream.iterable,
  )
  failSynthetic(new Error("synthetic failed"))

  const cleanup = await startRateLimitNotices(context)
  stream.push(stepStarted("session-1", "anthropic"))
  stream.push(
    executionFailed("session-1", {
      type: "rate_limit_error",
      message: "rate_limit_error",
    }),
  )
  await waitForProcessing()
  await stream.close()
  await cleanup()

  assert.deepEqual(syntheticCalls, [])
})

test("never-settling synthetic notices do not block later event handling or cleanup", async () => {
  const stream = createEventStream()
  const syntheticCalls: unknown[] = []
  const context = {
    event: {
      subscribe: () => stream.iterable,
    },
    session: {
      synthetic: (input: unknown) => {
        syntheticCalls.push(input)
        return new Promise<never>(() => {})
      },
    },
  } satisfies RateLimitNoticeContext

  const cleanup = await startRateLimitNotices(context)
  stream.push(stepStarted("session-1", "anthropic"))
  stream.push(
    executionFailed("session-1", {
      type: "rate_limit_error",
      message: "rate_limit_error",
    }),
  )
  await waitForProcessing()
  stream.push(sessionDeleted("session-1"))
  stream.push(stepStarted("session-1", "anthropic"))
  stream.push(
    executionFailed("session-1", {
      type: "rate_limit_error",
      message: "rate_limit_error",
    }),
  )
  await waitForProcessing()
  await stream.close()
  await cleanup()

  assert.equal(syntheticCalls.length, 2)
})

test("cleanup returns promptly and asks the subscription iterator to stop", async () => {
  let returnCalls = 0
  const stream: AsyncIterable<TestEvent> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => await new Promise<IteratorResult<TestEvent>>(() => {}),
      return: async () => {
        returnCalls++
        await new Promise<never>(() => {})
      },
    }),
  }
  const { context } = createContext(stream)

  const cleanup = await startRateLimitNotices(context)
  await cleanup()

  assert.equal(returnCalls, 1)
})
