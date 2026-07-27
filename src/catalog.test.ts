import assert from "node:assert/strict"
import test from "node:test"
import type { CatalogDraft } from "@opencode-ai/plugin/v2/promise"
import { applyAnthropicCatalog, providerFileUrl } from "./catalog.ts"

type ProviderRecord = {
  provider: Record<string, unknown>
  models: Map<string, Record<string, unknown>>
}

function draftFrom(records: ProviderRecord[]): CatalogDraft {
  return {
    provider: {
      list: () => records as never,
      get: (providerID) =>
        records.find((record) => record.provider.id === providerID) as never,
      update: (providerID, update) => {
        const record = records.find((entry) => entry.provider.id === providerID)
        if (record) update(record.provider as never)
      },
      remove: () => {},
    },
    model: {
      get: (providerID, modelID) =>
        records
          .find((record) => record.provider.id === providerID)
          ?.models.get(modelID) as never,
      update: (providerID, modelID, update) => {
        const currentModel = records
          .find((record) => record.provider.id === providerID)
          ?.models.get(modelID)
        if (currentModel) update(currentModel as never)
      },
      remove: () => {},
      default: {
        get: () => undefined,
        set: () => {},
      },
    },
  }
}

function makeModel(input: Partial<Record<string, unknown>> = {}) {
  return {
    id: input.id ?? "claude-sonnet-4-5",
    modelID: input.modelID ?? input.id ?? "claude-sonnet-4-5",
    providerID: input.providerID ?? "anthropic",
    name: input.name ?? "Claude Sonnet 4.5",
    package: input.package,
    metadata: input.metadata,
    capabilities: input.capabilities ?? {
      tools: true,
      input: ["text", "image"],
      output: ["text"],
    },
    variants: input.variants ?? [
      { id: "thinking", settings: { effort: "high" } },
    ],
    time: { released: 1 },
    cost: input.cost ?? [
      {
        tier: { type: "context", size: 200_000 },
        input: 3,
        output: 15,
        cache: { read: 0.3, write: 3.75 },
      },
    ],
    status: "active",
    enabled: true,
    limit: { context: 200_000, output: 64_000 },
  }
}

test("providerFileUrl resolves provider.js next to a dist index URL", () => {
  assert.equal(
    providerFileUrl("file:///Users/me/plugin/dist/index.js"),
    "file:///Users/me/plugin/dist/provider.js",
  )
})

test("routes only the Anthropic provider and its recognized models through the provider file", () => {
  const fileUrl = providerFileUrl()
  const capabilities = { tools: true, input: ["text"], output: ["text"] }
  const variants = [{ id: "opus", body: { thinking: true } }]
  const metadata = { source: "catalog" }
  const explicitAisdkModel = makeModel({
    id: "claude-explicit-aisdk",
    package: "aisdk:@ai-sdk/anthropic",
    capabilities,
    variants,
    metadata,
  })
  const explicitNativeModel = makeModel({
    id: "claude-explicit-native",
    package: "@opencode-ai/ai/providers/anthropic",
  })
  const legacyModel = makeModel({ id: "claude-legacy", package: undefined })
  const customModel = makeModel({
    id: "claude-custom",
    package: "vendor:custom-anthropic-model",
  })
  const customBefore = structuredClone(customModel)
  const githubCopilotModel = makeModel({
    id: "copilot-claude",
    providerID: "github-copilot",
    package: "aisdk:@ai-sdk/anthropic",
  })
  const openaiModel = makeModel({
    id: "openai-claude-ish",
    providerID: "openai",
    package: "aisdk:@ai-sdk/anthropic",
  })
  const githubBefore = structuredClone(githubCopilotModel)
  const openaiBefore = structuredClone(openaiModel)
  const records: ProviderRecord[] = [
    {
      provider: {
        id: "anthropic",
        name: "Anthropic",
        package: "aisdk:@ai-sdk/anthropic",
      },
      models: new Map([
        [explicitAisdkModel.id, explicitAisdkModel],
        [explicitNativeModel.id, explicitNativeModel],
        [legacyModel.id, legacyModel],
        [customModel.id, customModel],
      ]),
    },
    {
      provider: {
        id: "github-copilot",
        name: "GitHub Copilot",
        package: "aisdk:@ai-sdk/anthropic",
      },
      models: new Map([[githubCopilotModel.id, githubCopilotModel]]),
    },
    {
      provider: {
        id: "openai",
        name: "OpenAI",
        package: "aisdk:@ai-sdk/anthropic",
      },
      models: new Map([[openaiModel.id, openaiModel]]),
    },
  ]

  applyAnthropicCatalog(draftFrom(records))

  assert.equal(records[0].provider.package, fileUrl)
  assert.equal(records[0].provider.integrationID, "anthropic")
  assert.equal(explicitAisdkModel.package, fileUrl)
  assert.equal(explicitNativeModel.package, fileUrl)
  assert.equal(legacyModel.package, undefined)
  assert.deepEqual(customModel, customBefore)
  assert.deepEqual(explicitAisdkModel.cost, [])
  assert.deepEqual(explicitNativeModel.cost, [])
  assert.deepEqual(legacyModel.cost, [])
  assert.equal(explicitAisdkModel.metadata, metadata)
  assert.equal(explicitAisdkModel.capabilities, capabilities)
  assert.deepEqual(explicitAisdkModel.variants.slice(1), variants)
  assert.deepEqual(githubCopilotModel, githubBefore)
  assert.deepEqual(openaiModel, openaiBefore)
})

test("does not hijack an Anthropic record whose provider package is not recognized", () => {
  const unrecognizedModel = makeModel({
    id: "claude-unrecognized-provider",
    package: "aisdk:@ai-sdk/anthropic",
  })
  const records: ProviderRecord[] = [
    {
      provider: {
        id: "anthropic",
        name: "Anthropic compatible",
        package: "vendor:custom-anthropic-compatible",
      },
      models: new Map([[unrecognizedModel.id, unrecognizedModel]]),
    },
  ]
  const before = structuredClone(records[0])

  applyAnthropicCatalog(draftFrom(records))

  assert.deepEqual(records[0], before)
})

test("adds a no-effort variant to routed Anthropic models without mutating existing variants", () => {
  const existingNone = {
    id: "none",
    settings: { thinking: { type: "disabled" }, effort: "custom" },
    label: "No thinking",
  }
  const inheritedModel = makeModel({
    id: "claude-inherited",
    package: undefined,
    variants: [{ id: "thinking", settings: { effort: "high" } }],
  })
  const explicitModel = makeModel({
    id: "claude-explicit",
    package: "aisdk:@ai-sdk/anthropic",
    variants: [{ id: "thinking", settings: { effort: "medium" } }],
  })
  const modelWithNone = makeModel({
    id: "claude-existing-none",
    package: "@opencode-ai/ai/providers/anthropic",
    variants: [existingNone, { id: "thinking", settings: { effort: "low" } }],
  })
  const customModel = makeModel({
    id: "claude-custom-package",
    package: "vendor:custom-anthropic-model",
    variants: [{ id: "thinking", settings: { effort: "high" } }],
  })
  const openaiModel = makeModel({
    id: "openai-claude-ish",
    providerID: "openai",
    package: "aisdk:@ai-sdk/anthropic",
    variants: [{ id: "thinking", settings: { effort: "high" } }],
  })
  const customBefore = structuredClone(customModel)
  const openaiBefore = structuredClone(openaiModel)
  const records: ProviderRecord[] = [
    {
      provider: {
        id: "anthropic",
        name: "Anthropic",
        package: "aisdk:@ai-sdk/anthropic",
      },
      models: new Map([
        [inheritedModel.id, inheritedModel],
        [explicitModel.id, explicitModel],
        [modelWithNone.id, modelWithNone],
        [customModel.id, customModel],
      ]),
    },
    {
      provider: {
        id: "openai",
        name: "OpenAI",
        package: "aisdk:@ai-sdk/anthropic",
      },
      models: new Map([[openaiModel.id, openaiModel]]),
    },
  ]

  applyAnthropicCatalog(draftFrom(records))

  const noEffortVariant = {
    id: "none",
    settings: { thinking: { type: "disabled" } },
  }
  assert.deepEqual(inheritedModel.variants[0], noEffortVariant)
  assert.equal("effort" in inheritedModel.variants[0].settings, false)
  assert.deepEqual(inheritedModel.variants.slice(1), [
    { id: "thinking", settings: { effort: "high" } },
  ])
  assert.deepEqual(explicitModel.variants[0], noEffortVariant)
  assert.equal("effort" in explicitModel.variants[0].settings, false)
  assert.deepEqual(explicitModel.variants.slice(1), [
    { id: "thinking", settings: { effort: "medium" } },
  ])
  assert.equal(modelWithNone.variants[0], existingNone)
  assert.equal(
    modelWithNone.variants.filter((variant) => variant.id === "none").length,
    1,
  )
  assert.deepEqual(customModel, customBefore)
  assert.deepEqual(openaiModel, openaiBefore)
})
