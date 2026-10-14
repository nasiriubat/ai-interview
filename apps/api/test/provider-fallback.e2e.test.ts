import { createServer, type Server } from "node:http";
import { PromMetrics } from "@aidp/core";
import { describeDb } from "@aidp/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fakeModelServer, parseSse, testWorld, TURN_MARKER, type TestWorld } from "./helpers.js";

const suite = describeDb;

// One attempt per call: the breaker is under test, not the adapter's own retry loop.
process.env.PROVIDER_MAX_RETRIES = "0";

/**
 * A provider that is down, a fallback route that is not, and the breaker between them (D-228,
 * operations 8.3 "provider returns 5xx"): the interview continues on the fallback, the ledger says
 * so, the operator is told once, and after enough failures the failing provider is not asked at all.
 */
suite("provider outage: circuit breaker and fallback route", () => {
  let world: TestWorld;
  let good: { server: Server; url: string; requests: unknown[] };
  let broken: Server;
  let brokenUrl = "";
  let brokenHits = 0;
  let primaryId = "";
  let backupId = "";
  const metrics = new PromMetrics();
  const reply = `Thanks. What happens next?\n${TURN_MARKER}\n${JSON.stringify({ areaKey: "daily" })}`;

  beforeAll(async () => {
    good = await fakeModelServer(() => reply);
    broken = createServer((_req, res) => {
      brokenHits++;
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "overloaded" } }));
    });
    await new Promise<void>((r) => broken.listen(0, "127.0.0.1", r));
    const addr = broken.address();
    brokenUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/v1`;

    world = await testWorld(good.url, { RATE_LIMIT_MAX: "100000", RATE_LIMIT_EXPENSIVE_MAX: "100000" }, {});
    // The suite is about providers, not about how many campaigns a tenant may open.
    await world.db.setting.create({
      data: {
        scope: "tenant",
        scopeId: world.companyId,
        companyId: world.companyId,
        key: "ceiling.maxActiveCampaigns",
        value: 0,
      },
    });
    backupId = (await world.db.provider.findFirstOrThrow({ where: { companyId: world.companyId } })).id;
    const primary = await world.db.provider.create({
      data: {
        companyId: world.companyId,
        kind: "openai_compatible",
        name: "primary (down)",
        baseUrl: brokenUrl,
        apiKeyEnc: world.crypto.encrypt("k", "provider.apiKey"),
        headers: {},
      },
    });
    primaryId = primary.id;
    await world.db.modelPrice.create({
      data: {
        providerId: primaryId,
        model: "fake-model",
        inputPerMtok: 1,
        cachedInputPerMtok: 0.1,
        outputPerMtok: 2,
        source: "admin",
      },
    });
    await world.db.route.updateMany({
      where: { companyId: world.companyId, purpose: "interview_turn" },
      data: { providerId: primaryId },
    });
    await world.db.fallbackRoute.create({
      data: {
        companyId: world.companyId,
        purpose: "interview_turn",
        providerId: backupId,
        model: "fake-model",
        maxOutputTokens: 800,
      },
    });
  });
  afterAll(async () => {
    await world.close();
    good.server.close();
    broken.close();
  });

  async function firstTurn(): Promise<{ events: ReturnType<typeof parseSse>; sessionId: string }> {
    const staff = { authorization: `Bearer ${world.adminToken}` };
    const created = await world.app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: staff,
      payload: { templateId: world.templateId, name: `Outage ${Math.random()}`, verification: "open" },
    });
    const { campaign, link } = created.json();
    await world.app.inject({ method: "POST", url: `/api/v1/campaigns/${campaign.id}/open`, headers: staff });
    const opened = await world.app.inject({
      method: "POST",
      url: `/api/v1/p/${link.url.split("/p/")[1]}/open`,
      payload: {},
    });
    const grant = opened.json();
    const auth = { authorization: `Bearer pt.${grant.participantToken}` };
    await world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/consent",
      headers: auth,
      payload: { consentVersion: "v1", participationChoice: "anonymous" },
    });
    const res = await world.app.inject({ method: "POST", url: "/api/v1/p/session/turns", headers: auth });
    return { events: parseSse(res.body), sessionId: grant.sessionId };
  }

  it("serves the turn from the fallback route, records both attempts, and tells the operator once", async () => {
    const { events, sessionId } = await firstTurn();
    expect(events.some((e) => e.event === "turn")).toBe(true);
    expect(events.some((e) => e.event === "error")).toBe(false);

    const rows = await world.db.llmCall.findMany({
      where: { sessionId, purpose: "interview_turn" },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.map((r) => [r.providerId, r.status, r.routeTier])).toEqual([
      [primaryId, "error", "primary"],
      [backupId, "ok", "fallback"],
    ]);
    // The streamed fallback reports when its first token arrived.
    expect(rows[1]?.firstTokenMs).not.toBeNull();

    const raised = world.alerts.ofKind("provider.fallback_active");
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({
      key: `provider.fallback_active:${primaryId}`,
      audience: ["operator"],
      context: { purpose: "interview_turn", from: primaryId, to: backupId, reason: "error" },
    });
  });

  it("opens the circuit after repeated failures, so the failing provider is not asked at all", async () => {
    // Four more failures on top of the first make five: the breaker's threshold.
    for (let i = 0; i < 4; i++) await firstTurn();
    expect(world.ctx.callers.breaker.state(primaryId)).toBe("open");
    expect(
      world.alerts.ofKind("provider.error_rate").some((a) => a.key === `provider.circuit:${primaryId}`),
    ).toBe(true);

    const hits = brokenHits;
    const { events } = await firstTurn();
    expect(events.some((e) => e.event === "turn")).toBe(true);
    expect(brokenHits).toBe(hits);

    // The operator's page shows the open circuit against the provider it belongs to.
    const health = await world.app.inject({
      method: "GET",
      url: "/api/v1/operator/health",
      headers: { authorization: `Bearer ${world.operatorToken}` },
    });
    const body = health.json<{ signals: { key: string; status: string }[] }>();
    expect(body.signals.find((s) => s.key === "provider.error_rate")?.status).toBe("critical");
    metrics;
  });

  it("closes the circuit again when the half-open probe succeeds", async () => {
    // The provider recovers: route the primary at the good server and let the open period pass.
    await world.db.provider.update({ where: { id: primaryId }, data: { baseUrl: good.url } });
    world.ctx.callers.invalidateProvider(primaryId);
    const breaker = world.ctx.callers.breaker as unknown as { circuits: Map<string, { openedAt: number }> };
    const circuit = breaker.circuits.get(primaryId);
    if (circuit) circuit.openedAt -= 60_000;

    const { events, sessionId } = await firstTurn();
    expect(events.some((e) => e.event === "turn")).toBe(true);
    const rows = await world.db.llmCall.findMany({ where: { sessionId, purpose: "interview_turn" } });
    expect(rows.map((r) => [r.providerId, r.routeTier])).toEqual([[primaryId, "primary"]]);
    expect(world.ctx.callers.breaker.state(primaryId)).toBe("closed");
    // The fallback notice is resolved with the circuit.
    expect(world.alerts.resolved).toContain(`provider.fallback_active:${primaryId}`);
  });
});
