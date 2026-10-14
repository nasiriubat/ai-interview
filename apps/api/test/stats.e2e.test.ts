import type { Server } from "node:http";
import { describeDb } from "@aidp/testing";
import { encode } from "@auth/core/jwt";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fakeModelServer, testWorld, type TestWorld } from "./helpers.js";

/**
 * Dashboard statistics (spec 07), each against fixtures whose answer is known by hand: a median
 * with a ten-day pause in it, percentiles over twenty values, a share, a ratio. Tenant isolation is
 * proved by a second organization whose rows would change every number if they leaked.
 */
const factor = (n: number) => ({ score: n, rationale: "r" });
const factors = (n: number) => ({
  expected_impact: factor(n),
  affected_employees: factor(n),
  frequency: factor(n),
  implementation_complexity: factor(n),
  data_availability: factor(n),
  risk: factor(n),
  ai_suitability: factor(n),
});

const T0 = new Date("2026-03-02T09:00:00Z");
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);

describeDb("dashboard statistics", () => {
  let world: TestWorld;
  let model: { server: Server; url: string };
  let campaignId = "";
  let otherCampaignId = "";
  let memberToken = "";
  let memberId = "";
  const h = () => ({ authorization: `Bearer ${world.adminToken}` });

  const get = async <T>(url: string, token = world.adminToken): Promise<T> => {
    const r = await world.app.inject({
      method: "GET",
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.statusCode, `${url} ${r.body.slice(0, 300)}`).toBe(200);
    return r.json<T>();
  };

  async function session(
    status: string,
    opts: {
      identified?: boolean;
      messages?: { at: number; role: "user" | "assistant"; area?: string }[];
      campaign?: string;
      endedAt?: Date;
    } = {},
  ): Promise<string> {
    const s = await world.db.session.create({
      data: {
        companyId: world.companyId,
        templateId: world.templateId,
        campaignId: opts.campaign ?? campaignId,
        status,
        identified: opts.identified ?? false,
        createdAt: T0,
        ...(opts.endedAt ? { endedAt: opts.endedAt } : {}),
      },
    });
    let seq = 0;
    for (const m of opts.messages ?? []) {
      await world.db.message.create({
        data: {
          companyId: world.companyId,
          sessionId: s.id,
          seq: seq++,
          role: m.role,
          content: "x",
          createdAt: at(m.at),
          ...(m.area ? { areaKey: m.area } : {}),
        },
      });
    }
    return s.id;
  }

  const chat = (...secs: number[]) =>
    secs.map((at, i) => ({ at, role: i % 2 === 0 ? ("assistant" as const) : ("user" as const) }));

  beforeAll(async () => {
    model = await fakeModelServer(() => "unused");
    world = await testWorld(model.url);
    const mk = async (name: string): Promise<string> => {
      const r = await world.app.inject({
        method: "POST",
        url: "/api/v1/campaigns",
        headers: h(),
        payload: { templateId: world.templateId, name, verification: "open", completionThreshold: 3 },
      });
      return r.json<{ campaign: { id: string } }>().campaign.id;
    };
    campaignId = await mk("Stats one");
    otherCampaignId = await mk("Stats two");
    const memberEmail = `stats-member-${Date.now().toString(36)}@test.io`;
    memberId = (
      await world.db.user.create({ data: { companyId: world.companyId, email: memberEmail, role: "member" } })
    ).id;
    memberToken = await encode({
      token: { email: memberEmail },
      secret: world.ctx.config.AUTH_SECRET,
      salt: "authjs.session-token",
    });

    // Completed interviews. Active time is the sum of the gaps, each capped at 300 s:
    //   A 60 + 60 + 300 (a ten-day pause) + 30 = 450;  B 100 + 100 = 200;  C 10;  D 400 -> 300.
    const day10 = 10 * 86_400;
    const done = [chat(0, 60, 120, 120 + day10, 150 + day10), chat(0, 100, 200), chat(0, 10), chat(0, 400)];
    for (const [i, m] of done.entries())
      await session("completed", { identified: i < 3, messages: m, endedAt: new Date() });
    // One consented-but-not-started anonymous interview and a created one (not counted at all).
    await session("consented", { identified: false });
    await session("created");
    // Five unfinished interviews: three stand in "tasks", two in "context".
    for (const area of ["tasks", "tasks", "tasks", "context", "context"])
      await session("active", {
        messages: [
          { at: 0, role: "assistant", area },
          { at: 30, role: "user" },
        ],
      });
    // Never answered: no user message, so not a drop-off.
    await session("active", { messages: [{ at: 0, role: "assistant", area: "tasks" }] });
    // A completed interview of the other campaign, to show the campaign filter.
    await session("completed", { campaign: otherCampaignId, messages: chat(0, 20), endedAt: new Date() });

    // Invitations: reminded twice, once, never; and a revoked one that is not invited.
    const mkInv = (n: number, reminderCount: number, status = "sent") =>
      world.db.invitation.create({
        data: {
          companyId: world.companyId,
          campaignId,
          emailHash: `h${n}-${Date.now()}`,
          tokenHash: `t${n}-${Date.now()}-${Math.random()}`,
          status,
          reminderCount,
          expiresAt: new Date(Date.now() + 86_400_000),
          ...(reminderCount > 0 ? { openedAt: at(5) } : {}),
        },
      });
    await mkInv(1, 2);
    await mkInv(2, 1);
    await mkInv(3, 0);
    await mkInv(4, 5, "revoked");

    // Requirements: two finished (10 and 20 turns), one with the legacy sentinel, one active.
    const req = async (status: string, state: object, ownerUserId?: string): Promise<string> =>
      (
        await world.db.session.create({
          data: {
            companyId: world.companyId,
            templateId: world.templateId,
            sourceKind: "text",
            status,
            state,
            ...(ownerUserId ? { ownerUserId } : {}),
          },
        })
      ).id;
    const finding = (type: string, status: string) => ({
      id: `${type}-${status}`,
      type,
      section: "s",
      description: "d",
      resolution: "r",
      default: "d",
      status,
    });
    const firstReq = await req("completed", {
      turnCount: 10,
      findings: [
        finding("ambiguity", "resolved"),
        finding("ambiguity", "raised"),
        finding("contradiction", "accepted"),
        finding("missing_decision", "open"),
      ],
    });
    await req("completed", { turnCount: 20, findings: [] });
    await req("completed", { turnCount: 1_000_000 });
    await req("active", { turnCount: 3 }, memberId);
    for (const v of [1, 2])
      await world.db.specVersion.create({
        data: {
          companyId: world.companyId,
          sessionId: firstReq,
          version: v,
          spec: {},
          specMd: "x",
          bundle: {},
        },
      });

    // The ledger: twenty answered calls at 100..2000 ms, and five that were not answers.
    const provider = await world.db.provider.findFirstOrThrow({
      where: { OR: [{ companyId: world.companyId }, { companyId: null }] },
    });
    const call = (purpose: string, status: string, latencyMs: number, tokens = 0) => ({
      companyId: world.companyId,
      purpose,
      providerId: provider.id,
      model: "m",
      inputTokens: tokens,
      outputTokens: tokens / 2,
      latencyMs,
      status,
      costCents: 0,
      campaignId,
    });
    await world.db.llmCall.createMany({
      data: [
        ...Array.from({ length: 20 }, (_, i) => call("interview_turn", "ok", (i + 1) * 100, 100)),
        call("interview_turn", "error", 30_000),
        call("interview_turn", "error", 30_000),
        call("interview_turn", "refused", 400),
        call("interview_turn", "budget_exceeded", 1),
        call("interview_turn", "aborted", 50),
      ],
    });

    // Discovery: the newest finished analysis of a campaign is the one that counts.
    const analysis = async (cid: string, version: number, status: string, preliminary = false) =>
      world.db.analysis.create({
        data: {
          companyId: world.companyId,
          campaignId: cid,
          version,
          status,
          preliminary,
          stats: { facts: 10 * version, participants: 4 },
        },
      });
    const opp = (analysisId: string, title: string, cls: string, score: number, state = "new") =>
      world.db.opportunity.create({
        data: {
          companyId: world.companyId,
          analysisId,
          title,
          summary: "s",
          solutionClass: cls,
          factors: factors(score),
          rationale: "r",
          rankScore: score,
          clusterKey: `${title}-${Math.random()}`,
          status: state,
          stats: { participants: 4 },
        },
      });
    const old = await analysis(campaignId, 1, "done");
    await opp(old.id, "Old one", "ai", 5);
    const latest = await analysis(campaignId, 2, "done");
    await opp(latest.id, "Auto high", "automation", 4);
    await opp(latest.id, "Process mid", "process", 3);
    await opp(latest.id, "None low", "none", 2);
    await opp(latest.id, "Dismissed", "ai", 5, "dismissed");
    const second = await analysis(otherCampaignId, 1, "done", true);
    await opp(second.id, "Prelim", "software", 5);
    await analysis(otherCampaignId, 2, "running");

    // Storage and queue.
    const holder = await session("completed", { endedAt: new Date() });
    for (const [kind, sizeBytes] of [
      ["audio", 1000],
      ["audio", 2000],
      ["document", 500],
    ] as const)
      await world.db.attachment.create({
        data: {
          companyId: world.companyId,
          sessionId: holder,
          kind,
          filename: "f",
          mime: "x/y",
          sizeBytes,
          storageKey: `${world.companyId}/${Math.random()}`,
        },
      });
    world.jobAdmin.addDead("analysis.run", { id: "d1", raw: { companyId: world.companyId } });
    world.jobAdmin.addDead("analysis.run", { id: "d2", raw: { companyId: "someone-else" } });
  });

  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  it("participation: funnel, idle-capped median, identified share, reminders, drop-off", async () => {
    const p = await get<{
      k: number;
      campaigns: { open: number; total: number };
      funnel: Record<string, number>;
      medianActiveSeconds: number | null;
      medianSessions: number;
      identified: { identified: number | null; anonymous: number | null; share: number | null };
      reminders: { sent: number; invitationsReminded: number };
      dropOff: { areas: { areaKey: string; sessions: number }[]; other: number; unfinished: number };
    }>(`/stats/participation?campaignId=${campaignId}`);
    // Invited: three (the revoked one is not). Started: 5 completed + consented + 6 active, minus
    // none for `created`: the holder session of the storage fixture is one of the completed.
    expect(p.funnel).toMatchObject({ invited: 3, opened: 2, completed: 5, started: 12 });
    // The ten-day pause counts as five minutes: (200 + 300) / 2 = 250 over 4 finished interviews
    // that have messages; the holder has none and is not in the median.
    expect(p.medianActiveSeconds).toBe(250);
    expect(p.medianSessions).toBe(4);
    // identified: A, B, C; anonymous: D, the consented one, the holder, six active interviews.
    expect(p.identified.identified).toBe(3);
    expect(p.identified.anonymous).toBe(9);
    expect(p.identified.share).toBe(0.25);
    expect(p.reminders).toEqual({ sent: 8, invitationsReminded: 3 });
    // 3 in "tasks" stay (>= k = 3); the 2 in "context" are pooled, not named.
    expect(p.dropOff.areas.map((a) => [a.areaKey, a.sessions])).toEqual([["tasks", 3]]);
    expect(p.dropOff).toMatchObject({ other: 2, unfinished: 5 });
  });

  it("withholds what is derived from fewer than k interviews", async () => {
    const p = await get<{
      medianActiveSeconds: number | null;
      medianSessions: number;
      identified: { share: number | null; withheld?: string };
      withheld?: string;
    }>(`/stats/participation?campaignId=${otherCampaignId}`);
    // One finished interview: its length would be that person's.
    expect(p.medianSessions).toBe(1);
    expect(p.medianActiveSeconds).toBeNull();
    expect(p.withheld).toBe("below_k");
    expect(p.identified.share).toBeNull();
    expect(p.identified.withheld).toBe("below_k");
  });

  it("requirements: sessions by status, turns to spec without the legacy sentinel, findings", async () => {
    const r = await get<{
      projectsByStatus: Record<string, number>;
      turnsToSpec: { median: number | null; mean: number | null; sessions: number };
      findings: {
        raised: number;
        resolved: number;
        resolvedRatio: number | null;
        byType: Record<string, number>;
      };
      specVersions: number;
    }>("/stats/requirements");
    expect(r.projectsByStatus).toMatchObject({ completed: 3, active: 1 });
    expect(r.turnsToSpec).toEqual({ median: 15, mean: 15, sessions: 2 });
    expect(r.findings).toEqual({
      raised: 4,
      resolved: 2,
      resolvedRatio: 0.5,
      byType: { ambiguity: 2, contradiction: 1, missing_decision: 1 },
    });
    expect(r.specVersions).toBe(2);
    // A member sees their own projects only.
    const mine = await get<typeof r>("/stats/requirements", memberToken);
    expect(mine.projectsByStatus).toEqual({ active: 1 });
    expect(mine.findings.raised).toBe(0);
  });

  it("ai: percentiles by purpose over answered calls, and the outcome split", async () => {
    const a = await get<{
      calls: number;
      latency: {
        purpose: string;
        calls: number;
        fullMs: { p50: number; p95: number };
        firstTokenMs: unknown;
      }[];
      outcomes: Record<string, number>;
      errorRate: number;
      refusalRate: number;
      failureRate: number;
      tokensPerInterview: number;
      interviews: number;
    }>("/stats/ai");
    const turn = a.latency.find((l) => l.purpose === "interview_turn");
    // 100, 200 ... 2000: the median is between 1000 and 1100, the 95th at index 18.05.
    expect(turn).toMatchObject({ calls: 20, fullMs: { p50: 1050, p95: 1905 } });
    expect(turn?.firstTokenMs).toBeNull();
    expect(a.calls).toBe(25);
    expect(a.outcomes).toEqual({ ok: 20, error: 2, refused: 1, budgetExceeded: 1, aborted: 1 });
    expect(a.errorRate).toBe(0.08);
    expect(a.refusalRate).toBe(0.04);
    // An abort is the person cancelling, not a failure: (2 + 1 + 1) / 25.
    expect(a.failureRate).toBe(0.16);
    // 20 calls x (100 + 50) tokens over the 6 interviews that ended in the window.
    expect(a.interviews).toBe(6);
    expect(a.tokensPerInterview).toBe(500);
  });

  it("discovery: newest finished analysis per campaign, dismissed left out, the report's predicate", async () => {
    const d = await get<{
      byClass: Record<string, number>;
      notAi: number;
      top: { title: string; solutionClass: string }[];
      evidence: { analyses: number; opportunities: number };
    }>("/stats/discovery");
    expect(d.byClass).toEqual({ ai: 0, automation: 1, software: 1, process: 1, none: 1 });
    expect(d.notAi).toBe(2);
    expect(d.top.map((t) => t.title)).toEqual(["Prelim", "Auto high", "Process mid", "None low"]);
    expect(d.evidence).toMatchObject({ analyses: 2, opportunities: 4 });
    // The dashboard's own payload carries the same tile data.
    const dash = await get<{ discovery: { notAi: number } }>("/stats");
    expect(dash.discovery.notAi).toBe(2);
    // A member does not see a preliminary analysis unless the organization allows it.
    const member = await get<{ byClass: Record<string, number> }>("/stats/discovery", memberToken);
    expect(member.byClass.software).toBe(0);
  });

  it("health: queue depth from the job port, this organization's failures, storage by kind", async () => {
    Object.assign(world.jobAdmin, {
      list: async () => [
        {
          name: "analysis.run",
          queued: 3,
          active: 1,
          deadLettered: 2,
          oldestQueuedAt: null,
          expireInSeconds: 1,
          retryLimit: 1,
          lastFailure: null,
          runNow: false,
        },
      ],
    });
    const h2 = await get<{
      depth: { queued: number; active: number };
      failedJobs: number;
      storage: {
        bytes: number;
        files: number;
        byKind: Record<string, { bytes: number; files: number }>;
        quotaBytes: number;
      };
    }>("/stats/health");
    expect(h2.depth).toEqual({ queued: 3, active: 1 });
    expect(h2.failedJobs).toBe(1);
    expect(h2.storage).toMatchObject({
      bytes: 3500,
      files: 3,
      byKind: { audio: { bytes: 3000, files: 2 }, document: { bytes: 500, files: 1 } },
      quotaBytes: 5120 * 1024 * 1024,
    });
    // Queue depth is the platform's: not for a member.
    const denied = await world.app.inject({
      method: "GET",
      url: "/api/v1/stats/health",
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(denied.statusCode).toBe(403);
  });

  it("another organization's rows change none of these numbers", async () => {
    const before = await get<unknown>("/stats/participation");
    // The window is "the last 30 days from now", so it moves between two calls; the numbers do not.
    const beforeAi = { ...(await get<object>("/stats/ai")), window: null };
    const company = await world.db.company.create({ data: { name: `Other ${Date.now()}` } });
    const template = await world.db.interviewTemplate.create({
      data: {
        companyId: company.id,
        key: `k-${Date.now()}`,
        name: "t",
        objective: "o",
        privacyMode: "anonymous",
      },
    });
    const provider = await world.db.provider.findFirstOrThrow();
    for (let i = 0; i < 6; i++) {
      await world.db.session.create({
        data: { companyId: company.id, templateId: template.id, status: "completed", identified: true },
      });
      await world.db.llmCall.create({
        data: {
          companyId: company.id,
          purpose: "interview_turn",
          providerId: provider.id,
          model: "m",
          inputTokens: 1_000_000,
          outputTokens: 1,
          latencyMs: 99_999,
          status: "error",
          costCents: 0,
        },
      });
    }
    expect(await get<unknown>("/stats/participation")).toEqual(before);
    expect({ ...(await get<object>("/stats/ai")), window: null }).toEqual(beforeAi);
  });
});
