import assert from "node:assert/strict"
import test from "node:test"
import type { SystemPart } from "@opencode/ai"
import {
  CLAUDE_CODE_IDENTITY,
  injectClaudeIdentity,
} from "./session-context.ts"

type SessionContext = {
  readonly sessionID: string
  readonly agent: string
  readonly model: { readonly providerID: string; readonly modelID: string }
  readonly system: SystemPart[]
  readonly messages: unknown[]
  readonly tools: Record<string, unknown>
}

function context(providerID: string, system: unknown[] = []): SessionContext {
  return {
    sessionID: "session-1",
    agent: "build",
    model: { providerID, modelID: "claude-sonnet-4-5" },
    system: system as SystemPart[],
    messages: [],
    tools: {},
  } as unknown as SessionContext
}

test("injects the exact Claude Code identity at the beginning for Anthropic", () => {
  const existing = { type: "text", text: "Existing instructions" }
  const input = context("anthropic", [existing])

  injectClaudeIdentity(input)

  assert.equal(input.system[0]?.text, CLAUDE_CODE_IDENTITY)
  assert.equal(input.system[1], existing)
})

test("is idempotent and safely checks text before moving the identity to the start", () => {
  const input = context("anthropic", [
    { type: "opaque", value: "no text property" },
    { type: "text", text: CLAUDE_CODE_IDENTITY },
    { type: "text", text: "Other instructions" },
  ])

  injectClaudeIdentity(input)
  injectClaudeIdentity(input)

  assert.equal(input.system[0]?.text, CLAUDE_CODE_IDENTITY)
  assert.equal(
    input.system.filter((part) => part.text === CLAUDE_CODE_IDENTITY).length,
    1,
  )
})

test("does not inject identity for non-Anthropic providers", () => {
  const system = [{ type: "text", text: "Existing instructions" }]
  const input = context("github-copilot", system)

  injectClaudeIdentity(input)

  assert.deepEqual(input.system, system)
})
