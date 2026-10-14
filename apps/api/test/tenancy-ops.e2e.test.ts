import type { Server } from "node:http";
import { ErasureLedger, TenantPurger } from "@aidp/core";
import { describeDb } from "@aidp/testing";
import { encode } from "@auth/core/jwt";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fakeModelServer, testWorld, TURN_MARKER, type TestWorld } from "./helpers.js";

const suite = describeDb;

/** The first bytes of a WebM/Matroska container, which is what the upload check looks for. */
const webm = (tail: string): Buffer =>
  Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from(tail)]);

/**
 * The operator's tenancy operations through the real HTTP surface, with the application connected
 * as `app_api` (so the purge and the export also prove the row-level-security fence holds for
 * them): the health page, statements and spend, export, offboarding, and the two ceilings that
 * are enforced at the voice and storage paths (D-222, D-224 to D-226, D-229).
 */
suite("tenancy operations", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };
  const admin = (): Record<string, string> => ({ authorization: `Bearer ${world.adminToken}` });
  const operator = (): Record<string, string> => ({ authorization: `Bearer ${world.operatorToken}` });
  const reply = `Thanks. What happens next?\n${TURN_MARKER}\n${JSON.stringify({ areaKey: "daily" })}`;

  beforeAll(async () => {
    model = await fakeModelServer(
      () => reply,
      undefined,
      () => ({ text: "We retype the referrals into the ward spreadsheet.", duration: 30 }),
    );
    world = await testWorld(model.url, { RATE_LIMIT_MAX: "100000", RATE_LIMIT_EXPENSIVE_MAX: "100000" });
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  async function secondTenant(): Promise<{ id: string; name: string; adminToken: string }> {
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const name = `Leaving ${suffix}`;
    const company = await world.db.company.create({ data: { name } });
    const email = `leaving-${suffix}@test.io`;
    const user = await world.db.user.create({ data: { companyId: company.id, email, role: "admin" } });
    const template = await world.db.interviewTemplate.create({
      data: {
        companyId: company.id,
        key: `k-${suffix}`,
        name: "T",
        objective: "o",
        privacyMode: "anonymous",
      },
    });
    const campaign = await world.db.campaign.create({
      data: {
        companyId: company.id,
        templateId: template.id,
        name: "Camp",
        participationMode: "anonymous",
        linkTokenHash: `l-${suffix}`,
        verification: "open",
        status: "open",
        createdById: user.id,
      },
    });
    const session = await world.db.session.create({
      data: { companyId: company.id, templateId: template.id, campaignId: campaign.id, status: "completed" },
    });
    await world.db.message.create({
      data: { companyId: company.id, sessionId: session.id, seq: 1, role: "user", content: "secret words" },
    });
    const key = `${company.id}/${session.id}/att1`;
    await world.storage.put(key, Buffer.from("bytes of a recording"), { contentType: "audio/webm" });
    await world.db.attachment.create({
      data: {
        companyId: company.id,
        sessionId: session.id,
        kind: "audio",
        filename: "a.webm",
        mime: "audio/webm",
        sizeBytes: 20,
        storageKey: key,
      },
    });
    await world.db.auditLog.create({
      data: {
        companyId: company.id,
        actorId: user.id,
        action: "campaign.create",
        targetType: "campaign",
        targetId: campaign.id,
      },
    });
    const adminToken = await encode({
      token: { email },
      secret: world.ctx.config.AUTH_SECRET,
      salt: "authjs.session-token",
    });
    return { id: company.id, name, adminToken };
  }

  async function tenantRows(companyId: string): Promise<Record<string, number>> {
    const tables = await world.db.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'companyId'`,
    );
    const out: Record<string, number> = {};
    for (const { table_name } of tables) {
      const r = await world.db.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM "${table_name}" WHERE "companyId" = $1`,
        companyId,
      );
      if ((r[0]?.n ?? 0) > 0) out[table_name] = r[0]?.n ?? 0;
    }
    return out;
  }

  it("serves every platform signal and each tenant's utilisation on one page, to the operator only", async () => {
    const res = await world.app.inject({
      method: "GET",
      url: "/api/v1/operator/health",
      headers: operator(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      signals: { key: string; status: string }[];
      tenants: { companyId: string; utilisation: { metric: string }[] }[];
      latency: { firstTokenTargetMs: number; voiceFirstWordTargetMs: number };
      queues: unknown[];
    }>();
    const keys = body.signals.map((s) => s.key);
    for (const k of [
      "queue.depth",
      "job.dead_lettered",
      "worker.heartbeat_stale",
      "backup.age",
      "backup.drill",
      "disk.high",
      "provider.error_rate",
      "slo.first_token",
      "slo.voice_first_word",
    ])
      expect(keys, k).toContain(k);
    expect(body.latency.firstTokenTargetMs).toBe(2000);
    expect(body.latency.voiceFirstWordTargetMs).toBe(1500);
    const mine = body.tenants.find((t) => t.companyId === world.companyId);
    expect(mine?.utilisation.map((u) => u.metric).sort()).toEqual([
      "maxActiveCampaigns",
      "maxSessionsPerMonth",
      "storageBytes",
      "voiceMinutes",
    ]);

    const asAdmin = await world.app.inject({
      method: "GET",
      url: "/api/v1/operator/health",
      headers: admin(),
    });
    expect(asAdmin.statusCode).toBe(403);
  });

  it("reports first-token p95 and spend by provider and against each budget line", async () => {
    const provider = await world.db.provider.findFirstOrThrow({ where: { companyId: world.companyId } });
    const owner = await world.db.user.findFirstOrThrow({ where: { email: world.adminEmail } });
    const campaign = await world.db.campaign.create({
      data: {
        companyId: world.companyId,
        createdById: owner.id,
        templateId: world.templateId,
        name: "Budgeted",
        participationMode: "anonymous",
        linkTokenHash: `lb-${Date.now()}`,
        verification: "open",
        status: "open",
      },
    });
    await world.db.budget.create({
      data: {
        companyId: world.companyId,
        scope: "campaign",
        scopeId: campaign.id,
        limitCents: 100,
        period: "total",
      },
    });
    const base = {
      companyId: world.companyId,
      providerId: provider.id,
      model: "fake-model",
      inputTokens: 100,
      outputTokens: 20,
      latencyMs: 900,
      campaignId: campaign.id,
    };
    for (const [ms, cost] of [
      [200, 10],
      [400, 10],
      [600, 10],
      [800, 10],
      [3000, 10],
    ] as const)
      await world.db.llmCall.create({
        data: { ...base, purpose: "interview_turn", status: "ok", costCents: cost, firstTokenMs: ms },
      });
    await world.db.llmCall.create({
      data: {
        ...base,
        purpose: "stt_stream",
        status: "ok",
        costCents: 5,
        audioSeconds: 90,
        estimated: true,
      },
    });

    const stats = (await world.app.inject({ method: "GET", url: "/api/v1/stats", headers: admin() })).json<{
      ai: {
        month: {
          firstTokenP50Ms: number | null;
          firstTokenP95Ms: number | null;
          audioMinutes: number;
          estimatedCostShare: number;
        };
      };
    }>();
    // p95 of 200, 400, 600, 800, 3000 by linear interpolation: 800 + 0.8 * 2200.
    expect(stats.ai.month.firstTokenP50Ms).toBe(600);
    expect(stats.ai.month.firstTokenP95Ms).toBe(2560);
    expect(stats.ai.month.audioMinutes).toBeCloseTo(1.5, 5);
    expect(stats.ai.month.estimatedCostShare).toBeGreaterThan(0);

    const byProvider = (
      await world.app.inject({ method: "GET", url: "/api/v1/spend?groupBy=provider", headers: admin() })
    ).json<{
      rows: { key: string; label?: string; audioSeconds: number; estimatedCents: number }[];
    }>();
    const row = byProvider.rows.find((r) => r.key === provider.id);
    expect(row?.label).toBe("fake");
    expect(row?.audioSeconds).toBe(90);
    expect(row?.estimatedCents).toBe(5);
    const byStatus = (
      await world.app.inject({ method: "GET", url: "/api/v1/spend?groupBy=status", headers: admin() })
    ).json<{ rows: { key: string }[] }>();
    expect(byStatus.rows.map((r) => r.key)).toContain("ok");

    const budgets = (
      await world.app.inject({ method: "GET", url: "/api/v1/spend/budgets", headers: admin() })
    ).json<{
      budgets: {
        scope: string;
        name: string | null;
        limitCents: number;
        spentCents: number;
        state: string;
      }[];
    }>().budgets;
    const line = budgets.find((b) => b.scope === "campaign" && b.name === "Budgeted");
    expect(line).toMatchObject({ limitCents: 100, spentCents: 55, state: "ok" });
    expect(budgets.some((b) => b.scope === "tenant")).toBe(true);
  });

  it("freezes a monthly statement and serves it to the tenant and, across tenants, to the operator as CSV", async () => {
    const month = new Date().toISOString().slice(0, 7);
    const { created } = await world.ctx.statements.freeze(world.companyId, month);
    expect(created).toBe(true);

    const list = (
      await world.app.inject({ method: "GET", url: "/api/v1/spend/statements", headers: admin() })
    ).json<{ statements: { month: string; costCents: number }[] }>();
    expect(list.statements.map((s) => s.month)).toContain(month);

    const one = (
      await world.app.inject({ method: "GET", url: `/api/v1/spend/statements/${month}`, headers: admin() })
    ).json<{
      statement: {
        lines: { providerName: string; purpose: string; audioSeconds: number; estimatedCents: number }[];
        totals: { costCents: number; estimatedCents: number; budgets: { scope: string }[] };
        counts: { voiceMinutes: number };
      };
    }>();
    const stt = one.statement.lines.find((l) => l.purpose === "stt_stream");
    expect(stt).toMatchObject({ providerName: "fake", audioSeconds: 90, estimatedCents: 5 });
    expect(one.statement.totals.costCents).toBeGreaterThanOrEqual(55);
    expect(one.statement.counts.voiceMinutes).toBeCloseTo(1.5, 1);

    const csv = await world.app.inject({
      method: "GET",
      url: `/api/v1/spend/statements/${month}?format=csv`,
      headers: admin(),
    });
    expect(csv.headers["content-type"]).toContain("text/csv");
    const lines = csv.body.trim().split("\n");
    expect(lines[0]).toContain("audioSeconds,ttsCharacters,costCents,estimatedCents");
    expect(lines.some((l) => l.includes("stt_stream") && l.includes(",90,"))).toBe(true);

    // A frozen statement is not recomputed when more calls arrive.
    await world.db.llmCall.create({
      data: {
        companyId: world.companyId,
        providerId: (await world.db.provider.findFirstOrThrow({ where: { companyId: world.companyId } })).id,
        model: "fake-model",
        purpose: "extraction",
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
        status: "ok",
        costCents: 7,
      },
    });
    const again = await world.ctx.statements.freeze(world.companyId, month);
    expect(again.created).toBe(false);
    expect(again.statement.totals.costCents).toBe(one.statement.totals.costCents);

    // The operator's file carries every tenant's lines with the company on each row.
    const all = await world.app.inject({
      method: "GET",
      url: `/api/v1/operator/statements/${month}?format=csv`,
      headers: operator(),
    });
    expect(all.statusCode).toBe(200);
    expect(all.body).toContain(world.companyId);

    // Another tenant's admin does not see this tenant's statement.
    const other = await secondTenant();
    const theirs = (
      await world.app.inject({
        method: "GET",
        url: "/api/v1/spend/statements",
        headers: { authorization: `Bearer ${other.adminToken}` },
      })
    ).json<{ statements: unknown[] }>();
    expect(theirs.statements).toEqual([]);
    const notTheirs = await world.app.inject({
      method: "GET",
      url: `/api/v1/spend/statements/${month}`,
      headers: { authorization: `Bearer ${other.adminToken}` },
    });
    expect(notTheirs.statusCode).toBe(404);
    // Members and anonymous callers do not reach billing.
    const anon = await world.app.inject({ method: "GET", url: `/api/v1/spend/statements/${month}` });
    expect(anon.statusCode).toBe(401);
  });

  it("exports a tenant for the operator, and offboards it: zero rows and zero bytes afterwards", async () => {
    const t = await secondTenant();
    const headers = operator();

    // Export: queued, then written by the job; the download is the decrypted zip.
    const queued = await world.app.inject({
      method: "POST",
      url: `/api/v1/operator/tenants/${t.id}/export`,
      headers,
    });
    expect(queued.statusCode).toBe(202);
    expect(world.jobs.published.some((j) => j.name === "tenant.export")).toBe(true);
    const meta = await world.ctx.exporter.run(t.id, "operator");
    const listed = (
      await world.app.inject({ method: "GET", url: `/api/v1/operator/tenants/${t.id}/exports`, headers })
    ).json<{ exports: { stamp: string }[] }>();
    expect(listed.exports.map((e) => e.stamp)).toEqual([meta.stamp]);
    const download = await world.app.inject({
      method: "GET",
      url: `/api/v1/operator/tenants/${t.id}/exports/${meta.stamp}`,
      headers,
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toBe("application/zip");
    const zip = download.rawPayload;
    expect(zip.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(zip.includes(Buffer.from("secret words"))).toBe(true);
    // A tenant's own admin cannot take it.
    const asTenant = await world.app.inject({
      method: "GET",
      url: `/api/v1/operator/tenants/${t.id}/exports/${meta.stamp}`,
      headers: { authorization: `Bearer ${t.adminToken}` },
    });
    expect(asTenant.statusCode).toBe(403);

    // Offboarding starts from a suspended tenant, and the typed name.
    const live = await world.app.inject({
      method: "POST",
      url: `/api/v1/operator/tenants/${t.id}/offboard`,
      headers,
      payload: { confirmName: t.name },
    });
    expect(live.statusCode).toBe(409);
    await world.app.inject({
      method: "PATCH",
      url: `/api/v1/operator/tenants/${t.id}`,
      headers,
      payload: { status: "suspended" },
    });
    const wrong = await world.app.inject({
      method: "POST",
      url: `/api/v1/operator/tenants/${t.id}/offboard`,
      headers,
      payload: { confirmName: "not the name" },
    });
    expect(wrong.statusCode).toBe(400);
    expect(world.jobs.published.filter((j) => j.name === "tenant.offboard")).toHaveLength(0);

    const ok = await world.app.inject({
      method: "POST",
      url: `/api/v1/operator/tenants/${t.id}/offboard`,
      headers,
      payload: { confirmName: t.name },
    });
    expect(ok.statusCode).toBe(202);
    // Seven days of grace unless asked otherwise, and the job re-checks that it is still wanted.
    const queuedOffboard = world.jobs.published.find((j) => j.name === "tenant.offboard");
    expect(queuedOffboard?.startAfterSeconds).toBe(7 * 86_400);
    expect(queuedOffboard?.payload).toMatchObject({ companyId: t.id, graceCheck: true });

    // The job, run as app_api: the row-level-security fence holds for the purge itself.
    const purger = new TenantPurger({
      db: world.ctx.db,
      storage: world.storage,
      ledger: new ErasureLedger({ db: world.ctx.db }),
    });
    const report = await purger.run(t.id, "operator");
    expect(report.rows.Message).toBe(1);
    expect(report.auditRows).toBeGreaterThanOrEqual(1);
    expect(await tenantRows(t.id)).toEqual({});
    expect((await world.storage.listPrefixes(t.id)).length).toBe(0);
    expect((await world.storage.listPrefixes(`exports/${t.id}`)).length).toBe(0);
    expect((await world.db.company.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("deleted");

    // The request and the download were filed under the operator's company and outlive the tenant.
    const opCompany = (await world.db.user.findFirstOrThrow({ where: { email: world.operatorEmail } }))
      .companyId;
    const trail = await world.db.auditLog.findMany({
      where: { companyId: opCompany, targetId: t.id },
      select: { action: true },
    });
    expect(trail.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        "tenant.export_requested",
        "tenant.export_downloaded",
        "tenant.offboard_requested",
      ]),
    );
  });

  it("refuses an upload that would pass ceiling.storageBytes, and tells the tenant", async () => {
    const put = await world.app.inject({
      method: "PUT",
      url: `/api/v1/settings?scope=tenant&scopeId=${world.companyId}`,
      headers: operator(),
      payload: { values: { "ceiling.storageBytes": 64 } },
    });
    expect(put.statusCode).toBe(200);

    const created = await world.app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: admin(),
      payload: { templateId: world.templateId, name: `Storage ${Date.now()}`, verification: "open" },
    });
    const { campaign, link } = created.json<{ campaign: { id: string }; link: { url: string } }>();
    await world.app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaign.id}/open`,
      headers: admin(),
    });
    const open = await world.app.inject({
      method: "POST",
      url: `/api/v1/p/${link.url.split("/p/")[1]}/open`,
      payload: {},
    });
    const token = `Bearer pt.${open.json<{ participantToken: string }>().participantToken}`;
    await world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/consent",
      headers: { authorization: token },
      payload: { consentVersion: "v1", participationChoice: "anonymous" },
    });

    const multipart = (name: string, type: string, body: Buffer) => {
      const boundary = `----t${Math.random().toString(36).slice(2)}`;
      return {
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`,
          ),
          body,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
      };
    };
    // A file that fits in what is left of the ceiling is taken...
    const small = multipart("a.txt", "text/plain", Buffer.from("x".repeat(40)));
    const first = await world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/attachments",
      headers: { authorization: token, ...small.headers },
      payload: small.payload,
    });
    expect(first.statusCode).toBe(200);
    // ...the next one would pass it and is refused with the limit named.
    const second = await world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/attachments",
      headers: { authorization: token, ...small.headers },
      payload: small.payload,
    });
    expect(second.statusCode).toBe(403);
    expect(second.json()).toMatchObject({ error: { code: "limit_reached" } });
    expect(world.alerts.ofKind("ceiling.reached").some((a) => a.key.includes("storageBytes"))).toBe(true);

    // Nothing was left behind by the refused upload.
    const rows = await world.db.attachment.findMany({
      where: { companyId: world.companyId, kind: "document" },
    });
    expect(rows.reduce((n, r) => n + r.sizeBytes, 0)).toBeLessThanOrEqual(64);
    await world.app.inject({
      method: "PUT",
      url: `/api/v1/settings?scope=tenant&scopeId=${world.companyId}`,
      headers: operator(),
      payload: { values: { "ceiling.storageBytes": null } },
    });
  });

  it("refuses a recorded voice answer once ceiling.voiceMinutes is used up", async () => {
    // Ninety seconds of transcription were booked above, so one minute is already over.
    await world.app.inject({
      method: "PUT",
      url: `/api/v1/settings?scope=tenant&scopeId=${world.companyId}`,
      headers: operator(),
      payload: { values: { "ceiling.voiceMinutes": 1 } },
    });
    const created = await world.app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: admin(),
      payload: { templateId: world.templateId, name: `Voice ${Date.now()}`, verification: "open" },
    });
    const { campaign, link } = created.json<{ campaign: { id: string }; link: { url: string } }>();
    await world.app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaign.id}/open`,
      headers: admin(),
    });
    const open = await world.app.inject({
      method: "POST",
      url: `/api/v1/p/${link.url.split("/p/")[1]}/open`,
      payload: {},
    });
    const token = `Bearer pt.${open.json<{ participantToken: string }>().participantToken}`;
    await world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/consent",
      headers: { authorization: token },
      payload: { consentVersion: "v1", participationChoice: "anonymous" },
    });
    await world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/turns",
      headers: { authorization: token },
    });

    const boundary = "----voice";
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.webm"\r\nContent-Type: audio/webm\r\n\r\n`,
      ),
      webm("opus"),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/voice-turns",
      headers: { authorization: token, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      error: { code: "limit_reached", details: { limit: "voiceMinutes" } },
    });

    await world.app.inject({
      method: "PUT",
      url: `/api/v1/settings?scope=tenant&scopeId=${world.companyId}`,
      headers: operator(),
      payload: { values: { "ceiling.voiceMinutes": null } },
    });
  });

  it("lets the operator set a fallback route per purpose, and reads it back", async () => {
    const primary = await world.db.provider.findFirstOrThrow({ where: { companyId: world.companyId } });
    const backup = await world.db.provider.create({
      data: {
        companyId: world.companyId,
        kind: "openai_compatible",
        name: "backup",
        baseUrl: model.url,
        apiKeyEnc: world.crypto.encrypt("k2", "provider.apiKey"),
        headers: {},
      },
    });
    const set = await world.app.inject({
      method: "PUT",
      url: "/api/v1/routes",
      headers: admin(),
      payload: {
        routes: [
          {
            purpose: "interview_turn",
            providerId: primary.id,
            model: "fake-model",
            fallback: { providerId: backup.id, model: "backup-model" },
          },
        ],
      },
    });
    expect(set.statusCode).toBe(200);
    const row = set
      .json<{
        routes: { purpose: string; fallback: { providerId: string; model: string } | null }[];
      }>()
      .routes.find((r) => r.purpose === "interview_turn");
    expect(row?.fallback).toEqual({ providerId: backup.id, model: "backup-model" });

    // The same provider as the primary would route a failing provider back to itself.
    const same = await world.app.inject({
      method: "PUT",
      url: "/api/v1/routes",
      headers: admin(),
      payload: {
        routes: [
          {
            purpose: "interview_turn",
            providerId: primary.id,
            model: "fake-model",
            fallback: { providerId: primary.id, model: "other" },
          },
        ],
      },
    });
    expect(same.statusCode).toBe(400);

    const cleared = await world.app.inject({
      method: "PUT",
      url: "/api/v1/routes",
      headers: admin(),
      payload: {
        routes: [{ purpose: "interview_turn", providerId: primary.id, model: "fake-model", fallback: null }],
      },
    });
    expect(
      cleared
        .json<{ routes: { purpose: string; fallback: unknown }[] }>()
        .routes.find((r) => r.purpose === "interview_turn")?.fallback,
    ).toBeNull();
  });
});
