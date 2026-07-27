import type { FinishReasonDetails, LLMEvent, Model } from "@opencode-ai/ai"
import type {
  Definition as ProviderPackageDefinition,
  Settings as ProviderPackageSettings,
} from "@opencode-ai/ai/provider-package"
import type { AnthropicMessagesBody } from "@opencode-ai/ai/protocols/anthropic-messages"
import type {
  ProtocolDef as ProtocolShape,
  TransportDef as Transport,
} from "@opencode-ai/ai/route"
import { Effect, Layer, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { createClaudeFetch } from "./claude-fetch.ts"
import {
  forceRefreshPrimaryCredentials,
  reloadPrimaryCredentials,
} from "./credentials.ts"

type RouteRuntime = typeof import("@opencode-ai/ai/route")
type AnthropicMessagesRuntime =
  typeof import("@opencode-ai/ai/protocols/anthropic-messages")
type ProviderRuntime = {
  readonly route: RouteRuntime
  readonly anthropic: AnthropicMessagesRuntime
}

const isBunRuntime =
  typeof (globalThis as typeof globalThis & { Bun?: unknown }).Bun !==
  "undefined"
const providerRuntime: ProviderRuntime | undefined = isBunRuntime
  ? {
      route: await import("@opencode-ai/ai/route"),
      anthropic: await import("@opencode-ai/ai/protocols/anthropic-messages"),
    }
  : undefined

type FetchFn = typeof fetch
type TransportStream<Body, Prepared, Frame> = ReturnType<
  Transport<Body, Prepared, Frame>["frames"]
>

export interface Settings extends ProviderPackageSettings {
  readonly apiKey?: string
  readonly baseURL?: string
  readonly fetch?: FetchFn
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
    prepare: transport.prepare,
    frames: (
      prepared,
      request,
      runtime,
    ): TransportStream<Body, Prepared, Frame> => {
      // Pinned Effect/@opencode-ai/ai types disagree at this executor/stream boundary.
      // The casts isolate that drift without changing runtime stream composition.
      const frames = Effect.gen(function* () {
        const loadedRuntime = providerRuntime
        if (loadedRuntime === undefined) {
          throw new Error("OpenCode provider runtime is unavailable")
        }
        const http = yield* loadedRuntime.route.RequestExecutor.Service as any
        return transport.frames(prepared, request, { ...runtime, http })
      }).pipe(Effect.provide(layer))

      return Stream.unwrap(frames as never) as TransportStream<
        Body,
        Prepared,
        Frame
      >
    },
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
  // Pinned Effect versions differ between plugin (.83) and @opencode-ai/ai (.98);
  // keep the cast at the operator boundary while typing the event tuple above.
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
          onHalt: (state: State) => normalizeTerminalEvents(onHalt(state)),
        }

  const runtime = providerRuntime
  if (runtime === undefined) {
    throw new Error("OpenCode provider runtime is unavailable")
  }

  return runtime.route.Protocol.make({ ...protocol, stream })
}

export const model = ((modelID: string, settings: Settings): Model => {
  const accessToken = requireAccessToken(settings)
  const runtime = providerRuntime
  if (runtime === undefined) {
    throw new Error("OpenCode provider runtime is unavailable")
  }

  const { Auth, Endpoint, HttpTransport, Route } = runtime.route
  const { AnthropicMessages } = runtime.anthropic
  const transport = withExecutor(
    HttpTransport.sseJson.with<AnthropicMessagesBody>(),
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
      limits: settings.limits,
    },
  })

  return route.model({ id: modelID })
}) satisfies ProviderPackageDefinition<Settings>["model"]
