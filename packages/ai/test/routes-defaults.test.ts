import { PLANNED_PURPOSES, PURPOSES, ROUTABLE_PURPOSES, RouteSchema } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import { META_SEED_PRICES } from "../src/cost/pricing.js";
import {
  defaultAnthropicRoutes,
  defaultMetaRoutes,
  defaultOpenAIRoutes,
  defaultOpenRouterRoutes,
  META_DEFAULT_MODEL,
} from "../src/routes/defaults.js";

describe("platform default routes", () => {
  it("never routes a purpose that does not exist", () => {
    for (const rows of [
      defaultAnthropicRoutes("p"),
      defaultOpenRouterRoutes("p"),
      defaultMetaRoutes("p"),
      defaultOpenAIRoutes("p"),
    ]) {
      for (const r of rows) expect(PURPOSES).toContain(r.purpose);
    }
  });

  it("routes each purpose at most once per provider", () => {
    for (const rows of [
      defaultAnthropicRoutes("p"),
      defaultOpenRouterRoutes("p"),
      defaultMetaRoutes("p"),
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

    expect(openai).toEqual(["embedding", "stt_stream", "transcription", "tts"]);
  });

  it("leaves audio and embeddings alone in the conversation providers, which cannot do them", () => {
    const audioAndVectors = new Set(["transcription", "tts", "stt_stream", "realtime_voice", "embedding"]);
    for (const rows of [defaultAnthropicRoutes("p"), defaultOpenRouterRoutes("p"), defaultMetaRoutes("p")]) {
      for (const r of rows) expect(audioAndVectors.has(r.purpose)).toBe(false);
    }
  });

  /**
   * Every default must survive the schema the route resolver parses with. The audio routes carry
   * `maxOutputTokens: 0`, which a positive-only schema rejected at resolve time, so the voice the
   * bootstrap configured failed on its first use.
   */
  it("parses as a route the resolver accepts", () => {
    for (const rows of [
      defaultAnthropicRoutes("p"),
      defaultOpenRouterRoutes("p"),
      defaultMetaRoutes("p"),
      defaultOpenAIRoutes("p"),
    ]) {
      for (const r of rows) expect(RouteSchema.safeParse(r).success).toBe(true);
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
    // The planned purposes (D-187) are the only other exemption.
    expect(ROUTABLE_PURPOSES).toHaveLength(PURPOSES.length - 1 - PLANNED_PURPOSES.length);
    for (const rows of [
      defaultAnthropicRoutes("p"),
      defaultOpenRouterRoutes("p"),
      defaultMetaRoutes("p"),
      defaultOpenAIRoutes("p"),
    ]) {
      expect(rows.map((r) => r.purpose)).not.toContain("probe");
    }
  });
});

describe("Meta default routes (D-495)", () => {
  it("cover the same purposes as the other language providers, at the same efforts", () => {
    const byPurpose = (rows: ReturnType<typeof defaultMetaRoutes>) =>
      Object.fromEntries(rows.map((r) => [r.purpose, r.effort]));
    expect(byPurpose(defaultMetaRoutes("p"))).toEqual(byPurpose(defaultAnthropicRoutes("p")));
  });

  it("use one standard model, never a contributor variant, and every routed model has a seed price", () => {
    const rows = defaultMetaRoutes("p");
    expect(new Set(rows.map((r) => r.model))).toEqual(new Set([META_DEFAULT_MODEL]));
    for (const r of rows) expect(r.model).not.toMatch(/contributor/);
    const priced = new Set(META_SEED_PRICES.map((p) => p.model));
    for (const r of rows) expect(priced.has(r.model)).toBe(true);
  });

  it("take another model when the operator names one", () => {
    expect(new Set(defaultMetaRoutes("p", "muse-spark-1.2").map((r) => r.model))).toEqual(
      new Set(["muse-spark-1.2"]),
    );
  });
});
