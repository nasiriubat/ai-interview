import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PageQuery, listEnvelope, listQuery, listSpec, toListResponse } from "../src/index.js";

describe("PageQuery", () => {
  it("defaults the window and coerces query strings", () => {
    expect(PageQuery.parse({})).toEqual({ limit: 50, offset: 0 });
    expect(PageQuery.parse({ limit: "25", offset: "100" })).toEqual({ limit: 25, offset: 100 });
  });

  it("refuses a window outside 1..200 and a negative offset", () => {
    expect(PageQuery.safeParse({ limit: 0 }).success).toBe(false);
    expect(PageQuery.safeParse({ limit: 201 }).success).toBe(false);
    expect(PageQuery.safeParse({ offset: -1 }).success).toBe(false);
  });
});

describe("listQuery", () => {
  const spec = listSpec({
    sort: { createdAt: "desc", name: "asc" },
    defaultSort: "createdAt",
    filters: { status: z.enum(["open", "closed"]).optional() },
  });

  it("accepts only the declared sort keys and filters", () => {
    const schema = listQuery(spec);
    expect(schema.parse({}).sort).toBe("createdAt");
    expect(schema.safeParse({ sort: "password" }).success).toBe(false);
    expect(schema.safeParse({ status: "nope" }).success).toBe(false);
    expect(schema.parse({ q: "  x  ", sort: "name", dir: "desc" })).toMatchObject({ q: "x", sort: "name" });
  });
});

describe("list envelope", () => {
  const Item = z.object({ id: z.string() });

  it("keeps the list key and carries the counters", () => {
    const body = toListResponse("users", [{ id: "a" }], 7, { limit: 50, offset: 0 });
    expect(body).toEqual({ users: [{ id: "a" }], total: 7, limit: 50, offset: 0 });
    expect(listEnvelope("users", Item).parse(body).users).toHaveLength(1);
  });

  it("rejects a body without counters, so a client cannot mistake it for a page", () => {
    expect(listEnvelope("users", Item).safeParse({ users: [] }).success).toBe(false);
  });
});
