import type { FinishReasonDetails, LanguageModel, LLMEvent } from "@opencode/ai"
import type {
  Definition as ProviderPackageDefinition,
  Settings as ProviderPackageSettings,
} from "@opencode/ai/provider-package"
import type { AnthropicMessagesBody } from "@opencode/ai/protocols/anthropic-messages"
import type {
  ProtocolDef as ProtocolShape,
  TransportDef as Transport,
} from "@opencode/ai/route"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { createClaudeFetch } from "./claude-fetch.ts"
import {
  forceRefreshPrimaryCredentials,
  reloadPrimaryCredentials,
} from "./credentials.ts"

type RouteRuntime = typeof import("@opencode/ai/route")
type AnthropicMessagesRuntime =
  typeof import("@opencode/ai/protocols/anthropic-messages")
type ProviderRuntime = {
  readonly ai: typeof import("@opencode/ai")
  readonly route: RouteRuntime
  readonly anthropic: AnthropicMessagesRuntime
}

const isBunRuntime =
  typeof (globalThis as typeof globalThis & { Bun?: unknown }).Bun !==
  "undefined"
const providerRuntime: ProviderRuntime | undefined = isBunRuntime
  ? {
      ai: await import("@opencode/ai"),
      route: await import("@opencode/ai/route"),
      anthropic: await import("@opencode/ai/protocols/anthropic-messages"),
    }
  : undefined

type FetchFn = typeof fetch
export interface Settings extends ProviderPackageSettings {
  readonly apiKey?: string
  readonly baseURL?: string
  readonly fetch?: FetchFn
  readonly maxTokens?: number
}

function requireAccessToken(settings: Settings): string {
  if (typeof settings.apiKey === "string" && settings.apiKey.length > 0) {
    return settings.apiKey
  }

  throw new Error(
    "Connect Anthropic in OpenCode v2 before using Claude Code OAuth",
  )
}

function executorLayer(accessToken: string, upstream?: FetchFn) {
  const loadedRuntime = providerRuntime
  if (loadedRuntime === undefined) {
    throw new Error("OpenCode provider runtime is unavailable")
  }

  const fetchLayer = FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.succeed(
        FetchHttpClient.Fetch,
        createClaudeFetch({
          accessToken,
          upstream,
          authRecovery: {
            reload: reloadPrimaryCredentials,
            refresh: forceRefreshPrimaryCredentials,
          },
        }),
      ),
    ),
  )

  return loadedRuntime.route.RequestExecutor.layer.pipe(
    Layer.provide(fetchLayer),
  )
}

function withExecutor<Body, Prepared, Frame>(
  transport: Transport<Body, Prepared, Frame>,
  layer: ReturnType<typeof executorLayer>,
): Transport<Body, Prepared, Frame> {
  return {
    ...transport,
    prepare: (input) => {
      if (providerRuntime === undefined) {
        throw new Error("OpenCode provider runtime is unavailable")
      }
      // The compiled host has its own LanguageModel class. Native transport
      // validates with instanceof, so normalize only at this module boundary.
      return transport.prepare({
        ...input,
        request: {
          ...input.request,
          model: providerRuntime.ai.LanguageModel.make(input.request.model),
        },
      })
    },
    execute: (prepared, request, runtime, options) =>
      Effect.gen(function* () {
        const loadedRuntime = providerRuntime
        if (loadedRuntime === undefined) {
          throw new Error("OpenCode provider runtime is unavailable")
        }
        const http = yield* loadedRuntime.route.RequestExecutor.Service
        return yield* transport.execute(
          prepared,
          request,
          { ...runtime, http },
          options,
        )
      }).pipe(Effect.provide(layer)),
  }
}

const UNKNOWN_FINISH_REASON = {
  normalized: "unknown",
} satisfies FinishReasonDetails

export function normalizeTerminalFinishReason(event: LLMEvent): LLMEvent {
  if (event.type !== "step-finish" && event.type !== "finish") return event

  const reason = "reason" in event ? event.reason : undefined
  if (reason !== undefined) {
    return event
  }

  return { ...event, reason: UNKNOWN_FINISH_REASON }
}

const normalizeTerminalEvents = (
  events: ReadonlyArray<LLMEvent>,
): ReadonlyArray<LLMEvent> => events.map(normalizeTerminalFinishReason)

type ProtocolStepResult<Body, Frame, Event, State> = ReturnType<
  ProtocolShape<Body, Frame, Event, State>["stream"]["step"]
>

export function withTerminalFinishReasonFallback<Body, Frame, Event, State>(
  protocol: ProtocolShape<Body, Frame, Event, State>,
): ProtocolShape<Body, Frame, Event, State> {
  const onHalt = protocol.stream.onHalt
  const mapStepEvents = Effect.map(
    ([nextState, events]: readonly [State, ReadonlyArray<LLMEvent>]): readonly [
      State,
      ReadonlyArray<LLMEvent>,
    ] => [nextState, normalizeTerminalEvents(events)],
  ) as unknown as (
    effect: ProtocolStepResult<Body, Frame, Event, State>,
  ) => ProtocolStepResult<Body, Frame, Event, State>
  const step: ProtocolShape<Body, Frame, Event, State>["stream"]["step"] = (
    state,
    event,
  ) => protocol.stream.step(state, event).pipe(mapStepEvents)

  const stream =
    onHalt === undefined
      ? { ...protocol.stream, step }
      : {
          ...protocol.stream,
          step,
          onHalt: (state: State) =>
            onHalt(state).pipe(Effect.map(normalizeTerminalEvents)),
        }

  const runtime = providerRuntime
  if (runtime === undefined) {
    throw new Error("OpenCode provider runtime is unavailable")
  }

  return runtime.route.Protocol.make({ ...protocol, stream })
}

export const model = ((modelID: string, settings: Settings): LanguageModel => {
  const accessToken = requireAccessToken(settings)
  const {
    apiKey: _apiKey,
    baseURL: _baseURL,
    fetch: _fetch,
    headers: _headers,
    body: _body,
    maxTokens,
    source: _source,
    metadata: _metadata,
    ...providerOptions
  } = settings
  const runtime = providerRuntime
  if (runtime === undefined) {
    throw new Error("OpenCode provider runtime is unavailable")
  }

  const { Auth, Endpoint, Route } = runtime.route
  const { AnthropicMessages } = runtime.anthropic
  const transport = withExecutor(
    AnthropicMessages.transport<AnthropicMessagesBody>(),
    executorLayer(accessToken, settings.fetch),
  )

  const route = Route.make({
    id: AnthropicMessages.route.id,
    provider: "anthropic",
    providerMetadataKey: AnthropicMessages.route.providerMetadataKey,
    protocol: withTerminalFinishReasonFallback(AnthropicMessages.protocol),
    endpoint: Endpoint.path(AnthropicMessages.PATH, {
      baseURL: settings.baseURL ?? AnthropicMessages.DEFAULT_BASE_URL,
    }),
    auth: Auth.bearer(accessToken),
    transport,
    headers: () => ({ "anthropic-version": "2023-06-01" }),
    defaults: {
      headers:
        settings.headers === undefined ? undefined : { ...settings.headers },
      http:
        settings.body === undefined
          ? undefined
          : { body: { ...settings.body } },
      generation: { maxTokens: maxTokens ?? 32_000 },
      providerOptions: Object.keys(providerOptions).length
        ? providerOptions
        : undefined,
    },
  })

  return route.model({ id: modelID })
}) satisfies ProviderPackageDefinition<Settings>["model"]
