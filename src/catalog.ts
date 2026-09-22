import type { ProviderEditor } from "@opencode/plugin/promise/provider"
import { ANTHROPIC_INTEGRATION_ID } from "./integration.ts"

const ANTHROPIC_PROVIDER_ID = "anthropic"
const ANTHROPIC_PACKAGES = new Set([
  "aisdk:@ai-sdk/anthropic",
  "@opencode/ai/providers/anthropic",
  "@opencode-ai/ai/providers/anthropic",
])

type ModelVariant = Parameters<
  Parameters<ProviderEditor["models"]["update"]>[2]
>[0]["variants"][number]

export function providerFileUrl(baseUrl = import.meta.url): string {
  return new URL("./provider.js", baseUrl).href
}

function isAnthropicPackage(value: unknown): value is string {
  return typeof value === "string" && ANTHROPIC_PACKAGES.has(value)
}

function ensureNoEffortVariant(variants: ModelVariant[]): ModelVariant[] {
  if (variants.some((variant) => String(variant.id) === "none")) return variants
  return [
    {
      id: "none" as unknown as ModelVariant["id"],
      settings: { thinking: { type: "disabled" } },
    },
    ...variants,
  ]
}

export function applyAnthropicCatalog(draft: ProviderEditor): void {
  const record = draft.get(ANTHROPIC_PROVIDER_ID)
  if (!record || !isAnthropicPackage(record.provider.package)) return

  const url = providerFileUrl()

  draft.update(ANTHROPIC_PROVIDER_ID, (provider) => {
    provider.package = url
    provider.integrationID =
      ANTHROPIC_INTEGRATION_ID as unknown as typeof provider.integrationID
  })

  for (const [modelID] of record.models) {
    draft.models.update(ANTHROPIC_PROVIDER_ID, modelID, (model) => {
      const inheritsProvider = model.package === undefined
      const usesAnthropicPackage = isAnthropicPackage(model.package)
      if (!inheritsProvider && !usesAnthropicPackage) return

      if (usesAnthropicPackage) {
        model.package = url
      }
      model.variants = ensureNoEffortVariant(model.variants)
      model.cost = []
    })
  }
}
