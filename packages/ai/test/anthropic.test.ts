import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../src/providers/anthropic.js";

/** A fake of the two SDK methods the adapter uses. */
function fakeClient(capture: { params?: unknown }) {
  const final = {
    model: "claude-sonnet-5",
    stop_reason: "end_turn",
    usage: {
      input_tokens: 12,
      output_tokens: 3,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 0,
    },
  };
  return {
    messages: {
      stream(params: unknown) {
        capture.params = params;
        const events = [
          { type: "content_block_delta", delta: { type: "text_delta", text: "Hi " } },
          { type: "content_block_delta", delta: { type: "text_delta", text: "there" } },
        ];
        return Object.assign(
          (async function* () {
            for (const e of events) yield e;
          })(),
          { finalMessage: async () => final },
        );
      },
    },
  } as unknown as Anthropic;
}

describe("AnthropicProvider", () => {
  it("marks the system prompt cacheable, passes effort, streams text and reports usage", async () => {
    const capture: { params?: unknown } = {};
    const p = new AnthropicProvider({ id: "anth", apiKey: "k", client: fakeClient(capture) });
    const events = [];
    for await (const ev of p.chat("claude-sonnet-5", {
      system: "You interview employees.",
      messages: [{ role: "user", content: "hello" }],
      maxOutputTokens: 500,
      effort: "low",
      cachePrefix: true,
    }))
      events.push(ev);
    expect(events).toEqual([
      { type: "text", text: "Hi " },
      { type: "text", text: "there" },
      {
        type: "done",
        usage: { inputTokens: 12, cacheReadTokens: 800, cacheWriteTokens: 0, outputTokens: 3 },
        stopReason: "end_turn",
        model: "claude-sonnet-5",
      },
    ]);
    expect(capture.params).toEqual({
      model: "claude-sonnet-5",
      max_tokens: 500,
      system: [{ type: "text", text: "You interview employees.", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "hello" }],
      output_config: { effort: "low" },
    });
  });

  it("sends the system prompt as a plain string when caching is off", async () => {
    const capture: { params?: unknown } = {};
    const p = new AnthropicProvider({ id: "anth", apiKey: "k", client: fakeClient(capture) });
    for await (const ev of p.chat("m", {
      system: "s",
      messages: [{ role: "user", content: "x" }],
      maxOutputTokens: 10,
      cachePrefix: false,
    }))
      ev;
    expect((capture.params as { system: unknown }).system).toBe("s");
  });
});
