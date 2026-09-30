import type { LLMRequest, MediaPart } from "@opencode/ai"

type HostMedia = {
  readonly mediaType: string
  readonly headers?: Record<string, string>
  readonly source:
    | { readonly type: "bytes"; readonly data: Uint8Array }
    | { readonly type: "base64"; readonly data: string }
    | { readonly type: "url"; readonly url: string }
    | { readonly type: "ref"; readonly provider: string; readonly id: string }
}

function normalizeMedia(part: MediaPart): MediaPart {
  // OpenCode 2.0.18 moved the payload into Media.Asset. Keep our pinned SDK
  // and adapt only the outgoing request; stored messages remain untouched.
  const media = (part as MediaPart & { readonly media?: HostMedia }).media
  if (typeof part.mediaType === "string" || media === undefined) return part

  const base = { ...part, mediaType: media.mediaType }
  const source = media.source
  switch (source.type) {
    case "bytes":
      return { ...base, data: source.data }
    case "base64":
      return {
        ...base,
        data: `data:${media.mediaType};base64,${source.data}`,
      }
    case "url":
      if (media.headers && Object.keys(media.headers).length > 0) {
        throw new Error(
          "The pinned Anthropic SDK cannot forward authenticated media URLs",
        )
      }
      return { ...base, data: source.url }
    case "ref":
      if (source.provider !== "anthropic") {
        throw new Error(
          "Cannot send another provider's media reference to Anthropic",
        )
      }
      return {
        ...base,
        data: "",
        metadata: {
          ...part.metadata,
          anthropic: {
            ...(part.metadata?.anthropic as
              | Record<string, unknown>
              | undefined),
            file_id: source.id,
          },
        },
      }
  }
}

export function normalizeHostMedia(request: LLMRequest): LLMRequest {
  return {
    ...request,
    messages: request.messages.map((message) => ({
      ...message,
      content: message.content.map((part) =>
        part.type === "media" ? normalizeMedia(part) : part,
      ),
    })),
  }
}
