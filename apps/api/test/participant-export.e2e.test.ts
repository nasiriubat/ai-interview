import type { Server } from "node:http";
import { describeDb } from "@aidp/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fakeModelServer, testWorld, type TestWorld } from "./helpers.js";

/**
 * "Download my data" (D-162): the participant's own session, through the participant guard only.
 */
describeDb("participant data export", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };

  beforeAll(async () => {
    model = await fakeModelServer(() => "x");
    world = await testWorld(model.url, { RATE_LIMIT_MAX: "100000" });
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  async function participant(): Promise<{ token: string; sessionId: string }> {
    const staff = { authorization: `Bearer ${world.adminToken}` };
    const created = await world.app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: staff,
      payload: { templateId: world.templateId, name: `Export ${Math.random()}`, verification: "open" },
    });
    const { campaign, link } = created.json<{ campaign: { id: string }; link: { url: string } }>();
    await world.app.inject({ method: "POST", url: `/api/v1/campaigns/${campaign.id}/open`, headers: staff });
    const opened = await world.app.inject({
      method: "POST",
      url: `/api/v1/p/${link.url.split("/p/")[1]}/open`,
      payload: {},
    });
    const token = `Bearer pt.${opened.json<{ participantToken: string }>().participantToken}`;
    await world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/consent",
      headers: { authorization: token },
      payload: { consentVersion: "v1", participationChoice: "anonymous" },
    });
    const view = await world.app.inject({
      method: "GET",
      url: "/api/v1/p/session",
      headers: { authorization: token },
    });
    return { token, sessionId: view.json<{ session: { id: string } }>().session.id };
  }

  async function say(sessionId: string, seq: number, role: "user" | "assistant", content: string) {
    await world.db.message.create({ data: { companyId: world.companyId, sessionId, seq, role, content } });
  }

  const get = (token: string, format?: string) =>
    world.app.inject({
      method: "GET",
      url: `/api/v1/p/session/export${format ? `?format=${format}` : ""}`,
      headers: { authorization: token },
    });

  it("gives the participant their own answers, consent and files as JSON, as a download", async () => {
    const me = await participant();
    await say(me.sessionId, 1, "assistant", "What takes the most time?");
    await say(me.sessionId, 2, "user", "Retyping referrals, the fax-to-sheet-step-9137");
    await world.db.attachment.create({
      data: {
        companyId: world.companyId,
        sessionId: me.sessionId,
        kind: "document",
        filename: "rota-9137.pdf",
        mime: "application/pdf",
        sizeBytes: 100,
        storageKey: "",
        summary: "A rota",
      },
    });

    const res = await get(me.token);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="my-interview-data\.json"/);
    expect(res.headers["cache-control"]).toMatch(/no-store/);
    const body = res.json();
    expect(body.exportVersion).toBe(1);
    expect(body.consent.version).toBe("v1");
    expect(body.transcript.map((m: { content: string }) => m.content)).toContain(
      "Retyping referrals, the fax-to-sheet-step-9137",
    );
    expect(body.files[0]).toMatchObject({ filename: "rota-9137.pdf", summary: "A rota" });
    // Derived aggregates and the engine's internals are not part of a person's copy.
    expect(Object.keys(body)).not.toEqual(expect.arrayContaining(["opportunities", "reports", "analysis"]));
  });

  it("renders Markdown on request", async () => {
    const me = await participant();
    await say(me.sessionId, 1, "user", "We re-enter everything twice, step-4417");
    const res = await get(me.token, "md");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/markdown/);
    expect(res.body).toContain("# Your data from the interview");
    expect(res.body).toContain("step-4417");
  });

  it("is only the caller's own session, and refuses everyone else", async () => {
    const a = await participant();
    const b = await participant();
    await say(a.sessionId, 1, "user", "secret-of-a-5521");
    await say(b.sessionId, 1, "user", "secret-of-b-7788");

    const forB = await get(b.token);
    expect(forB.body).toContain("secret-of-b-7788");
    expect(forB.body).not.toContain("secret-of-a-5521");

    expect((await world.app.inject({ method: "GET", url: "/api/v1/p/session/export" })).statusCode).toBe(401);
    const staff = await world.app.inject({
      method: "GET",
      url: "/api/v1/p/session/export",
      headers: { authorization: `Bearer ${world.adminToken}` },
    });
    expect(staff.statusCode).toBe(401);
  });

  it("leaves an audit row that names the session and nothing about the person", async () => {
    const me = await participant();
    await say(me.sessionId, 1, "user", "private-words-3301");
    await get(me.token);
    const row = await world.db.auditLog.findFirstOrThrow({
      where: { companyId: world.companyId, action: "privacy.participant_export", targetId: me.sessionId },
    });
    expect(row.actorId).toBeNull();
    expect(JSON.stringify(row)).not.toContain("private-words-3301");
  });

  it("is rate limited to three an hour", async () => {
    const me = await participant();
    for (let i = 0; i < 3; i++) expect((await get(me.token)).statusCode).toBe(200);
    expect((await get(me.token)).statusCode).toBe(429);
  });

  it("is gone once the participant has deleted their data", async () => {
    const me = await participant();
    const del = await world.app.inject({
      method: "DELETE",
      url: "/api/v1/p/session",
      headers: { authorization: me.token },
    });
    expect(del.statusCode).toBe(200);
    expect([401, 404]).toContain((await get(me.token)).statusCode);
  });
});
