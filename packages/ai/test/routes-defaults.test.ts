import { PURPOSES, ROUTABLE_PURPOSES } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import {
  defaultAnthropicRoutes,
  defaultOpenAIRoutes,
  defaultOpenRouterRoutes,
} from "../src/routes/defaults.js";

describe("platform default routes", () => {
  it("never routes a purpose that does not exist", () => {
    for (const rows of [
      defaultAnthropicRoutes("p"),
      defaultOpenRouterRoutes("p"),
      defaultOpenAIRoutes("p"),
    ]) {
      for (const r of rows) expect(PURPOSES).toContain(r.purpose);
    }
  });

  it("routes each purpose at most once per provider", () => {
    for (const rows of [
      defaultAnthropicRoutes("p"),
      defaultOpenRouterRoutes("p"),
      defaultOpenAIRoutes("p"),
    ]) {
      expect(new Set(rows.map((r) => r.purpose)).size).toBe(rows.length);
    }
  });

  /**
   * The boundary that makes the three sets composable. OpenAI exists to fill the holes the other
   * two leave; if it started claiming conversation purposes, bootstrapping a second key would
   * silently move a tenant's interviews onto a provider they did not choose.
   */
  it("gives OpenAI only the purposes neither other provider can serve", () => {
    const openai = defaultOpenAIRoutes("p")
      .map((r) => r.purpose)
      .sort();

    expect(openai).toEqual(["embedding", "transcription", "tts"]);
  });

  it("leaves audio and embeddings alone in the conversation providers, which cannot do them", () => {
    const audioAndVectors = new Set(["transcription", "tts", "stt_stream", "realtime_voice", "embedding"]);
    for (const rows of [defaultAnthropicRoutes("p"), defaultOpenRouterRoutes("p")]) {
      for (const r of rows) expect(audioAndVectors.has(r.purpose)).toBe(false);
    }
  });

  it("routes the purpose that blocks everything else", () => {
    // With no `interview_turn` route no interview can start, so both conversation providers must
    // supply one or a first boot produces a system that cannot do anything.
    for (const rows of [defaultAnthropicRoutes("p"), defaultOpenRouterRoutes("p")]) {
      expect(rows.map((r) => r.purpose)).toContain("interview_turn");
    }
  });

  /**
   * `probe` is a purpose so the ledger can name it, but it is never routed: the caller pins the
   * provider. A route for it would be dead configuration the admin screen offered and nothing read.
   */
  it("exempts probe: a purpose, never routable, never given a default route", () => {
    expect(PURPOSES).toContain("probe");
    expect(ROUTABLE_PURPOSES).not.toContain("probe");
    expect(ROUTABLE_PURPOSES).toHaveLength(PURPOSES.length - 1);
    for (const rows of [
      defaultAnthropicRoutes("p"),
      defaultOpenRouterRoutes("p"),
      defaultOpenAIRoutes("p"),
    ]) {
      expect(rows.map((r) => r.purpose)).not.toContain("probe");
    }
  });
});
