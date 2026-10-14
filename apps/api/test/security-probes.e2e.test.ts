import type { Server } from "node:http";
import { shippedTemplates } from "@aidp/db";
import { encode } from "@auth/core/jwt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeModelServer, TEST_AUTH_SECRET, testWorld, type TestWorld } from "./helpers.js";

const suite = process.env.DATABASE_URL ? describe : describe.skip;

/**
 * Ad hoc security probes of Security M3 (docs/team/security-verification-2026-10.md). Written to try
 * to break things the committed suites do not. Each `it` states the attack; an assertion that
 * fails is a finding.
 */
suite("security probes", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };
  const as = (token: string, extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${token}`,
    ...extra,
  });
  const jwt = (email: string, secret = TEST_AUTH_SECRET) =>
    encode({ token: { email }, secret, salt: "authjs.session-token" });
  let memberToken = "";
  let bAdminToken = "";
  let bCampaign = "";
  let aCampaign = "";
  let aLink = "";
  let aInvitation = "";

  beforeAll(async () => {
    model = await fakeModelServer(() => "x");
    world = await testWorld(model.url, { RATE_LIMIT_MAX: "100000", RATE_LIMIT_EXPENSIVE_MAX: "100000" });
    const suffix = Date.now().toString(36);
    const memberEmail = `probe-member-${suffix}@test.io`;
    await world.db.user.create({ data: { companyId: world.companyId, email: memberEmail, role: "member" } });
    memberToken = await jwt(memberEmail);
    const b = await world.db.company.create({
      data: { name: `Probe B ${suffix}`, monthlyBudgetCents: 1000 },
    });
    const bEmail = `probe-b-${suffix}@test.io`;
    await world.db.user.create({ data: { companyId: b.id, email: bEmail, role: "admin" } });
    bAdminToken = await jwt(bEmail);
    // Tenant B needs a published template to make a campaign of its own: the shipped one, as its own.
    const { version: _version, ...templateBody } = shippedTemplates()[0]!;
    const copy = await world.app.inject({
      method: "POST",
      url: "/api/v1/templates",
      headers: as(bAdminToken),
      payload: templateBody,
    });
    expect(copy.statusCode, copy.body).toBeLessThan(300);
    const bTemplateId = copy.json<{ id: string }>().id;
    const published = await world.app.inject({
      method: "POST",
      url: `/api/v1/templates/${bTemplateId}/publish`,
      headers: as(bAdminToken),
      payload: {},
    });
    expect(published.statusCode, published.body).toBeLessThan(300);
    const mk = async (token: string, templateId: string, name: string) => {
      const res = await world.app.inject({
        method: "POST",
        url: "/api/v1/campaigns",
        headers: as(token),
        payload: { templateId, name, verification: "open" },
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json<{ campaign: { id: string }; link: { url: string } }>();
    };
    const a = await mk(world.adminToken, world.templateId, "Probe A");
    aCampaign = a.campaign.id;
    aLink = a.link.url.split("/p/")[1]!;
    await world.app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${aCampaign}/open`,
      headers: as(world.adminToken),
    });
    const bc = await mk(bAdminToken, bTemplateId, "Probe B");
    bCampaign = bc.campaign.id;
    const inv = await world.app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${aCampaign}/invitations`,
      headers: as(world.adminToken),
      payload: { emails: ["invitee@probe.test"] },
    });
    expect(inv.statusCode, inv.body).toBeLessThan(300);
    aInvitation = (await world.db.invitation.findFirstOrThrow({ where: { campaignId: aCampaign } })).id;
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  // ---- 1. IDOR through a secondary id: the campaign is the attacker's own, the child is not ----
  it("P1: tenant B cannot act on tenant A's invitation through B's own campaign", async () => {
    for (const path of ["revoke", "remind"]) {
      const res = await world.app.inject({
        method: "POST",
        url: `/api/v1/campaigns/${bCampaign}/invitations/${aInvitation}/${path}`,
        headers: as(bAdminToken),
        payload: {},
      });
      expect([403, 404], `${path}: ${res.statusCode} ${res.body}`).toContain(res.statusCode);
    }
    const still = await world.db.invitation.findUniqueOrThrow({ where: { id: aInvitation } });
    expect(still.status).not.toBe("revoked");
  });

  // ---- 2. participant token reuse after deletion, on every participant route ----
  it("P2: a deleted participant's token is refused on every participant route", async () => {
    const joined = await world.app.inject({
      method: "POST",
      url: `/api/v1/p/${aLink}/open`,
      payload: {},
    });
    const token = joined.json<{ participantToken: string }>().participantToken;
    const header = as(`pt.${token}`);
    const del = await world.app.inject({ method: "DELETE", url: "/api/v1/p/session", headers: header });
    expect(del.statusCode).toBeLessThan(300);
    const routes = world.app.routeTable.filter((r) => r.access === "participant");
    expect(routes.length).toBeGreaterThan(5);
    const bad: string[] = [];
    for (const r of routes) {
      if (r.url.endsWith("/live")) continue;
      const url = r.url.replace(/:[A-Za-z]+/g, "x");
      const res = await world.app.inject({
        method: r.method as "GET",
        url,
        headers: header,
        ...(["GET", "DELETE", "HEAD"].includes(r.method) ? {} : { payload: {} }),
      });
      if (res.statusCode !== 401) bad.push(`${r.method} ${r.url} -> ${res.statusCode}`);
    }
    expect(bad).toEqual([]);
  });

  // ---- 3. member reading admin-only routes ----
  it("P3: a member is refused on every admin or operator GET route", async () => {
    const bad: string[] = [];
    for (const r of world.app.routeTable) {
      if (r.method !== "GET" || (r.access !== "admin" && r.access !== "operator")) continue;
      const url = r.url.replace(/:[A-Za-z]+/g, "missing");
      const res = await world.app.inject({ method: "GET", url, headers: as(memberToken) });
      if (res.statusCode !== 403) bad.push(`${r.url} -> ${res.statusCode}`);
    }
    expect(bad).toEqual([]);
  });

  // ---- 4. mass assignment and scope smuggling ----
  it("P4: an admin cannot make themselves operator, nor write platform settings or ceilings", async () => {
    const me = await world.db.user.findFirstOrThrow({ where: { email: world.adminEmail } });
    const patch = await world.app.inject({
      method: "PATCH",
      url: `/api/v1/users/${me.id}`,
      headers: as(world.adminToken),
      payload: { role: "platform_operator" },
    });
    expect(patch.statusCode).toBeGreaterThanOrEqual(400);
    const created = await world.app.inject({
      method: "POST",
      url: "/api/v1/users",
      headers: as(world.adminToken),
      payload: { email: `escalate-${Date.now()}@test.io`, role: "platform_operator" },
    });
    expect(created.statusCode).toBeGreaterThanOrEqual(400);
    const platform = await world.app.inject({
      method: "PUT",
      url: "/api/v1/settings?scope=platform",
      headers: as(world.adminToken),
      payload: { values: { "ceiling.maxSessionsPerMonth": 100000 } },
    });
    expect(platform.statusCode).toBeGreaterThanOrEqual(400);
    const tenantCeiling = await world.app.inject({
      method: "PUT",
      url: "/api/v1/settings?scope=tenant",
      headers: as(world.adminToken),
      payload: { values: { "ceiling.maxSessionsPerMonth": 100000 } },
    });
    expect(tenantCeiling.statusCode, tenantCeiling.body).toBeGreaterThanOrEqual(400);
    const foreign = await world.app.inject({
      method: "PUT",
      url: `/api/v1/settings?scope=campaign&scopeId=${bCampaign}`,
      headers: as(world.adminToken),
      payload: { values: { "abuse.campaignSessionsPerHour": 1 } },
    });
    expect([403, 404]).toContain(foreign.statusCode);
    const tenantOther = await world.app.inject({
      method: "PUT",
      url: `/api/v1/settings?scope=tenant&scopeId=${(await world.db.user.findFirstOrThrow({ where: { email: world.operatorEmail } })).companyId}`,
      headers: as(world.adminToken),
      payload: { values: { "privacy.retentionMonths": 1 } },
    });
    // Either ignored (written to the caller's own tenant) or refused; never written to the other.
    const other = await world.db.setting.findFirst({
      where: {
        key: "privacy.retentionMonths",
        scope: "tenant",
        scopeId: (await world.db.user.findFirstOrThrow({ where: { email: world.operatorEmail } })).companyId,
      },
    });
    expect(other, `status ${tenantOther.statusCode}`).toBeNull();
  });

  // ---- 5. forged credentials ----
  it("P5: forged, foreign-secret, unsigned and garbage staff tokens are anonymous", async () => {
    const wrongSecret = await jwt(world.adminEmail, "x".repeat(40));
    const unsigned = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(
      JSON.stringify({ email: world.adminEmail }),
    ).toString("base64url")}.`;
    for (const token of [wrongSecret, unsigned, "garbage", "pt.garbage", "", "Bearer"]) {
      const res = await world.app.inject({
        method: "GET",
        url: "/api/v1/me",
        headers: token ? as(token) : {},
      });
      expect(res.statusCode, token.slice(0, 20)).toBe(401);
    }
  });

  // ---- 6. CORS ----
  it("P6: a foreign origin gets no credentialed CORS headers", async () => {
    const res = await world.app.inject({
      method: "OPTIONS",
      url: "/api/v1/me",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "GET",
      },
    });
    const allow = res.headers["access-control-allow-origin"];
    expect(allow === undefined || allow !== "https://evil.example").toBe(true);
    expect(allow).not.toBe("*");
  });

  // ---- 7. concurrency: code verification and code requests ----
  it("P7a: parallel wrong codes cannot exceed the per-code attempt limit", async () => {
    const c = await world.app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: as(world.adminToken),
      payload: { templateId: world.templateId, name: "Race", verification: "email_code" },
    });
    const body = c.json<{ campaign: { id: string }; link: { url: string } }>();
    await world.app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${body.campaign.id}/open`,
      headers: as(world.adminToken),
    });
    const link = body.link.url.split("/p/")[1]!;
    const email = "racer@probe.test";
    await world.app.inject({
      method: "POST",
      url: `/api/v1/p/${link}/verify/request`,
      headers: { "x-forwarded-for": "198.51.100.1" },
      payload: { email },
    });
    const code = /is (\d{6})/.exec(world.email.sent.filter((m) => m.to === email).at(-1)?.text ?? "")?.[1];
    expect(code).toBeTruthy();
    const wrong = (i: number) => String((Number(code) + 1 + i) % 1_000_000).padStart(6, "0");
    // 60 guesses at once, each from its own address so the route bucket is not the thing counting.
    const results = await Promise.all(
      Array.from({ length: 60 }, (_v, i) =>
        world.app.inject({
          method: "POST",
          url: `/api/v1/p/${link}/verify/confirm`,
          headers: { "x-forwarded-for": `203.0.113.${(i % 250) + 1}` },
          payload: { email, code: wrong(i) },
        }),
      ),
    );
    expect(results.every((r) => r.statusCode === 403)).toBe(true);
    const row = await world.db.emailCode.findFirst({
      where: { campaignId: body.campaign.id },
      orderBy: { createdAt: "desc" },
    });
    // Design bound: five guesses per code. A larger number means the check-then-increment raced.
    expect(row?.attempts ?? 0, "guesses accepted against one code").toBeLessThanOrEqual(5);
  });

  it("P7b: parallel code requests cannot exceed the per-address hourly cap", async () => {
    const c = await world.app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: as(world.adminToken),
      payload: { templateId: world.templateId, name: "Race2", verification: "email_code" },
    });
    const body = c.json<{ campaign: { id: string }; link: { url: string } }>();
    await world.app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${body.campaign.id}/open`,
      headers: as(world.adminToken),
    });
    const link = body.link.url.split("/p/")[1]!;
    const email = "bombed@probe.test";
    await Promise.all(
      Array.from({ length: 40 }, (_v, i) =>
        world.app.inject({
          method: "POST",
          url: `/api/v1/p/${link}/verify/request`,
          headers: { "x-forwarded-for": `192.0.2.${(i % 250) + 1}` },
          payload: { email },
        }),
      ),
    );
    const sent = world.email.sent.filter((m) => m.to === email).length;
    expect(sent, "mails sent to one address in a parallel burst").toBeLessThanOrEqual(3);
  });

  // ---- 8. filenames and header injection through names the user controls ----
  it("P8: a hostile campaign name cannot split or escape the Content-Disposition header", async () => {
    const evil = 'a"\r\nX-Injected: 1\r\n\r\n<script>../../etc/passwd‮gpj.exe';
    const patched = await world.app.inject({
      method: "PATCH",
      url: `/api/v1/campaigns/${aCampaign}`,
      headers: as(world.adminToken),
      payload: { name: evil },
    });
    expect([200, 400]).toContain(patched.statusCode);
    const res = await world.app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${aCampaign}/sessions.csv`,
      headers: as(world.adminToken),
    });
    expect(res.statusCode).toBe(200);
    const disposition = String(res.headers["content-disposition"]);
    expect(disposition).not.toMatch(/[\r\n]/);
    expect(res.headers["x-injected"]).toBeUndefined();
    expect(disposition).not.toContain("..");
    expect(disposition).not.toContain("/");
    expect(disposition).toMatch(/^attachment; filename="[A-Za-z0-9._-]+"$/);
    // CSV formula injection: a cell that starts with = + - @ must be neutralised.
    expect(res.body.split("\n").slice(1).join("\n")).not.toMatch(/(^|,)"?[=+@]/);
  });

  // ---- 9. upload: traversal in filename, polyglots ----
  it("P9: uploads with a traversal filename, a PDF/ZIP polyglot and an HTML-as-text file", async () => {
    const joined = await world.app.inject({ method: "POST", url: `/api/v1/p/${aLink}/open`, payload: {} });
    const token = joined.json<{ participantToken: string }>().participantToken;
    const upload = async (filename: string, mime: string, bytes: Buffer) => {
      const boundary = "----probe";
      const head = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
      );
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
      return world.app.inject({
        method: "POST",
        url: "/api/v1/p/session/attachments",
        headers: {
          ...as(`pt.${token}`),
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload: Buffer.concat([head, bytes, tail]),
      });
    };
    // Traversal in the name: accepted or refused, but the stored key and the echoed name are safe.
    const text = Buffer.from("plain notes about the ward\n");
    const traversal = await upload("../../../etc/cron.d/x.txt", "text/plain", text);
    if (traversal.statusCode < 300) {
      const att = traversal.json<{ attachment: { id: string; filename: string } }>().attachment;
      expect(att.filename).not.toContain("/");
      expect(att.filename).not.toContain("..");
      const row = await world.db.attachment.findUniqueOrThrow({ where: { id: att.id } });
      expect(row.storageKey).not.toContain("..");
      expect(row.storageKey).toContain(att.id);
    }
    // A file that is a valid PDF header followed by a ZIP, declared as docx: the declared type
    // and the detected one disagree, so it must be refused, never parsed as either.
    const polyglot = Buffer.concat([
      Buffer.from("%PDF-1.4\n"),
      Buffer.from("PK\u0003\u0004"),
      Buffer.alloc(60, 0),
    ]);
    const poly = await upload(
      "x.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      polyglot,
    );
    expect(poly.statusCode, poly.body).toBeGreaterThanOrEqual(400);
    // HTML with script, declared text: stored only as an attachment download, never inline.
    const html = await upload("page.txt", "text/plain", Buffer.from("<html><script>alert(1)</script>"));
    if (html.statusCode < 300) {
      const att = html.json<{ attachment: { id: string } }>().attachment;
      const get = await world.app.inject({
        method: "GET",
        url: `/api/v1/p/session/attachments/${att.id}`,
        headers: as(`pt.${token}`),
      });
      expect(String(get.headers["content-disposition"])).toMatch(/^attachment;/);
      expect(get.headers["x-content-type-options"]).toBe("nosniff");
      expect(String(get.headers["content-security-policy"])).toContain("sandbox");
    }
  });

  // ---- 10. participant cannot reach another participant's attachment ----
  it("P10: participant A cannot read or delete participant B's attachment by id", async () => {
    const mkSession = async () => {
      const r = await world.app.inject({ method: "POST", url: `/api/v1/p/${aLink}/open`, payload: {} });
      return r.json<{ participantToken: string; sessionId: string }>();
    };
    const a = await mkSession();
    const b = await mkSession();
    const boundary = "----p10";
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="b.txt"\r\nContent-Type: text/plain\r\n\r\n`,
      ),
      Buffer.from("secret of participant B\n"),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const up = await world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/attachments",
      headers: {
        ...as(`pt.${b.participantToken}`),
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
    if (up.statusCode >= 300) return; // uploads disabled in this world; nothing to attack
    const id = up.json<{ attachment: { id: string } }>().attachment.id;
    const read = await world.app.inject({
      method: "GET",
      url: `/api/v1/p/session/attachments/${id}`,
      headers: as(`pt.${a.participantToken}`),
    });
    expect(read.statusCode).toBe(404);
    const del = await world.app.inject({
      method: "DELETE",
      url: `/api/v1/p/session/attachments/${id}`,
      headers: as(`pt.${a.participantToken}`),
    });
    expect(del.statusCode).toBe(404);
  });
});
