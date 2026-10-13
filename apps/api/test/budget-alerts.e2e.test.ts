import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { budgetPausedMessage } from "../src/modules/sessions/turn-runner.js";
import { fakeModelServer, parseSse, testWorld, TURN_MARKER, type TestWorld } from "./helpers.js";

const suite = process.env.DATABASE_URL ? describe : describe.skip;

/**
 * A budget that runs out is a tenant's money and a participant's interview, so it must reach a
 * person and the participant must be told the truth about it (D-90). These drive the real turn
 * endpoint with a real `CallerFactory`; only the alert port and the model server are fakes.
 */
suite("budget alerts end to end", () => {
  let world: TestWorld;
  let model: { server: Server; url: string };

  beforeAll(async () => {
    model = await fakeModelServer(
      () => `Thanks. What is your role?\n${TURN_MARKER}\n${JSON.stringify({ areaKey: "role" })}`,
    );
    world = await testWorld(model.url);
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  const staff = (token: string) => ({ authorization: `Bearer ${token}` });

  /** A consented participant with a session, ready to take a turn. */
  async function participant(name: string): Promise<{ pt: { authorization: string }; sessionId: string }> {
    const { app, adminToken } = world;
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: staff(adminToken),
      payload: { templateId: world.templateId, name },
    });
    const { campaign, link } = created.json<{ campaign: { id: string }; link: { url: string } }>();
    const linkToken = link.url.split("/p/")[1]!;
    await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaign.id}/open`,
      headers: staff(adminToken),
    });
    const email = `${name.replace(/\W/g, "").toLowerCase()}@hospital.test`;
    await app.inject({ method: "POST", url: `/api/v1/p/${linkToken}/verify/request`, payload: { email } });
    const code = /is (\d{6})/.exec(world.email.sent.at(-1)?.text ?? "")?.[1];
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/v1/p/${linkToken}/verify/confirm`,
      payload: { email, code },
    });
    const { participantToken, sessionId } = confirmed.json<{ participantToken: string; sessionId: string }>();
    const pt = { authorization: `Bearer pt.${participantToken}` };
    await app.inject({
      method: "POST",
      url: "/api/v1/p/session/consent",
      headers: pt,
      payload: {
        consentVersion: "v1",
        participantFields: { role: "Nurse" },
        participationChoice: "anonymous",
      },
    });
    return { pt, sessionId };
  }

  const setTenantLimit = (limitCents: number) =>
    world.db.budget.updateMany({
      where: { scope: "tenant", scopeId: world.companyId },
      data: { limitCents },
    });

  async function turnError(pt: { authorization: string }): Promise<{ code: string; message: string }> {
    const res = await world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/turns",
      headers: { ...pt, "content-type": "application/json" },
    });
    const err = parseSse(res.body).find((e) => e.event === "error");
    return (err?.data as { code: string; message: string }) ?? { code: "none", message: "" };
  }

  // First on purpose: a delivered exhaustion is remembered for a minute so a participant pressing
  // send on a paused interview does not re-query, which would otherwise answer this test's call.
  it("does not claim the organizer was notified when nobody could be", async () => {
    const { pt } = await participant("Unreachable");
    world.alerts.raised.length = 0;
    world.alerts.result = { delivered: false, suppressed: null };
    try {
      await setTenantLimit(0);
      const error = await turnError(pt);
      expect(error.code).toBe("budget_exceeded");
      expect(error.message).toBe(budgetPausedMessage(false));
      expect(error.message).not.toContain("has been notified");
      expect(error.message).toContain("contact the organizer");
    } finally {
      world.alerts.result = { delivered: true, suppressed: null };
      await setTenantLimit(100_000);
    }
  });

  it("raises budget.exceeded once the budget is used up, pauses the session and tells the truth", async () => {
    const { pt, sessionId } = await participant("Exhausted");
    world.alerts.raised.length = 0;
    try {
      await setTenantLimit(0);
      const error = await turnError(pt);

      expect(error.code).toBe("budget_exceeded");
      const raised = world.alerts.ofKind("budget.exceeded");
      expect(raised).toHaveLength(1);
      expect(raised[0]).toMatchObject({
        companyId: world.companyId,
        key: expect.stringMatching(new RegExp(`^budget\\.exceeded:tenant:${world.companyId}:\\d{4}-\\d{2}$`)),
      });
      expect(raised[0]?.title).toContain("workspace");
      // The alert said it was delivered, so this is the version that claims someone was told.
      expect(error.message).toBe(budgetPausedMessage(true));
      expect(error.message).toContain("organizer has been notified");

      const session = await world.db.session.findUniqueOrThrow({ where: { id: sessionId } });
      expect(session.status).toBe("paused");
    } finally {
      await setTenantLimit(100_000);
    }
  });

  it("raises budget.warning for the tenant when a call lands past the threshold", async () => {
    const { pt } = await participant("Warned");
    world.alerts.raised.length = 0;
    const provider = await world.db.provider.findFirstOrThrow({ where: { companyId: world.companyId } });
    // 85 of a 100 cent budget already spent this month: the next turn is the one that crosses 80%.
    const spend = await world.db.llmCall.create({
      data: {
        companyId: world.companyId,
        purpose: "interview_turn",
        providerId: provider.id,
        model: "fake-model",
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
        status: "ok",
        costCents: 85,
      },
    });
    try {
      await setTenantLimit(100);
      const res = await world.app.inject({
        method: "POST",
        url: "/api/v1/p/session/turns",
        headers: { ...pt, "content-type": "application/json" },
      });
      expect(res.statusCode).toBe(200);
      for (let i = 0; i < 40 && world.alerts.ofKind("budget.warning").length === 0; i++)
        await new Promise((r) => setTimeout(r, 50));
      const warnings = world.alerts.ofKind("budget.warning");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({ companyId: world.companyId });
      expect(warnings[0]?.key).toMatch(/:80$/);
      expect(warnings[0]?.message).toMatch(/at 85%/);
    } finally {
      await world.db.llmCall.delete({ where: { id: spend.id } });
      await setTenantLimit(100_000);
    }
  });
});
