import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Writable } from "node:stream"
import { closeLogger, initLogger } from "./logger.ts"
import {
  applyToolRepair,
  repairToolPairs,
  resolveToolRepairMode,
  synthesizeMissingToolResults,
  TOOL_RESULT_PLACEHOLDER,
  transformBody,
} from "./transforms.ts"

function captureLog(fn: () => void): string[] {
  const lines: string[] = []
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString())
      cb()
    },
  })
  initLogger({ stream })
  try {
    fn()
  } finally {
    closeLogger()
  }
  return lines
}

describe("upstream compaction repair", () => {
  describe("repairToolPairs", () => {
    it("removes tool_use blocks with no matching tool_result", () => {
      const messages = [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_orphan", name: "search" }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "no tool_result here" }],
        },
      ]
      const result = repairToolPairs(messages)
      // The assistant message with only the orphaned tool_use should be removed
      assert.equal(result.length, 1)
      assert.equal(result[0].role, "user")
    })

    it("removes tool_result blocks with no matching tool_use", () => {
      const messages = [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_orphan", content: "ok" },
          ],
        },
      ]
      const result = repairToolPairs(messages)
      // The user message with only the orphaned tool_result should be removed
      assert.equal(result.length, 0)
    })

    it("preserves text blocks when removing orphaned tool_use", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "text", text: "I will search for that." },
            { type: "tool_use", id: "toolu_orphan", name: "search" },
          ],
        },
      ]
      const result = repairToolPairs(messages)
      assert.equal(result.length, 1)
      assert.deepEqual(result[0].content, [
        { type: "text", text: "I will search for that." },
      ])
    })

    it("does not modify valid tool_use/tool_result pairs", () => {
      const messages = [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_valid", name: "search" }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_valid", content: "ok" },
          ],
        },
      ]
      const result = repairToolPairs(messages)
      assert.equal(result.length, 2)
      assert.deepEqual(result, messages)
    })

    it("passes through messages with no tool blocks", () => {
      const messages = [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "assistant", content: [{ type: "text", text: "world" }] },
      ]
      const result = repairToolPairs(messages)
      assert.deepEqual(result, messages)
    })

    it("handles mix of valid and orphaned tool blocks", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_valid", name: "search" },
            { type: "tool_use", id: "toolu_orphan", name: "lookup" },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_valid", content: "ok" },
          ],
        },
      ]
      const result = repairToolPairs(messages)
      assert.equal(result.length, 2)
      // Only the valid tool_use remains
      assert.deepEqual(result[0].content, [
        { type: "tool_use", id: "toolu_valid", name: "search" },
      ])
      // tool_result for valid stays
      assert.deepEqual(result[1].content, [
        { type: "tool_result", tool_use_id: "toolu_valid", content: "ok" },
      ])
    })

    it("removes pairs whose tool_result is not in the immediately following message", () => {
      // The /undo + /compact shape from issue #212: the pair still exists,
      // but a summary message sits between tool_use and tool_result.
      const messages = [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_gap", name: "search" }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "compaction summary" }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_gap", content: "late" },
          ],
        },
      ]
      const result = repairToolPairs(messages)
      assert.deepEqual(result, [
        {
          role: "user",
          content: [{ type: "text", text: "compaction summary" }],
        },
      ])
    })

    it("keeps adjacent pairs while dropping results split into a later message", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_a", name: "search" },
            { type: "tool_use", id: "toolu_b", name: "read" },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_a", content: "res_a" },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_b", content: "res_b" },
          ],
        },
      ]
      const result = repairToolPairs(messages)
      assert.deepEqual(result, [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_a", name: "search" }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_a", content: "res_a" },
          ],
        },
      ])
    })

    it("removes reversed pairs where the tool_result precedes its tool_use", () => {
      const messages = [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_rev", content: "early" },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "answer" },
            { type: "tool_use", id: "toolu_rev", name: "search" },
          ],
        },
      ]
      const result = repairToolPairs(messages)
      assert.deepEqual(result, [
        {
          role: "assistant",
          content: [{ type: "text", text: "answer" }],
        },
      ])
    })

    it("preserves messages with string content", () => {
      const messages = [
        { role: "user", content: "just a string" },
        { role: "assistant", content: "response string" },
      ]
      const result = repairToolPairs(messages)
      assert.deepEqual(result, messages)
    })

    it("handles multiple valid pairs", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_a", name: "search" },
            { type: "tool_use", id: "toolu_b", name: "read" },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_a", content: "res_a" },
            { type: "tool_result", tool_use_id: "toolu_b", content: "res_b" },
          ],
        },
      ]
      const result = repairToolPairs(messages)
      assert.deepEqual(result, messages)
    })
  })

  it("transformBody in drop mode removes orphaned tool_use blocks from messages", () => {
    const input = JSON.stringify({
      system: [{ type: "text", text: "prompt" }],
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_orphan", name: "search" }],
        },
        { role: "user", content: "hello" },
      ],
    })

    const output = transformBody(input, "drop")
    const parsed = JSON.parse(output as string) as {
      messages: Array<{ role: string; content: unknown }>
    }

    // Orphaned tool_use message should be removed.
    // The user message remains, with the relocated system "prompt" prepended.
    assert.equal(parsed.messages.length, 1)
    assert.equal(parsed.messages[0].role, "user")
    assert.ok(
      (parsed.messages[0].content as string).includes("hello"),
      "User message content should be preserved",
    )
  })

  it("transformBody defaults to placeholder mode: synthesizes a tool_result for an orphaned tool_use in a thinking turn", () => {
    const input = JSON.stringify({
      system: [{ type: "text", text: "prompt" }],
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "reasoning", signature: "sig" },
            { type: "tool_use", id: "toolu_orphan", name: "search" },
          ],
        },
        { role: "user", content: "hello" },
      ],
    })

    const output = transformBody(input)
    const parsed = JSON.parse(output as string) as {
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>
    }

    // The thinking turn is preserved intact — thinking block AND the tool_use
    // (now PascalCase-prefixed) both remain; nothing is dropped.
    const assistant = parsed.messages[0]
    assert.ok(
      assistant.content.some((b) => b.type === "thinking"),
      "thinking block preserved",
    )
    assert.ok(
      assistant.content.some(
        (b) => b.type === "tool_use" && b.name === "mcp_Search",
      ),
      "orphaned tool_use preserved (not dropped)",
    )

    // A synthetic tool_result now leads the adjacent user turn, which was plain
    // text and is converted to blocks (no second, consecutive user message).
    assert.equal(parsed.messages.length, 2)
    const userTurn = parsed.messages[1]
    assert.equal(userTurn.role, "user")
    assert.equal(userTurn.content[0].type, "tool_result")
    assert.equal(userTurn.content[0].tool_use_id, "toolu_orphan")
    assert.equal(userTurn.content[0].is_error, true)
    // The original user text survives as a trailing text block.
    assert.ok(
      userTurn.content.some(
        (b) => b.type === "text" && String(b.text).includes("hello"),
      ),
      "original user text preserved",
    )
  })

  describe("resolveToolRepairMode", () => {
    it("defaults to placeholder when unset", () => {
      assert.equal(resolveToolRepairMode({}), "placeholder")
    })

    it("honors an explicit drop value", () => {
      assert.equal(
        resolveToolRepairMode({ OPENCODE_CLAUDE_AUTH_TOOL_REPAIR: "drop" }),
        "drop",
      )
    })

    it("is case-insensitive and trims whitespace", () => {
      assert.equal(
        resolveToolRepairMode({ OPENCODE_CLAUDE_AUTH_TOOL_REPAIR: "  DROP " }),
        "drop",
      )
    })

    it("falls back to placeholder for unknown values", () => {
      assert.equal(
        resolveToolRepairMode({ OPENCODE_CLAUDE_AUTH_TOOL_REPAIR: "banana" }),
        "placeholder",
      )
    })
  })

  describe("applyToolRepair dispatch", () => {
    it("routes to the drop path for drop mode", () => {
      const messages = [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_o", name: "read" }],
        },
        { role: "user", content: [{ type: "text", text: "no result" }] },
      ]
      const dropped = applyToolRepair(messages, "drop")
      assert.equal(dropped.length, 1)
      assert.equal(dropped[0].role, "user")
    })

    it("routes to the placeholder path for placeholder mode", () => {
      const messages = [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_o", name: "read" }],
        },
        { role: "user", content: [{ type: "text", text: "no result" }] },
      ]
      const paired = applyToolRepair(messages, "placeholder")
      assert.equal(paired.length, 2)
      assert.equal(
        (paired[1].content as Array<Record<string, unknown>>)[0].type,
        "tool_result",
      )
    })
  })

  describe("repairToolPairs (drop mode hardening)", () => {
    it("omits the entire assistant turn when a thinking turn holds an orphaned tool_use (issue #261)", () => {
      const messages = [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "let me read", signature: "sig" },
            { type: "tool_use", id: "toolu_orphan", name: "read" },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "next step" }] },
      ]
      const result = repairToolPairs(messages)
      // The thinking turn is omitted wholesale — never partially rewritten,
      // which is what Anthropic's thinking-block contract requires.
      assert.deepEqual(result, [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "text", text: "next step" }] },
      ])
    })

    it("drops a later duplicate orphaned tool_use even when the first occurrence is a valid pair", () => {
      const messages = [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_dup", name: "read" }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_dup", content: "ok" },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "again" },
            { type: "tool_use", id: "toolu_dup", name: "read" },
          ],
        },
        { role: "user", content: [{ type: "text", text: "no result" }] },
      ]
      const result = repairToolPairs(messages)
      assert.deepEqual(result, [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_dup", name: "read" }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_dup", content: "ok" },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "again" }] },
        { role: "user", content: [{ type: "text", text: "no result" }] },
      ])
    })

    it("omits a thinking turn that mixes a valid and an orphaned tool_use, leaving no orphans", () => {
      const messages = [
        { role: "user", content: [{ type: "text", text: "go" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "t", signature: "s" },
            { type: "tool_use", id: "toolu_valid", name: "read" },
            { type: "tool_use", id: "toolu_orphan", name: "read" },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_valid", content: "ok" },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "after" }] },
      ]
      // #261 forbids partial rewrites, so the whole thinking turn is dropped —
      // including its valid tool_use — and the now-orphaned result is removed on
      // the next fixed-point pass. Lossy but consistent (no orphans remain).
      const result = repairToolPairs(messages)
      assert.deepEqual(result, [
        { role: "user", content: [{ type: "text", text: "go" }] },
        { role: "assistant", content: [{ type: "text", text: "after" }] },
      ])
    })
  })

  describe("repair diagnostics logging", () => {
    it("emits a redacted repair_orphan_dropped event in drop mode", () => {
      const lines = captureLog(() => {
        repairToolPairs([
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_orphan", name: "read" }],
          },
          { role: "user", content: [{ type: "text", text: "no result" }] },
        ])
      })
      const entry = lines
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .find((e) => e.event === "repair_orphan_dropped")
      assert.ok(entry, "expected a repair_orphan_dropped log line")
      assert.deepEqual(entry.droppedToolUseIds, ["toolu_orphan"])
      // No message content text is ever logged — ids and indices only.
      assert.ok(!JSON.stringify(entry).includes("no result"))
    })

    it("emits repair_orphan_synthesized in placeholder mode", () => {
      const lines = captureLog(() => {
        synthesizeMissingToolResults([
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_orphan", name: "read" }],
          },
          { role: "assistant", content: [{ type: "text", text: "kept" }] },
        ])
      })
      const entry = lines
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .find((e) => e.event === "repair_orphan_synthesized")
      assert.ok(entry, "expected a repair_orphan_synthesized log line")
      assert.deepEqual(entry.synthesizedToolUseIds, ["toolu_orphan"])
    })
  })

  describe("synthesizeMissingToolResults (placeholder mode, default)", () => {
    it("pairs an orphaned tool_use in a thinking turn without mutating the assistant content", () => {
      const thinkingTurn = {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reading", signature: "sig" },
          { type: "tool_use", id: "toolu_thinking", name: "read" },
        ],
      }
      const messages = [
        { role: "user", content: [{ type: "text", text: "go" }] },
        thinkingTurn,
        { role: "assistant", content: [{ type: "text", text: "done" }] },
      ]
      const result = synthesizeMissingToolResults(messages)
      // The assistant thinking turn is byte-identical to the input.
      assert.deepEqual(result[1], thinkingTurn)
      // A synthetic tool_result user turn is inserted immediately after it.
      assert.equal(result[2].role, "user")
      const block = (result[2].content as Array<Record<string, unknown>>)[0]
      assert.equal(block.type, "tool_result")
      assert.equal(block.tool_use_id, "toolu_thinking")
      assert.equal(block.is_error, true)
      // The original following assistant turn survives after the synthetic pair.
      assert.deepEqual(result[3], {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      })
      assert.equal(result.length, 4)
    })

    it("prepends the synthetic tool_result to an adjacent user turn", () => {
      const messages = [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_a", name: "read" }],
        },
        { role: "user", content: [{ type: "text", text: "user says hi" }] },
      ]
      const result = synthesizeMissingToolResults(messages)
      assert.equal(result.length, 2)
      assert.deepEqual((result[1].content as Array<unknown>)[0], {
        type: "tool_result",
        tool_use_id: "toolu_a",
        content: TOOL_RESULT_PLACEHOLDER,
        is_error: true,
      })
      assert.deepEqual((result[1].content as Array<unknown>)[1], {
        type: "text",
        text: "user says hi",
      })
    })

    it("converts a plain-text adjacent user turn to blocks (no second user message)", () => {
      const messages = [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_a", name: "read" }],
        },
        { role: "user", content: "next user text" },
      ]
      const result = synthesizeMissingToolResults(messages)
      // One user turn, not two consecutive ones.
      assert.equal(result.length, 2)
      assert.equal(result[1].role, "user")
      assert.deepEqual(result[1].content, [
        {
          type: "tool_result",
          tool_use_id: "toolu_a",
          content: TOOL_RESULT_PLACEHOLDER,
          is_error: true,
        },
        { type: "text", text: "next user text" },
      ])
    })

    it("preserves a thinking turn that mixes a valid and an orphaned tool_use, synthesizing only the missing result", () => {
      const thinkingTurn = {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "t", signature: "s" },
          { type: "tool_use", id: "toolu_valid", name: "read" },
          { type: "tool_use", id: "toolu_orphan", name: "read" },
        ],
      }
      const messages = [
        { role: "user", content: [{ type: "text", text: "go" }] },
        thinkingTurn,
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_valid", content: "ok" },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "after" }] },
      ]
      const result = synthesizeMissingToolResults(messages)
      // The thinking turn is preserved byte-identical (both tool_uses + thinking).
      assert.deepEqual(result[1], thinkingTurn)
      // Its adjacent user turn now carries results for BOTH ids.
      const ids = (result[2].content as Array<Record<string, unknown>>)
        .filter((b) => b.type === "tool_result")
        .map((b) => b.tool_use_id)
      assert.deepEqual(ids.sort(), ["toolu_orphan", "toolu_valid"])
      assert.deepEqual(result[3], {
        role: "assistant",
        content: [{ type: "text", text: "after" }],
      })
    })

    it("inserts a new user turn when no user message follows the tool_use", () => {
      const messages = [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_a", name: "read" }],
        },
        { role: "assistant", content: [{ type: "text", text: "kept going" }] },
      ]
      const result = synthesizeMissingToolResults(messages)
      assert.equal(result.length, 3)
      assert.equal(result[1].role, "user")
      assert.deepEqual((result[1].content as Array<unknown>)[0], {
        type: "tool_result",
        tool_use_id: "toolu_a",
        content: TOOL_RESULT_PLACEHOLDER,
        is_error: true,
      })
      assert.deepEqual(result[2], {
        role: "assistant",
        content: [{ type: "text", text: "kept going" }],
      })
    })

    it("leaves a valid adjacent pair unchanged", () => {
      const messages = [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_v", name: "read" }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_v", content: "ok" },
          ],
        },
      ]
      const result = synthesizeMissingToolResults(messages)
      assert.deepEqual(result, messages)
    })

    it("removes an orphaned tool_result with no preceding tool_use", () => {
      const messages = [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_x", content: "stale" },
            { type: "text", text: "hello" },
          ],
        },
      ]
      const result = synthesizeMissingToolResults(messages)
      assert.deepEqual(result, [
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ])
    })

    it("preserves messages with string content", () => {
      const messages = [
        { role: "user", content: "just a string" },
        { role: "assistant", content: "response string" },
      ]
      const result = synthesizeMissingToolResults(messages)
      assert.deepEqual(result, messages)
    })
  })
})
