import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AuditPageSchema,
  CampaignPageSchema,
  ModelCatalogueSchema,
  ModelPriceRowSchema,
  pagedOf,
  PricePageSchema,
  ScopeTargetListSchema,
  SettingsResponseSchema,
  UserPageSchema,
} from "@/lib/api/schemas";

const Item = z.looseObject({ id: z.string() });

describe("pagedOf", () => {
  it("reads the contract 19 envelope", () => {
    const page = pagedOf(Item, "things").parse({
      things: [{ id: "a" }, { id: "b" }],
      total: 120,
      limit: 50,
      offset: 50,
    });
    expect(page.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(page).toMatchObject({ total: 120, limit: 50, offset: 50 });
  });

  it("still accepts the old bare array, with unknown counters", () => {
    const page = pagedOf(Item, "things").parse([{ id: "a" }]);
    expect(page.items).toHaveLength(1);
    expect(page.total).toBeNull();
    expect(page.limit).toBeNull();
    expect(page.offset).toBeNull();
  });

  it("accepts the generic envelopes the older API used", () => {
    expect(pagedOf(Item, "things").parse({ items: [{ id: "a" }] }).items).toHaveLength(1);
    expect(pagedOf(Item, "things").parse({ rows: [{ id: "a" }] }).items).toHaveLength(1);
    expect(pagedOf(Item, "things").parse({ data: [{ id: "a" }] }).items).toHaveLength(1);
  });

  it("ignores counters that are not numbers", () => {
    const page = pagedOf(Item, "things").parse({ things: [], total: "many", limit: null });
    expect(page.total).toBeNull();
    expect(page.limit).toBeNull();
  });

  it("is tolerant of extra fields on the rows", () => {
    const page = pagedOf(Item, "things").parse({ things: [{ id: "a", surprise: 1 }], total: 1 });
    expect(page.items[0]).toMatchObject({ id: "a", surprise: 1 });
  });
});

describe("the paginated staff lists", () => {
  it("parses users, campaigns and audit in both shapes", () => {
    const bare = UserPageSchema.parse([{ id: "u1", email: "a@b.fi", role: "admin" }]);
    expect(bare.items).toHaveLength(1);
    expect(bare.total).toBeNull();

    const paged = UserPageSchema.parse({
      users: [{ id: "u1", email: "a@b.fi", role: "admin" }],
      total: 1,
      limit: 50,
      offset: 0,
    });
    expect(paged.total).toBe(1);

    expect(CampaignPageSchema.parse({ campaigns: [{ id: "c1", name: "Q1" }], total: 3 }).total).toBe(3);
    expect(AuditPageSchema.parse({ audit: [{ action: "settings.update" }] }).items).toHaveLength(1);
    expect(AuditPageSchema.parse([{ action: "settings.update" }]).items).toHaveLength(1);
  });

  it("parses the stored price rows, which are keyed by model", () => {
    const page = PricePageSchema.parse({
      prices: [
        {
          providerId: "p1",
          model: "claude-opus-4",
          inputPerMtok: 15,
          cachedInputPerMtok: 1.5,
          outputPerMtok: 75,
          source: "admin",
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
    });
    expect(page.items[0]).toMatchObject({ model: "claude-opus-4", source: "admin" });
    expect(ModelPriceRowSchema.parse({ model: "m", source: "seed" }).source).toBe("seed");
  });
});

describe("ModelCatalogueSchema", () => {
  it("reads the catalogue response with its freshness fields", () => {
    const c = ModelCatalogueSchema.parse({
      models: [{ id: "claude-opus-4", name: "Claude Opus 4", contextWindow: 200000, inputPerMtok: 15 }],
      importedPrices: 4,
      fetchedAt: "2026-09-14T09:00:00Z",
      stale: false,
    });
    expect(c.models[0]).toMatchObject({ id: "claude-opus-4", contextWindow: 200000 });
    expect(c.importedPrices).toBe(4);
    expect(c.stale).toBe(false);
  });

  it("degrades to a stale answer with a null fetchedAt and an error", () => {
    const c = ModelCatalogueSchema.parse({ models: [], stale: true, fetchedAt: null, error: "timeout" });
    expect(c.stale).toBe(true);
    expect(c.fetchedAt).toBeNull();
    expect(c.error).toBe("timeout");
  });

  it("tolerates a bare array of models", () => {
    const c = ModelCatalogueSchema.parse([{ id: "m", name: "M" }]);
    expect(c.models).toHaveLength(1);
    expect(c.stale).toBe(false);
  });
});

describe("SettingsResponseSchema", () => {
  it("reads secrets, effective values and sources when the API sends them", () => {
    const r = SettingsResponseSchema.parse({
      values: { "email.smtpUrl": "__unchanged__" },
      effective: { "email.smtpUrl": "__unchanged__", "email.from": "a@b.fi" },
      secrets: { "email.smtpUrl": true },
      sources: { "email.from": "platform" },
      catalog: [{ key: "email.smtpUrl", category: "email", default: "", scopes: [], secret: true }],
    });
    expect(r.secrets).toEqual({ "email.smtpUrl": true });
    expect(r.effective).toMatchObject({ "email.from": "a@b.fi" });
    expect(r.catalog[0]?.secret).toBe(true);
  });

  it("still parses a response without any of the new fields", () => {
    const r = SettingsResponseSchema.parse({
      values: {},
      catalog: [{ key: "engine.maxTurns", category: "engine", default: 40, scopes: ["tenant"] }],
    });
    expect(r.secrets).toBeUndefined();
    expect(r.effective).toBeUndefined();
    expect(r.catalog[0]?.secret).toBeUndefined();
  });
});

describe("ScopeTargetListSchema", () => {
  it("unwraps the targets envelope and tolerates a bare array", () => {
    expect(
      ScopeTargetListSchema.parse({ targets: [{ id: "c1", name: "Q1", detail: "12 sessions" }] }),
    ).toEqual([{ id: "c1", name: "Q1", detail: "12 sessions" }]);
    expect(ScopeTargetListSchema.parse([{ id: "c1" }])[0]).toMatchObject({ id: "c1", name: "" });
  });
});
