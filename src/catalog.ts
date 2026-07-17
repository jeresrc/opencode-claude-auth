import type { CatalogDraft } from "@opencode-ai/plugin/v2/catalog"
import { ANTHROPIC_INTEGRATION_ID } from "./integration.ts"

const ANTHROPIC_PROVIDER_ID = "anthropic"
const ANTHROPIC_PACKAGES = new Set([
  "aisdk:@ai-sdk/anthropic",
  "@opencode-ai/ai/providers/anthropic",
])

type CatalogModel = NonNullable<ReturnType<CatalogDraft["model"]["get"]>>
type ModelCost = CatalogModel["cost"][number]
type ModelVariant = CatalogModel["variants"][number]

export function providerFileUrl(baseUrl = import.meta.url): string {
  return new URL("./provider.js", baseUrl).href
}

function isAnthropicPackage(value: unknown): value is string {
  return typeof value === "string" && ANTHROPIC_PACKAGES.has(value)
}

function zeroCost(cost: ModelCost): ModelCost {
  return {
    ...cost,
    input: 0,
    output: 0,
    cache: {
      ...cost.cache,
      read: 0,
      write: 0,
    },
  }
}

function ensureNoEffortVariant(variants: ModelVariant[]): ModelVariant[] {
  if (variants.some((variant) => variant.id === "none")) return variants
  return [
    { id: "none", settings: { thinking: { type: "disabled" } } },
    ...variants,
  ]
}

export function applyAnthropicCatalog(draft: CatalogDraft): void {
  const record = draft.provider.get(ANTHROPIC_PROVIDER_ID)
  if (!record || !isAnthropicPackage(record.provider.package)) return

  const url = providerFileUrl()

  draft.provider.update(ANTHROPIC_PROVIDER_ID, (provider) => {
    provider.package = url
    provider.integrationID = ANTHROPIC_INTEGRATION_ID
  })

  for (const [modelID] of record.models) {
    draft.model.update(ANTHROPIC_PROVIDER_ID, modelID, (model) => {
      const inheritsProvider = model.package === undefined
      const usesAnthropicPackage = isAnthropicPackage(model.package)
      if (!inheritsProvider && !usesAnthropicPackage) return

      if (usesAnthropicPackage) {
        model.package = url
      }
      model.variants = ensureNoEffortVariant(model.variants)
      model.cost = model.cost.map(zeroCost)
    })
  }
}
