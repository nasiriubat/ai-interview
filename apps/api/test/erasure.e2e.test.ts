import type { Server } from "node:http";
import { tenantTransaction, withTenant } from "@aidp/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeModelServer, parseSse, testWorld, TURN_MARKER, type TestWorld } from "./helpers.js";

const suite = process.env.DATABASE_URL ? describe : describe.skip;

/**
 * "Delete my data" over HTTP (S3, D-81, FR-13): the old token is dead everywhere, nothing can be
 * written afterwards, and the same person starting again gets a new, empty session. What is erased
 * is proven column by column in packages/core/test/erasure.integration.test.ts.
 */
suite("participant deletion over the API", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };

  beforeAll(async () => {
    model = await fakeModelServer(
      () =>
        `Thanks. What does a typical morning look like?\n${TURN_MARKER}\n${JSON.stringify({ areaKey: "daily" })}`,
    );
    world = await testWorld(model.url, { RATE_LIMIT_MAX: "100000", RATE_LIMIT_EXPENSIVE_MAX: "100000" });
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  const staff = () => ({ authorization: `Bearer ${world.adminToken}` });

  async function openCampaign(): Promise<{ campaignId: string; linkToken: string }> {
    const created = await world.app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: staff(),
      payload: { templateId: world.templateId, name: `Erasure ${Date.now()}` },
    });
    const { campaign, link } = created.json<{ campaign: { id: string }; link: { url: string } }>();
    await world.app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaign.id}/open`,
      headers: staff(),
    });
    return { campaignId: campaign.id, linkToken: link.url.split("/p/")[1]! };
  }

  async function verify(linkToken: string, email: string) {
    await world.app.inject({
      method: "POST",
      url: `/api/v1/p/${linkToken}/verify/request`,
      payload: { email },
    });
    const code = /is (\d{6})/.exec(world.email.sent.at(-1)?.text ?? "")?.[1];
    const res = await world.app.inject({
      method: "POST",
      url: `/api/v1/p/${linkToken}/verify/confirm`,
      payload: { email, code },
    });
    return res.json<{ participantToken: string; sessionId: string; resume: boolean }>();
  }

  it("kills the token on every participant route, refuses late writes, and lets the person start fresh", async () => {
    const { campaignId, linkToken } = await openCampaign();
    const email = `canary-${Date.now().toString(36)}@x.io`;
    const first = await verify(linkToken, email);
    const pt = { authorization: `Bearer pt.${first.participantToken}` };

    await world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/consent",
      headers: pt,
      payload: {
        consentVersion: "v1",
        participantFields: { name: `Eve ${email}`, role: "Nurse" },
        participationChoice: "identified",
      },
    });
    const turn = await world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/turns",
      headers: { ...pt, "content-type": "application/json" },
      payload: { content: `my address is ${email}`, modality: "text" },
    });
    expect(turn.statusCode).toBe(200);
    expect(parseSse(turn.body).some((e) => e.event === "turn")).toBe(true);
    expect(await world.db.participant.count({ where: { campaignId } })).toBe(1);

    const deleted = await world.app.inject({ method: "DELETE", url: "/api/v1/p/session", headers: pt });
    expect(deleted.statusCode).toBe(200);

    // The participant, its hash and its codes are gone.
    expect(await world.db.participant.count({ where: { campaignId } })).toBe(0);
    expect(await world.db.campaignEmailHash.count({ where: { campaignId } })).toBe(0);
    expect(await world.db.emailCode.count({ where: { campaignId } })).toBe(0);
    expect(await world.db.message.count({ where: { sessionId: first.sessionId } })).toBe(0);

    // The old token answers 401 on every participant route, including the ones that write.
    const routes = world.app.routeTable.filter(
      (r) => r.access === "participant" && !r.url.endsWith("/live") && r.method !== "HEAD",
    );
    expect(routes.length).toBeGreaterThanOrEqual(10);
    const stillOpen: string[] = [];
    for (const r of routes) {
      const res = await world.app.inject({
        method: r.method as "GET",
        url: r.url.replace(/:[A-Za-z]+/g, "x"),
        headers: pt,
        ...(r.method === "GET" || r.method === "DELETE" ? {} : { payload: {} }),
      });
      if (res.statusCode !== 401) stillOpen.push(`${r.method} ${r.url} -> ${res.statusCode}`);
    }
    expect(stillOpen).toEqual([]);

    // The summary in particular could be written after deletion before this change.
    const summary = await world.app.inject({
      method: "PUT",
      url: "/api/v1/p/session/summary",
      headers: pt,
      payload: { summary: "I am still here" },
    });
    expect(summary.statusCode).toBe(401);
    expect((await world.db.session.findUniqueOrThrow({ where: { id: first.sessionId } })).state).toEqual({});

    // The same address on an email-code campaign starts a new interview: the uniqueness hash was
    // erased with the rest, and keeping it would have kept personal data (D-81).
    const second = await verify(linkToken, email);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.resume).toBe(false);
    expect((await world.db.session.findUniqueOrThrow({ where: { id: first.sessionId } })).status).toBe(
      "deleted",
    );
  });

  it("refuses a job's late write to a session deleted while the job was running", async () => {
    const { linkToken } = await openCampaign();
    const grant = await verify(linkToken, `late-${Date.now().toString(36)}@x.io`);
    const pt = { authorization: `Bearer pt.${grant.participantToken}` };
    expect(
      (await world.app.inject({ method: "DELETE", url: "/api/v1/p/session", headers: pt })).statusCode,
    ).toBe(200);
    // What the extraction and summary jobs would do after their model call returns.
    // Inside the tenant's own scope and a transaction, as a job writes, so it is the trigger that
    // refuses and not row-level security.
    await expect(
      withTenant(world.companyId, () =>
        tenantTransaction(world.ctx.db, (tx) =>
          tx.fact.create({
            data: {
              companyId: world.companyId,
              sessionId: grant.sessionId,
              kind: "task",
              batchEndSeq: 1,
              ordinal: 0,
              payload: { kind: "task" },
              extractorVersion: "extraction@1",
            },
          }),
        ),
      ),
    ).rejects.toThrow(/session_deleted/);
    await expect(
      withTenant(world.companyId, () =>
        tenantTransaction(world.ctx.db, (tx) =>
          tx.session.update({ where: { id: grant.sessionId }, data: { summary: "late" } }),
        ),
      ),
    ).rejects.toThrow(/session_deleted/);
  });
});
