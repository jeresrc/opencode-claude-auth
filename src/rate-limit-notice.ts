export const RATE_LIMIT_NOTICE_TEXT =
  "Anthropic rate limit reached. Wait for your Claude quota to reset or switch models."

export const RATE_LIMIT_NOTICE_DESCRIPTION = "Anthropic rate limit reached"

const DEFAULT_DEDUPE_MS = 30_000
const CLEANUP_TIMEOUT_MS = 25

type SyntheticInput = {
  sessionID: string
  text: string
  description: string
  resume: false
}

export interface RateLimitNoticeContext {
  readonly event: {
    subscribe: () => AsyncIterable<unknown>
  }
  readonly session: {
    get?: (input: { sessionID: string }) => Promise<unknown> | unknown
    synthetic: (input: SyntheticInput) => Promise<unknown> | unknown
  }
}

type RateLimitNoticeOptions = {
  now?: () => number
  dedupeMs?: number
}

type EventData = Record<string, unknown>

type ActiveRateLimitNoticeListener = {
  refCount: number
  ended: boolean
  stop: () => Promise<void>
}

let activeRateLimitNoticeListener: ActiveRateLimitNoticeListener | undefined

export async function startRateLimitNotices(
  context: RateLimitNoticeContext,
  options: RateLimitNoticeOptions = {},
): Promise<() => Promise<void>> {
  let listener = activeRateLimitNoticeListener
  if (listener?.ended) listener = undefined
  if (!listener) {
    listener = createRateLimitNoticeListener(context, options)
    if (!listener) return async () => {}
    activeRateLimitNoticeListener = listener
  }

  listener.refCount++
  let cleaned = false

  return async () => {
    if (cleaned) return
    cleaned = true
    listener.refCount--
    if (listener.refCount > 0) return
    if (activeRateLimitNoticeListener === listener) {
      activeRateLimitNoticeListener = undefined
    }
    await listener.stop()
  }
}

function createRateLimitNoticeListener(
  context: RateLimitNoticeContext,
  options: RateLimitNoticeOptions,
): ActiveRateLimitNoticeListener | undefined {
  const now = options.now ?? Date.now
  const dedupeMs = options.dedupeMs ?? DEFAULT_DEDUPE_MS
  const providersBySession = new Map<string, string>()
  const lastNoticeBySession = new Map<string, number>()
  let stopped = false
  let iterator: AsyncIterator<unknown> | undefined
  let stopPromise: Promise<void> | undefined

  try {
    iterator = context.event.subscribe()[Symbol.asyncIterator]()
  } catch {
    return undefined
  }

  const listener: ActiveRateLimitNoticeListener = {
    refCount: 0,
    ended: false,
    stop: () => {
      stopPromise ??= stopListener()
      return stopPromise
    },
  }

  const subscription = consumeEvents(iterator)
    .catch(() => {})
    .finally(() => {
      listener.ended = true
    })

  async function consumeEvents(events: AsyncIterator<unknown>) {
    while (true) {
      if (stopped) break
      const next = await events.next()
      if (next.done || stopped) break
      await handleEvent(next.value)
    }
  }

  async function handleEvent(event: unknown) {
    const type = getEventType(event)
    const data = getEventData(event)
    const sessionID = getString(data.sessionID)
    if (!sessionID) return

    if (type === "session.step.started") {
      const providerID = getProviderID(data)
      if (providerID) providersBySession.set(sessionID, providerID)
      return
    }

    if (type === "session.execution.started") {
      const providerID = await getSessionProviderID(sessionID)
      if (providerID) providersBySession.set(sessionID, providerID)
      return
    }

    if (type === "session.deleted") {
      providersBySession.delete(sessionID)
      lastNoticeBySession.delete(sessionID)
      return
    }

    if (type === "session.execution.succeeded") {
      providersBySession.delete(sessionID)
      return
    }

    if (type === "session.execution.interrupted") {
      providersBySession.delete(sessionID)
      return
    }

    if (type !== "session.execution.failed") return
    const providerID = providersBySession.get(sessionID)
    providersBySession.delete(sessionID)
    if (providerID !== "anthropic") return
    if (!isRateLimitError(data.error)) return

    const currentTime = now()
    const lastNotice = lastNoticeBySession.get(sessionID)
    if (lastNotice !== undefined && currentTime - lastNotice < dedupeMs) return
    lastNoticeBySession.set(sessionID, currentTime)

    sendSyntheticNotice({
      sessionID,
      text: RATE_LIMIT_NOTICE_TEXT,
      description: RATE_LIMIT_NOTICE_DESCRIPTION,
      resume: false,
    })
  }

  function sendSyntheticNotice(input: SyntheticInput) {
    try {
      void Promise.resolve(context.session.synthetic(input)).catch(() => {})
    } catch {
      // Best-effort notice only; notification failures must not affect execution.
    }
  }

  async function getSessionProviderID(sessionID: string) {
    try {
      const session = await context.session.get?.({ sessionID })
      if (!isRecord(session)) return undefined
      return getProviderID(session)
    } catch {
      return undefined
    }
  }

  async function stopListener() {
    stopped = true
    const stop = iterator?.return?.()
    if (stop) await boundedWait(stop)
    await Promise.race([subscription, timeout(CLEANUP_TIMEOUT_MS)])
  }

  return listener
}

function getEventType(event: unknown) {
  if (!isRecord(event)) return undefined
  return getString(event.type)
}

function getEventData(event: unknown): EventData {
  if (!isRecord(event)) return {}
  if (isRecord(event.properties)) return event.properties
  if (isRecord(event.data)) return event.data
  return {}
}

function getProviderID(data: EventData) {
  if (!isRecord(data.model)) return undefined
  return getString(data.model.providerID)
}

function isRateLimitError(error: unknown) {
  if (!isRecord(error)) return false
  return Object.values(error).some(isRateLimitValue)
}

function isRateLimitValue(value: unknown) {
  if (typeof value === "number") return value === 429
  const text = getString(value)?.toLowerCase()
  if (!text) return false
  return (
    /(^|\D)429(\D|$)/.test(text) ||
    text.includes("too many requests") ||
    /rate[ _-]limit/.test(text)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function getString(value: unknown) {
  return typeof value === "string" ? value : undefined
}

async function boundedWait<T>(promise: Promise<T>) {
  await Promise.race([
    promise.catch(() => undefined),
    timeout(CLEANUP_TIMEOUT_MS),
  ])
}

async function timeout(ms: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
}
