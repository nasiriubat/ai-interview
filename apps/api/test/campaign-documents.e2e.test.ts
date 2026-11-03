import type { Server } from "node:http";
import { describeDb } from "@aidp/testing";
import { encode } from "@auth/core/jwt";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fakeModelServer, testWorld, TURN_MARKER, type TestWorld } from "./helpers.js";

/**
 * A campaign's background documents (D-491) through the real HTTP surface: an administrator adds
 * them with the same checks as any upload, staff can see them, a member cannot change them, and
 * participants are told when the interviewer was given background material.
 */
describeDb("campaign background documents", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };
  let memberToken: string;
  const reply = `What happens next?\n${TURN_MARKER}\n${JSON.stringify({ areaKey: "daily" })}`;

  beforeAll(async () => {
    model = await fakeModelServer(() => reply);
    world = await testWorld(model.url);
    const email = `member-${Date.now().toString(36)}@test.io`;
    await world.db.user.create({ data: { companyId: world.companyId, email, role: "member" } });
    memberToken = await encode({
      token: { email },
      secret: world.ctx.config.AUTH_SECRET,
      salt: "authjs.session-token",
    });
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  const boundary = "----campaigndocs";
  const file = (name: string, type: string, body: string) => ({
    payload: Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n${body}\r\n--${boundary}--\r\n`,
    ),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  });

  async function campaign(): Promise<{ id: string; linkToken: string }> {
    const staff = { authorization: `Bearer ${world.adminToken}` };
    const created = await world.app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: staff,
      payload: {
        templateId: world.templateId,
        name: `Docs ${Math.random().toString(36).slice(2)}`,
        verification: "open",
      },
    });
    const { campaign: c, link } = created.json<{ campaign: { id: string }; link: { url: string } }>();
    await world.app.inject({ method: "POST", url: `/api/v1/campaigns/${c.id}/open`, headers: staff });
    return { id: c.id, linkToken: link.url.split("/p/")[1] ?? "" };
  }

  it("is added by an administrator with the usual checks, audited, listed with the limits, and removed", async () => {
    const { app, adminToken, db, companyId } = world;
    const h = { authorization: `Bearer ${adminToken}` };
    const { id } = await campaign();

    const org = file(
      "org-chart.md",
      "text/markdown",
      "# Ward\nCharge nurse leads each shift; notes are kept in TMS.",
    );
    const up = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${id}/documents`,
      headers: { ...h, ...org.headers },
      payload: org.payload,
    });
    expect(up.statusCode).toBe(200);
    const doc = up.json<{ document: { id: string; status: string; filename: string } }>().document;
    expect(doc).toMatchObject({ filename: "org-chart.md", status: "pending" });
    expect(world.jobs.published.map((j) => j.name)).toContain("campaign-document.ingest");
    expect(
      await db.auditLog.count({ where: { companyId, action: "campaign.document.add", targetId: id } }),
    ).toBe(1);

    const listed = await app.inject({ method: "GET", url: `/api/v1/campaigns/${id}/documents`, headers: h });
    expect(listed.json()).toMatchObject({
      documents: [{ id: doc.id }],
      uploads: { maxDocuments: 10, maxSizeMb: expect.any(Number) },
    });

    // The same content check as any upload: a file that is not what it claims is refused.
    const fake = file("plan.pdf", "application/pdf", "not a pdf");
    const refused = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${id}/documents`,
      headers: { ...h, ...fake.headers },
      payload: fake.payload,
    });
    expect(refused.statusCode).toBe(400);

    // Members see which documents a campaign carries, and cannot change them.
    const m = { authorization: `Bearer ${memberToken}` };
    expect(
      (await app.inject({ method: "GET", url: `/api/v1/campaigns/${id}/documents`, headers: m })).statusCode,
    ).toBe(200);
    const memberUpload = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${id}/documents`,
      headers: { ...m, ...org.headers },
      payload: org.payload,
    });
    expect(memberUpload.statusCode).toBe(403);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/campaigns/${id}/documents/${doc.id}`,
      headers: h,
    });
    expect(removed.statusCode).toBe(200);
    expect(await db.campaignDocument.count({ where: { campaignId: id } })).toBe(0);
    expect(
      await db.auditLog.count({ where: { companyId, action: "campaign.document.remove", targetId: id } }),
    ).toBe(1);
  });

  it("tells a participant once the interviewer has background material, and gives it the summary", async () => {
    const { app, adminToken, db } = world;
    const { id, linkToken } = await campaign();
    const opened = await app.inject({ method: "POST", url: `/api/v1/p/${linkToken}/open`, payload: {} });
    const token = `Bearer pt.${opened.json<{ participantToken: string }>().participantToken}`;
    await app.inject({
      method: "POST",
      url: "/api/v1/p/session/consent",
      headers: { authorization: token },
      payload: { consentVersion: "v1", participationChoice: "anonymous" },
    });
    const before = await app.inject({
      method: "GET",
      url: "/api/v1/p/session",
      headers: { authorization: token },
    });
    expect(before.json().session.about.backgroundShared).toBe(false);

    const org = file("tools.md", "text/markdown", "We use TMS for transport and Excel for rosters.");
    const up = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${id}/documents`,
      headers: { authorization: `Bearer ${adminToken}`, ...org.headers },
      payload: org.payload,
    });
    const docId = up.json<{ document: { id: string } }>().document.id;
    // The ingest job would write these; the read path is what is under test here.
    await db.campaignDocument.update({
      where: { id: docId },
      data: { status: "ready", summary: "Transport runs in TMS; rosters in Excel.", extractedText: "x" },
    });

    const after = await app.inject({
      method: "GET",
      url: "/api/v1/p/session",
      headers: { authorization: token },
    });
    expect(after.json().session.about.backgroundShared).toBe(true);

    // The first turn carries the summary as background, inside the session state block.
    await app.inject({ method: "POST", url: "/api/v1/p/session/turns", headers: { authorization: token } });
    const last = JSON.stringify(model.requests.at(-1));
    expect(last).toContain("Background the organisation shared for this interview round");
    expect(last).toContain("Transport runs in TMS; rosters in Excel.");
  });
});
