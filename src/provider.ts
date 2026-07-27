import type { LLMEvent, Model } from "@opencode-ai/ai"
import type {
  Definition as ProviderPackageDefinition,
  Settings as ProviderPackageSettings,
} from "@opencode-ai/ai/provider-package"
import { AnthropicMessages } from "@opencode-ai/ai/protocols/anthropic-messages"
import type { AnthropicMessagesBody } from "@opencode-ai/ai/protocols/anthropic-messages"
import {
  Auth,
  HttpTransport,
  RequestExecutor,
  type RouteShape,
  type TransportDef as Transport,
} from "@opencode-ai/ai/route"
import { Effect, Layer, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { createClaudeFetch } from "./claude-fetch.ts"

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
  const fetchLayer = FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.succeed(
        FetchHttpClient.Fetch,
        createClaudeFetch({ accessToken, upstream }),
      ),
    ),
  )

  return RequestExecutor.layer.pipe(Layer.provide(fetchLayer))
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
        const http = yield* RequestExecutor.Service as any
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

type TerminalEvent = Extract<LLMEvent, { type: "step-finish" | "finish" }>

export function normalizeTerminalFinishReason(event: LLMEvent): LLMEvent {
  if (event.type !== "step-finish" && event.type !== "finish") return event

  const terminal = event as TerminalEvent & {
    readonly reason?: TerminalEvent["reason"]
  }
  if (terminal.reason !== undefined) return event

  return { ...event, reason: "unknown" } as unknown as LLMEvent
}

export function withTerminalFinishReasonFallback<Body, Prepared>(
  route: RouteShape<Body, Prepared>,
): RouteShape<Body, Prepared> {
  return {
    ...route,
    streamPrepared: (prepared, request, runtime) =>
      route
        .streamPrepared(prepared, request, runtime)
        .pipe(Stream.map(normalizeTerminalFinishReason)),
  }
}

export const model = ((modelID: string, settings: Settings): Model => {
  const accessToken = requireAccessToken(settings)
  const transport = withExecutor(
    HttpTransport.sseJson.with<AnthropicMessagesBody>(),
    executorLayer(accessToken, settings.fetch),
  )

  const route = withTerminalFinishReasonFallback(
    AnthropicMessages.route.with({
      id: AnthropicMessages.route.id,
      provider: "anthropic",
      endpoint: {
        baseURL: settings.baseURL ?? AnthropicMessages.DEFAULT_BASE_URL,
      },
      auth: Auth.bearer(accessToken),
      transport,
      headers:
        settings.headers === undefined ? undefined : { ...settings.headers },
      http:
        settings.body === undefined
          ? undefined
          : { body: { ...settings.body } },
      limits: settings.limits,
    }),
  )

  return route.model({ id: modelID })
}) satisfies ProviderPackageDefinition<Settings>["model"]
