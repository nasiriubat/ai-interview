import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeModelServer, testWorld, type TestWorld } from "./helpers.js";

const suite = process.env.DATABASE_URL ? describe : describe.skip;

/**
 * Abuse controls for open links (A1, D-261). A link anyone can open creates a participant and a
 * session per request, and the code endpoint sends mail to any address it is given. These tests
 * run the real routes, the real counters in Postgres and the alert port, and check the three
 * things the plan promises: one attacker cannot degrade someone else's flow, a campaign cap is a
 * 429 that raises `abuse.limit_hit`, and a refused code request is indistinguishable from a sent one.
 */
suite("abuse controls on open links", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };
  const staff = () => ({ authorization: `Bearer ${world.adminToken}` });

  beforeAll(async () => {
    model = await fakeModelServer(() => "x");
    world = await testWorld(model.url, { RATE_LIMIT_MAX: "100000" });
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  const createCampaign = async (
    verification: "open" | "email_code",
    name: string,
  ): Promise<{ id: string; token: string }> => {
    const created = await world.app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: staff(),
      payload: { templateId: world.templateId, name, verification },
    });
    const body = created.json<{ campaign: { id: string }; link: { url: string } }>();
    await world.app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${body.campaign.id}/open`,
      headers: staff(),
    });
    return { id: body.campaign.id, token: body.link.url.split("/p/")[1]! };
  };

  const setting = async (scope: "tenant" | "campaign", scopeId: string, values: Record<string, number>) => {
    const res = await world.app.inject({
      method: "PUT",
      url: `/api/v1/settings?scope=${scope}${scope === "campaign" ? `&scopeId=${scopeId}` : ""}`,
      headers: staff(),
      payload: { values },
    });
    expect(res.statusCode).toBe(200);
  };

  const open = (token: string, ip: string) =>
    world.app.inject({
      method: "POST",
      url: `/api/v1/p/${token}/open`,
      headers: { "x-forwarded-for": ip },
      payload: {},
    });

  it("lets one attacker at 1000 requests a minute exhaust only their own bucket", async () => {
    const c = await createCampaign("open", "Flood");
    const attacker = "203.0.113.66";
    const statuses = new Map<number, number>();
    for (let i = 0; i < 1000; i++) {
      const res = await open(c.token, attacker);
      statuses.set(res.statusCode, (statuses.get(res.statusCode) ?? 0) + 1);
    }
    // The route's own bucket is 120 a minute per address (RATE_LIMIT_PUBLIC_MAX, D-310):
    // everything beyond it is refused cheaply.
    expect(statuses.get(200) ?? 0).toBeLessThanOrEqual(120);
    expect(statuses.get(429) ?? 0).toBeGreaterThanOrEqual(880);

    // Somebody else, behind a different address, is not affected at all.
    const bystander = await open(c.token, "198.51.100.7");
    expect(bystander.statusCode).toBe(200);
    expect(bystander.json<{ sessionId: string }>().sessionId).toBeTruthy();
  });

  it("does not turn away an office: fifty colleagues behind one address open the link in a minute (D-310)", async () => {
    const c = await createCampaign("open", "Office");
    const office = "203.0.113.210";
    const codes: number[] = [];
    // A browser lands on the link, then opens it: two requests on the per-address bucket each.
    for (let i = 0; i < 50; i++) {
      const landing = await world.app.inject({
        method: "GET",
        url: `/api/v1/p/${c.token}`,
        headers: { "x-forwarded-for": office },
      });
      codes.push(landing.statusCode, (await open(c.token, office)).statusCode);
    }
    expect(codes.every((code) => code === 200)).toBe(true);
  });

  it("refuses new interviews past the campaign's hourly cap with a 429 and raises abuse.limit_hit", async () => {
    const c = await createCampaign("open", "Capped");
    await setting("campaign", c.id, { "abuse.campaignSessionsPerHour": 4 });
    world.alerts.raised.length = 0;

    const codes: number[] = [];
    // A different address each time: only the campaign bucket can be what stops this.
    for (let i = 0; i < 7; i++) codes.push((await open(c.token, `192.0.2.${10 + i}`)).statusCode);
    expect(codes.slice(0, 4)).toEqual([200, 200, 200, 200]);
    expect(codes.slice(4)).toEqual([429, 429, 429]);

    const raised = world.alerts.ofKind("abuse.limit_hit");
    expect(raised.length).toBeGreaterThanOrEqual(1);
    expect(raised[0]).toMatchObject({
      companyId: world.companyId,
      context: { campaignId: c.id, limit: "campaign_hour" },
    });
    // Ids only: nothing in the alert names a person or an address.
    expect(JSON.stringify(raised)).not.toMatch(/192\.0\.2\./);

    // The message to the visitor names no limit.
    const refused = await open(c.token, "192.0.2.99");
    expect(refused.statusCode).toBe(429);
    expect(refused.body).not.toMatch(/campaign_hour|abuse/);

    // The window passes: the counter row ages out and the link works again.
    await world.db.usageCounter.updateMany({
      where: { key: `session:campaign:${c.id}` },
      data: { windowStart: new Date(Date.now() - 3 * 3_600_000) },
    });
    expect((await open(c.token, "192.0.2.100")).statusCode).toBe(200);
  });

  it("stops a campaign at its total, counted from the sessions that exist", async () => {
    const c = await createCampaign("open", "Total");
    await setting("campaign", c.id, { "abuse.campaignSessionsTotal": 3 });
    world.alerts.raised.length = 0;
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await open(c.token, `192.0.2.${120 + i}`)).statusCode);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    expect(world.alerts.ofKind("abuse.limit_hit")[0]?.context).toMatchObject({ limit: "campaign_total" });
  });

  it("stops the tenant's hourly bucket across campaigns", async () => {
    const a = await createCampaign("open", "Tenant A");
    const b = await createCampaign("open", "Tenant B");
    const before = await world.db.usageCounter.findMany({
      where: {
        companyId: world.companyId,
        key: "session:tenant",
        windowStart: { gte: new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000) },
      },
    });
    const used = before.reduce((n, r) => n + r.count, 0);
    await setting("tenant", "", { "abuse.tenantSessionsPerHour": used + 3 });
    const codes = [
      (await open(a.token, "192.0.2.150")).statusCode,
      (await open(b.token, "192.0.2.151")).statusCode,
      (await open(a.token, "192.0.2.152")).statusCode,
      (await open(b.token, "192.0.2.153")).statusCode,
    ];
    expect(codes).toEqual([200, 200, 200, 429]);
    await setting("tenant", "", { "abuse.tenantSessionsPerHour": 1000 });
  });

  describe("code requests", () => {
    it("caps the distinct addresses one client may ask codes for, and answers the same", async () => {
      const c = await createCampaign("email_code", "Bomb");
      // The route allows five requests in ten minutes from one address; this cap is the tighter
      // question of how many different people they may be about.
      await setting("tenant", "", { "abuse.distinctEmailsPerAddressPerHour": 2 });
      const attacker = "203.0.113.200";
      const answers: string[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await world.app.inject({
          method: "POST",
          url: `/api/v1/p/${c.token}/verify/request`,
          headers: { "x-forwarded-for": attacker },
          payload: { email: `victim${i}@bomb.test` },
        });
        expect(res.statusCode).toBe(200);
        answers.push(res.body);
      }
      const sent = world.email.sent.filter((m) => m.to.endsWith("@bomb.test"));
      expect(sent).toHaveLength(2);
      expect(new Set(answers).size).toBe(1);

      // A real person on another connection is not behind the attacker's cap.
      await world.app.inject({
        method: "POST",
        url: `/api/v1/p/${c.token}/verify/request`,
        headers: { "x-forwarded-for": "198.51.100.77" },
        payload: { email: "honest@bomb.test" },
      });
      expect(world.email.sent.filter((m) => m.to === "honest@bomb.test")).toHaveLength(1);

      const limited = world.alerts
        .ofKind("abuse.limit_hit")
        .filter((a) => a.context?.limit === "address_emails");
      expect(limited.length).toBeGreaterThanOrEqual(1);
      await setting("tenant", "", { "abuse.distinctEmailsPerAddressPerHour": 5 });
    });

    it("keeps no client address in the counters", async () => {
      const rows = await world.db.usageCounter.findMany({ select: { key: true } });
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.key).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
        expect(r.key).not.toContain("@");
      }
    });
  });

  it("survives an application rebuild: the counters are in the database, not in memory", async () => {
    const c = await createCampaign("open", "Rebuild");
    await setting("campaign", c.id, { "abuse.campaignSessionsPerHour": 2 });
    expect((await open(c.token, "192.0.2.170")).statusCode).toBe(200);
    expect((await open(c.token, "192.0.2.171")).statusCode).toBe(200);

    const second = await testWorld(model.url, { RATE_LIMIT_MAX: "100000" });
    try {
      const res = await second.app.inject({
        method: "POST",
        url: `/api/v1/p/${c.token}/open`,
        headers: { "x-forwarded-for": "192.0.2.172" },
        payload: {},
      });
      // A fresh application over the same database refuses at once: the bucket was never in
      // this process's memory.
      expect(res.statusCode).toBe(429);
    } finally {
      await second.close();
    }
    const row = await world.db.usageCounter.findFirst({ where: { key: `session:campaign:${c.id}` } });
    // Two interviews, and the refused attempt from the second application counted as well.
    expect(row?.count).toBeGreaterThanOrEqual(2);
    expect((await open(c.token, "192.0.2.173")).statusCode).toBe(429);
  });
});
