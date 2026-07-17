import type { SystemPart as SystemPartType } from "@opencode-ai/ai"
import type { SessionContext } from "@opencode-ai/plugin/v2/session"

const ANTHROPIC_PROVIDER_ID = "anthropic"

export const CLAUDE_CODE_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude."

function makeClaudeIdentityPart(): SystemPartType {
  return { type: "text", text: CLAUDE_CODE_IDENTITY }
}

function hasExactIdentityText(part: unknown): part is { text: string } {
  return (
    typeof part === "object" &&
    part !== null &&
    "text" in part &&
    typeof part.text === "string" &&
    part.text === CLAUDE_CODE_IDENTITY
  )
}

export function injectClaudeIdentity(context: SessionContext): void {
  if (context.model.providerID !== ANTHROPIC_PROVIDER_ID) return

  const existing = context.system.find(hasExactIdentityText)
  const identity = existing ?? makeClaudeIdentityPart()
  const rest = context.system.filter((part) => !hasExactIdentityText(part))

  context.system.splice(
    0,
    context.system.length,
    identity as SystemPartType,
    ...rest,
  )
}
