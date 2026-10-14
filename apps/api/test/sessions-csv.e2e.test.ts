import type { Server } from "node:http";
import { describeDb } from "@aidp/testing";
import { encode } from "@auth/core/jwt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { csvCell, csvFileName, toCsv } from "../src/modules/campaigns/csv.js";
import { fakeModelServer, testWorld, TEST_AUTH_SECRET, type TestWorld } from "./helpers.js";

describe("csv writing", () => {
  it("quotes commas, quotes and line breaks", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("one\ntwo")).toBe('"one\ntwo"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(3)).toBe("3");
    expect(csvCell(false)).toBe("false");
  });

  it("defuses a spreadsheet formula a stranger typed", () => {
    for (const bad of ["=HYPERLINK(1)", "+1", "-1", "@SUM(A1)", "\tx", "\rx"]) {
      expect(csvCell(bad).replace(/^"/, "")[0]).toBe("'");
    }
    // A number is a number, a negative one included.
    expect(csvCell(-1)).toBe("-1");
    expect(csvCell("plain")).toBe("plain");
  });

  it("writes a byte-order mark and CRLF lines", () => {
    const out = toCsv(["a", "b"], [[1, "x"]]);
    expect(out.charCodeAt(0)).toBe(0xfeff);
    expect(out.slice(1)).toBe("a,b\r\n1,x\r\n");
  });

  it("makes a safe ASCII file name from any campaign name", () => {
    expect(csvFileName("Q4 Näytös: Hoito/Osasto!", "sessions")).toBe("q4-naytos-hoito-osasto-sessions.csv");
    expect(csvFileName("日本語", "sessions")).toBe("campaign-sessions.csv");
    expect(csvFileName('"; rm -rf', "s")).toBe("rm-rf-s.csv");
  });
});

describeDb("campaign sessions CSV (D-236)", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };
  const admin = () => ({ authorization: `Bearer ${world.adminToken}` });

  beforeAll(async () => {
    model = await fakeModelServer(() => "ok");
    world = await testWorld(model.url);
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  async function campaign(mode: "identified" | "anonymous" | "participant_choice", name: string) {
    const res = await world.app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: admin(),
      payload: { templateId: world.templateId, name, participationMode: mode, verification: "open" },
    });
    return res.json<{ campaign: { id: string } }>().campaign.id;
  }

  async function session(
    campaignId: string,
    fields: Record<string, string>,
    over: { consented?: boolean; flagged?: boolean; status?: string } = {},
  ) {
    const p = await world.db.participant.create({
      data: {
        companyId: world.companyId,
        campaignId,
        fields,
        tokenHash: `h-${Math.random().toString(36).slice(2)}`,
      },
    });
    return world.db.session.create({
      data: {
        companyId: world.companyId,
        templateId: world.templateId,
        campaignId,
        participantId: p.id,
        status: over.status ?? "completed",
        consentedAt: over.consented ? new Date() : null,
        flagged: over.flagged ?? false,
        modePreference: "voice",
        state: { turnCount: 7, coverage: { a: { status: "covered" }, b: { status: "partial" } } },
        startedAt: new Date("2026-10-05T10:11:12Z"),
        endedAt: new Date("2026-10-05T10:41:12Z"),
      },
    });
  }

  const get = (id: string, headers = admin()) =>
    world.app.inject({ method: "GET", url: `/api/v1/campaigns/${id}/sessions.csv`, headers });
  const parse = (body: string): string[][] =>
    body
      .replace(/^\uFEFF/, "")
      .trimEnd()
      .split("\r\n")
      .map((l) => l.split(","));

  it("lists an identified campaign with names, emails and ids, and records the download", async () => {
    const id = await campaign("identified", "Ward round, Q4");
    const s = await session(id, { name: "Aino Virtanen", email: "aino@ward.test" }, { flagged: true });
    const res = await get(id);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="ward-round-q4-sessions.csv"');
    expect(res.headers["cache-control"]).toBe("no-store");
    const rows = parse(res.body);
    expect(rows[0]).toEqual([
      "row",
      "session_id",
      "participant_name",
      "participant_email",
      "status",
      "mode",
      "turns",
      "areas_covered",
      "flagged",
      "cost_cents",
      "started_at",
      "ended_at",
      "last_activity_at",
    ]);
    expect(rows[1]?.slice(0, 9)).toEqual([
      "1",
      s.id,
      "Aino Virtanen",
      "aino@ward.test",
      "completed",
      "voice",
      "7",
      "1",
      "true",
    ]);
    expect(rows[1]?.[10]).toBe("2026-10-05T10:11:12.000Z");

    const audit = await world.db.auditLog.findFirstOrThrow({
      where: { companyId: world.companyId, action: "campaign.sessions_export", targetId: id },
    });
    expect(audit.diff).toEqual({ rows: 1 });
    expect(JSON.stringify(audit.diff)).not.toContain("aino");
  });

  it("carries no identifier of an anonymous participant, and only the day", async () => {
    const id = await campaign("anonymous", "Anonymous round");
    const s = await session(id, { name: "Hidden Person", email: "hidden@ward.test" });
    const res = await get(id);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(s.id);
    expect(res.body).not.toContain("Hidden Person");
    expect(res.body).not.toContain("hidden@ward.test");
    expect(res.body).not.toContain("10:11:12");
    const row = parse(res.body)[1]!;
    expect(row[1]).toBe("");
    expect(row[2]).toBe("");
    expect(row[3]).toBe("");
    expect(row[10]).toBe("2026-10-05");
  });

  it("names only the participants who chose to be identified in a choice campaign", async () => {
    const id = await campaign("participant_choice", "Choice round");
    const named = await session(id, { name: "Open Person", email: "open@ward.test" }, { consented: true });
    const shy = await session(id, { name: "Shy Person", email: "shy@ward.test" }, { consented: false });
    const res = await get(id);
    expect(res.body).toContain("open@ward.test");
    expect(res.body).toContain(named.id);
    expect(res.body).not.toContain("shy@ward.test");
    expect(res.body).not.toContain("Shy Person");
    expect(res.body).not.toContain(shy.id);
    expect(parse(res.body)).toHaveLength(3);
  });

  it("neutralises a formula in a participant's name", async () => {
    const id = await campaign("identified", "Formula round");
    await session(id, { name: '=HYPERLINK("http://x")', email: "f@ward.test" });
    const res = await get(id);
    expect(res.body).toContain('"\'=HYPERLINK(""http://x"")"');
  });

  it("is for administrators in the same organization only", async () => {
    const id = await campaign("identified", "Guarded round");
    const email = `csv-member-${Date.now().toString(36)}@test.io`;
    await world.db.user.create({ data: { companyId: world.companyId, email, role: "member" } });
    const jwt = await encode({ token: { email }, secret: TEST_AUTH_SECRET, salt: "authjs.session-token" });
    expect((await get(id, { authorization: `Bearer ${jwt}` })).statusCode).toBe(403);
    expect((await get(id, {} as { authorization: string })).statusCode).toBe(401);

    const other = await world.db.company.create({
      data: { name: `Other ${Date.now()}`, monthlyBudgetCents: 100 },
    });
    const otherEmail = `csv-other-${Date.now().toString(36)}@test.io`;
    await world.db.user.create({ data: { companyId: other.id, email: otherEmail, role: "admin" } });
    const otherJwt = await encode({
      token: { email: otherEmail },
      secret: TEST_AUTH_SECRET,
      salt: "authjs.session-token",
    });
    expect((await get(id, { authorization: `Bearer ${otherJwt}` })).statusCode).toBe(404);
  });

  it("answers a campaign with no sessions with the header alone", async () => {
    const id = await campaign("identified", "Empty round");
    const res = await get(id);
    expect(parse(res.body)).toHaveLength(1);
  });
});
