import type { CatalogDraft } from "@opencode-ai/plugin/promise/catalog"
import { ANTHROPIC_INTEGRATION_ID } from "./integration.ts"

const ANTHROPIC_PROVIDER_ID = "anthropic"
const ANTHROPIC_PACKAGES = new Set([
  "aisdk:@ai-sdk/anthropic",
  "@opencode-ai/ai/providers/anthropic",
])

type CatalogModel = NonNullable<ReturnType<CatalogDraft["model"]["get"]>>
type RuntimeProvider = {
  package?: unknown
  integrationID?: string
}

type ModelVariant = {
  readonly id: string
  readonly settings?: Record<string, unknown>
}

type RuntimeModel = Omit<CatalogModel, "variants" | "cost"> & {
  package?: unknown
  variants: ModelVariant[]
  cost: unknown[]
}

type RuntimeCatalogDraft = {
  readonly provider: {
    readonly get: (providerID: string) =>
      | {
          readonly provider: RuntimeProvider
          readonly models: ReadonlyMap<string, unknown>
        }
      | undefined
    readonly update: (
      providerID: string,
      update: (provider: RuntimeProvider) => void,
    ) => void
  }
  readonly model: {
    readonly update: (
      providerID: string,
      modelID: string,
      update: (model: RuntimeModel) => void,
    ) => void
  }
}

export function providerFileUrl(baseUrl = import.meta.url): string {
  return new URL("./provider.js", baseUrl).href
}

function isAnthropicPackage(value: unknown): value is string {
  return typeof value === "string" && ANTHROPIC_PACKAGES.has(value)
}

function ensureNoEffortVariant(variants: ModelVariant[]): ModelVariant[] {
  if (variants.some((variant) => variant.id === "none")) return variants
  return [
    { id: "none", settings: { thinking: { type: "disabled" } } },
    ...variants,
  ]
}

export function applyAnthropicCatalog(draft: CatalogDraft): void {
  const runtime = draft as unknown as RuntimeCatalogDraft
  const record = runtime.provider.get(ANTHROPIC_PROVIDER_ID)
  if (!record || !isAnthropicPackage(record.provider.package)) return

  const url = providerFileUrl()

  runtime.provider.update(ANTHROPIC_PROVIDER_ID, (provider) => {
    provider.package = url
    provider.integrationID = ANTHROPIC_INTEGRATION_ID
  })

  for (const [modelID] of record.models) {
    runtime.model.update(ANTHROPIC_PROVIDER_ID, modelID, (model) => {
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
