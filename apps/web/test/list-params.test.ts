import { describe, expect, it } from "vitest";
import { listHref, listParams, sortHref } from "@/lib/admin/pagination";
import type { Transport } from "@/lib/api/http";
import { LISTS } from "@/lib/api/lists";
import { staffApi } from "@/lib/api/staff";

describe("listParams (D-79)", () => {
  it("falls back to the list's defaults and sends only the window", () => {
    const p = listParams({}, LISTS.campaigns);
    expect(p).toMatchObject({ page: 1, limit: 50, offset: 0, q: undefined, sort: "createdAt", dir: "desc" });
    expect(p.filters).toEqual({});
    expect(p.query).toEqual({ limit: 50, offset: 0 });
  });

  it("reads search, sort, direction and filters that the list accepts", () => {
    const p = listParams(
      { q: "  onboarding ", sort: "name", dir: "desc", status: "open", page: "3", limit: "10" },
      LISTS.campaigns,
    );
    expect(p).toMatchObject({ page: 3, limit: 10, offset: 20, q: "onboarding", sort: "name", dir: "desc" });
    expect(p.filters).toEqual({ status: "open" });
    expect(p.query).toEqual({
      limit: 10,
      offset: 20,
      q: "onboarding",
      sort: "name",
      dir: "desc",
      status: "open",
    });
  });

  it("gives a named sort its own default direction when the URL has none", () => {
    expect(listParams({ sort: "name" }, LISTS.campaigns).dir).toBe("asc");
    expect(listParams({ sort: "lastActivity" }, LISTS.campaignSessions).dir).toBe("desc");
    expect(listParams({ sort: "name" }, LISTS.campaigns).query).toEqual({
      limit: 50,
      offset: 0,
      sort: "name",
    });
  });

  it("drops what the list does not accept instead of sending it to the API", () => {
    const p = listParams(
      { sort: "linkTokenHash", dir: "sideways", status: "exploded", role: "admin", q: "   " },
      LISTS.campaigns,
    );
    expect(p.sort).toBe("createdAt");
    expect(p.dir).toBe("desc");
    expect(p.q).toBeUndefined();
    expect(p.filters).toEqual({});
    expect(p.query).toEqual({ limit: 50, offset: 0 });
    // Inherited keys are not sort fields either.
    expect(listParams({ sort: "constructor" }, LISTS.users).sort).toBe("createdAt");
    expect(listParams({ sort: "toString" }, LISTS.users).query).not.toHaveProperty("sort");
  });

  it("ignores q on a list that has nothing to search, and clips it at 200 characters", () => {
    expect(listParams({ q: "v3" }, LISTS.analyses).q).toBeUndefined();
    expect(listParams({ q: "x".repeat(250) }, LISTS.users).q).toHaveLength(200);
  });

  it("takes the first value of a repeated parameter", () => {
    const p = listParams({ status: ["closed", "open"], q: ["a", "b"] }, LISTS.campaigns);
    expect(p.filters).toEqual({ status: "closed" });
    expect(p.q).toBe("a");
  });

  it("validates dates and patterned filters the way the API does", () => {
    const ok = listParams(
      { from: "2026-09-01", to: "2026-09-21", action: "campaign.", targetType: "campaign" },
      LISTS.audit,
    );
    expect(ok.filters).toEqual({
      from: "2026-09-01",
      to: "2026-09-21",
      action: "campaign.",
      targetType: "campaign",
    });

    const bad = listParams(
      { from: "2026-02-31", to: "yesterday", action: "Campaign Create", targetType: "a.b" },
      LISTS.audit,
    );
    expect(bad.filters).toEqual({});
    expect(listParams({ region: "eu-west" }, LISTS.tenants).filters).toEqual({ region: "eu-west" });
    expect(listParams({ region: "EU WEST" }, LISTS.tenants).filters).toEqual({});
  });

  it("puts a backwards date range the right way round", () => {
    const p = listParams({ from: "2026-09-21", to: "2026-09-01" }, LISTS.audit);
    expect(p.filters).toEqual({ from: "2026-09-01", to: "2026-09-21" });
  });

  it("keeps the page key configurable for two lists on one screen", () => {
    const p = listParams({ spage: "2", page: "5" }, LISTS.campaignSessions, 20, "spage");
    expect(p).toMatchObject({ page: 2, offset: 20, limit: 20 });
  });
});

describe("listHref and sortHref", () => {
  it("changes one parameter, keeps the rest and goes back to page 1", () => {
    const sp = { q: "acme", status: "open", page: "4" };
    expect(listHref("/admin/campaigns", sp, { status: "closed" })).toBe(
      "/admin/campaigns?q=acme&status=closed",
    );
    expect(listHref("/admin/campaigns", sp, { status: null })).toBe("/admin/campaigns?q=acme");
    expect(listHref("/admin/campaigns", sp, { page: 5 })).toBe("/admin/campaigns?q=acme&status=open&page=5");
    expect(listHref("/admin/campaigns", {}, { page: 1 })).toBe("/admin/campaigns");
  });

  it("flips the direction of the current sort and starts a new one in its default", () => {
    const current = { sort: "name" as const, dir: "asc" as const };
    expect(sortHref("/admin/campaigns", {}, LISTS.campaigns, current, "name")).toBe(
      "/admin/campaigns?sort=name&dir=desc",
    );
    expect(sortHref("/admin/campaigns", { page: "2" }, LISTS.campaigns, current, "createdAt")).toBe(
      "/admin/campaigns?sort=createdAt&dir=desc",
    );
  });
});

describe("staffApi list methods pass the list query through", () => {
  function recording(body: unknown): { transport: Transport; paths: string[] } {
    const paths: string[] = [];
    return {
      paths,
      transport: {
        fetch: (path) => {
          paths.push(path);
          return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
        },
      },
    };
  }

  it("sends q, sort, dir and filters, and keeps the old page-only calls working", async () => {
    const { transport, paths } = recording({ campaigns: [], total: 0, limit: 50, offset: 0 });
    const api = staffApi(transport);
    await api.campaigns.list({ limit: 50, offset: 0 });
    const q = listParams({ q: "pilot", sort: "name", status: "open" }, LISTS.campaigns).query;
    await api.campaigns.list(q);
    expect(paths[0]).toBe("/campaigns?limit=50&offset=0");
    expect(paths[1]).toBe("/campaigns?limit=50&offset=0&q=pilot&sort=name&status=open");
  });

  it("asks for a full window when a picker lists templates, and pages when the table does", async () => {
    const { transport, paths } = recording({ templates: [], total: 0, limit: 200, offset: 0 });
    const api = staffApi(transport);
    expect(await api.templates.list()).toEqual([]);
    const page = await api.templates.page({ q: "discovery", status: "published", limit: 20 });
    expect(page).toEqual({ items: [], total: 0, limit: 200, offset: 0 });
    expect(paths).toEqual(["/templates?limit=200", "/templates?q=discovery&status=published&limit=20"]);
  });
});
