import type { Server } from "node:http";
import { withTenant } from "@aidp/db";
import { describeDb } from "@aidp/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fakeModelServer, testWorld, type TestWorld } from "./helpers.js";

const suite = describeDb;

const factors = (simplicity: number, ai: number) => ({
  expected_impact: { score: 4, rationale: "r" },
  affected_employees: { score: 3, rationale: "r" },
  frequency: { score: 5, rationale: "r" },
  implementation_complexity: { score: simplicity, rationale: "r" },
  data_availability: { score: 4, rationale: "r" },
  risk: { score: 4, rationale: "r" },
  ai_suitability: { score: ai, rationale: "r" },
});

suite("analysis end to end", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };

  beforeAll(async () => {
    model = await fakeModelServer(
      () => "unused",
      (name, content) => {
        if (name === "clusters") {
          const ids = [...content.matchAll(/\[([a-z0-9]+)\]/g)].map((m) => String(m[1]));
          return {
            clusters: [
              {
                key: "double_entry",
                name: "Double entry of notes",
                summary: "Notes typed twice.",
                factIds: ids,
              },
            ],
          };
        }
        if (name === "opportunity")
          return {
            title: "Single entry of notes",
            summary: "S.",
            solutionClass: "automation",
            rationale: "R.",
            factors: factors(4, 2),
            dataNeeded: ["export"],
            risks: [],
          };
        return { executiveSummary: "E.", nextSteps: ["Single entry of notes"], caveats: "C." };
      },
    );
    world = await testWorld(model.url);
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  it("queues below the threshold as preliminary, runs, ranks, applies overrides, and promotes into a requirements session", async () => {
    const { app, adminToken, db } = world;
    const h = { authorization: `Bearer ${adminToken}` };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: h,
      payload: {
        templateId: world.templateId,
        name: "Analysis run",
        verification: "open",
        completionThreshold: 5,
      },
    });
    const { campaign } = created.json<{ campaign: { id: string } }>();

    // Three completed sessions with extracted facts, written the way the worker writes them.
    for (let i = 0; i < 3; i++) {
      const participant = await db.participant.create({
        data: {
          companyId: world.companyId,
          campaignId: campaign.id,
          fields: { role: i < 2 ? "Nurse" : "Doctor" },
          tokenHash: `h${i}-${Date.now()}`,
        },
      });
      const session = await db.session.create({
        data: {
          companyId: world.companyId,
          templateId: world.templateId,
          campaignId: campaign.id,
          participantId: participant.id,
          status: "completed",
        },
      });
      await db.fact.create({
        data: {
          companyId: world.companyId,
          sessionId: session.id,
          kind: "task",
          extractorVersion: "extraction@1",
          batchEndSeq: 2,
          ordinal: 0,
          payload: {
            kind: "task",
            name: `Charting notes twice ${i}`,
            frequency: "daily",
            minutesPerOccurrence: 30,
            tools: ["Excel"],
            painScore: 6,
            quote: `I type every note twice on shift ${i}`,
          },
        },
      });
      // What the participant said. The third did not say their quote: it was invented, and the
      // check against the transcript leaves it out (D-478).
      await db.message.create({
        data: {
          companyId: world.companyId,
          sessionId: session.id,
          seq: 1,
          role: "user",
          content:
            i < 2
              ? `Honestly? I type every note twice on shift ${i}, once in each system.`
              : "We mostly chart once, then the spreadsheet is filled in by someone else.",
        },
      });
    }

    const queued = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaign.id}/analyses`,
      headers: h,
    });
    expect(queued.statusCode).toBe(202);
    const { analysis } = queued.json<{ analysis: { id: string; status: string; preliminary: boolean } }>();
    expect(analysis).toMatchObject({ status: "queued", preliminary: true });
    expect(world.jobs.published.at(-1)).toMatchObject({
      name: "analysis.run",
      payload: { analysisId: analysis.id },
    });
    expect(
      (await app.inject({ method: "POST", url: `/api/v1/campaigns/${campaign.id}/analyses`, headers: h }))
        .statusCode,
    ).toBe(409);

    // The worker's job body.
    await withTenant(world.companyId, () => world.ctx.analysis.run(analysis.id));

    const result = await app.inject({ method: "GET", url: `/api/v1/analyses/${analysis.id}`, headers: h });
    expect(result.statusCode).toBe(200);
    const body = result.json<{
      analysis: { status: string; stats: Record<string, unknown> };
      opportunities: {
        id: string;
        clusterKey: string;
        rankScore: number;
        stats: { participants: number; sessions: number; quotes: string[] };
        evidence: { kind: string; snippet: string }[];
        status: string;
      }[];
      report: { markdown: string; review: { status: string; reviewedBy: string | null } } | null;
    }>();
    expect(body.analysis.status).toBe("done");
    expect(body.analysis.stats).toMatchObject({
      facts: 3,
      clusters: 1,
      embedding: "lexical",
      thresholdMet: false,
      started: 3,
      verification: { quotesChecked: 3, quotesVerified: 2, quotesDropped: 1 },
    });
    expect(body.opportunities).toHaveLength(1);
    const opp = body.opportunities[0]!;
    expect(opp.stats.participants).toBe(3);
    expect(opp.stats.sessions).toBe(3);
    // k = 3 is met, so quotes are shown: the two that were said, not the invented one.
    expect(opp.stats.quotes).toEqual([
      "I type every note twice on shift 0",
      "I type every note twice on shift 1",
    ]);
    expect(opp.evidence.map((e) => e.kind)).toEqual(["quote", "quote", "paraphrase"]);
    expect(JSON.stringify(opp.evidence)).not.toContain("shift 2");
    expect(opp.rankScore).toBeGreaterThan(50);
    expect(body.report?.markdown).toContain("Single entry of notes");
    expect(body.report?.markdown).toContain("**Based on 3 completed interviews.**");
    expect(body.report?.markdown).toContain("Mentioned in 3 of 3 interviews");
    expect(body.report?.markdown).toContain("1 quote could not be verified and was left out");
    expect(body.report?.markdown).toContain("**Small sample.** The campaign set 5 completed interviews");

    // Review (D-478): a new version is a draft; an administrator marks it reviewed.
    expect(body.report?.review).toEqual({ status: "draft", reviewedBy: null, reviewedAt: null });
    const reviewed = await app.inject({
      method: "POST",
      url: `/api/v1/analyses/${analysis.id}/review`,
      headers: h,
      payload: { status: "reviewed" },
    });
    expect(reviewed.statusCode).toBe(200);
    expect(reviewed.json<{ review: { status: string; reviewedBy: string } }>().review).toMatchObject({
      status: "reviewed",
      reviewedBy: expect.any(String),
    });
    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${campaign.id}/analyses`,
      headers: h,
    });
    expect(listed.json<{ analyses: { review?: { status: string } }[] }>().analyses[0]?.review?.status).toBe(
      "reviewed",
    );

    // Override: title and a factor; rank re-computed; then status and promotion.
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/opportunities/${opp.id}`,
      headers: h,
      payload: {
        title: "One place for notes",
        factors: { expected_impact: { score: 5, rationale: "whole ward" } },
        note: "checked with the ward lead",
      },
    });
    expect(patched.statusCode).toBe(200);
    const after = patched.json<{
      opportunity: { title: string; rankScore: number; adminOverride: { note: string } };
    }>().opportunity;
    expect(after.title).toBe("One place for notes");
    expect(after.rankScore).toBeGreaterThan(opp.rankScore);
    expect(after.adminOverride.note).toBe("checked with the ward lead");
    // The reviewed report no longer says what the version says: it is a draft again.
    const reread = await app.inject({ method: "GET", url: `/api/v1/analyses/${analysis.id}`, headers: h });
    expect(reread.json<{ report: { review: { status: string } } }>().report.review.status).toBe("draft");

    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/opportunities/${opp.id}/status`,
          headers: h,
          payload: { status: "shortlisted" },
        })
      ).json<{ opportunity: { status: string } }>().opportunity.status,
    ).toBe("shortlisted");

    await db.interviewTemplate
      .create({
        data: {
          companyId: null,
          key: "requirements_discovery",
          version: 1,
          name: "Req",
          objective: "o",
          privacyMode: "identified",
          coverageAreas: [{ key: "problem", name: "P", description: "d", doneWhen: "w" }],
          outputs: ["spec_field"],
          status: "published",
        },
      })
      .catch(() => undefined);
    const promoted = await app.inject({
      method: "POST",
      url: `/api/v1/opportunities/${opp.id}/promote`,
      headers: h,
    });
    expect(promoted.statusCode).toBe(200);
    const { session, handoff } = promoted.json<{
      session: { id: string; templateKey: string };
      handoff: { problem: string; tools: string[]; evidenceQuotes: string[] };
    }>();
    expect(session.templateKey).toBe("requirements_discovery");
    expect(handoff.tools).toEqual(["Excel"]);
    expect(handoff.evidenceQuotes).toHaveLength(2);
    const row = await db.session.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.sourceKind).toBe("handoff");
    expect((await db.opportunity.findUniqueOrThrow({ where: { id: opp.id } })).status).toBe("promoted");

    // A second run keeps the override by cluster key and the diff sees the rename as unchanged.
    const again = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaign.id}/analyses`,
      headers: h,
    });
    const second = again.json<{ analysis: { id: string } }>().analysis;
    await withTenant(world.companyId, () => world.ctx.analysis.run(second.id));
    const v2 = await app.inject({ method: "GET", url: `/api/v1/analyses/${second.id}`, headers: h });
    expect(v2.json<{ opportunities: { title: string }[] }>().opportunities[0]?.title).toBe(
      "One place for notes",
    );
    const diff = await app.inject({
      method: "GET",
      url: `/api/v1/analyses/${second.id}/diff/${analysis.id}`,
      headers: h,
    });
    expect(diff.json<{ added: unknown[]; removed: unknown[]; changed: unknown[] }>()).toMatchObject({
      added: [],
      removed: [],
    });
  });

  it("returns no quotes, tools or evidence text for a cluster below k, and keeps the report free of them", async () => {
    const { app, adminToken, db } = world;
    const h = { authorization: `Bearer ${adminToken}` };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: h,
      payload: { templateId: world.templateId, name: "Small campaign", verification: "open" },
    });
    const { campaign } = created.json<{ campaign: { id: string } }>();
    // Two participants against a k of three: every cluster they form is below it.
    for (let i = 0; i < 2; i++) {
      const participant = await db.participant.create({
        data: {
          companyId: world.companyId,
          campaignId: campaign.id,
          fields: { role: "Nurse" },
          tokenHash: `small${i}-${Date.now()}`,
        },
      });
      const session = await db.session.create({
        data: {
          companyId: world.companyId,
          templateId: world.templateId,
          campaignId: campaign.id,
          participantId: participant.id,
          status: "completed",
        },
      });
      await db.fact.create({
        data: {
          companyId: world.companyId,
          sessionId: session.id,
          kind: "task",
          extractorVersion: "extraction@1",
          batchEndSeq: 2,
          ordinal: 0,
          payload: {
            kind: "task",
            name: `Rekeying orders ${i}`,
            frequency: "daily",
            minutesPerOccurrence: 30,
            tools: ["SecretLabPortal"],
            painScore: 6,
            quote: `my private words ${i}`,
          },
        },
      });
    }
    const queued = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaign.id}/analyses`,
      headers: h,
    });
    const { analysis } = queued.json<{ analysis: { id: string } }>();
    await withTenant(world.companyId, () => world.ctx.analysis.run(analysis.id));

    const result = await app.inject({ method: "GET", url: `/api/v1/analyses/${analysis.id}`, headers: h });
    const body = result.json<{
      opportunities: {
        id: string;
        stats: { participants: number; quotes: string[]; tools: string[]; roles: string[] };
        evidence: unknown[];
      }[];
      report: { markdown: string };
    }>();

    const opp = body.opportunities[0]!;
    expect(opp.stats).toMatchObject({ participants: 2, quotes: [], tools: [], roles: [] });
    expect(opp.evidence).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("my private words");
    expect(JSON.stringify(body)).not.toContain("SecretLabPortal");
    // The rows exist, without text: the hand-off to a requirements session still follows them.
    const stored = await db.opportunityEvidence.findMany({ where: { opportunityId: opp.id } });
    expect(stored).toHaveLength(2);
    expect(stored.every((e) => e.snippet === "")).toBe(true);
  });
  it("makes the automatic run at the threshold one deliberate, visible, delayed version (D-324)", async () => {
    const { app, adminToken, db } = world;
    const h = { authorization: `Bearer ${adminToken}` };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: h,
      payload: {
        templateId: world.templateId,
        name: "Auto run",
        verification: "open",
        completionThreshold: 1,
      },
    });
    const { campaign } = created.json<{ campaign: { id: string } }>();
    const finish = async (i: number): Promise<void> => {
      const participant = await db.participant.create({
        data: {
          companyId: world.companyId,
          campaignId: campaign.id,
          fields: {},
          tokenHash: `auto${i}-${Date.now()}`,
        },
      });
      await db.session.create({
        data: {
          companyId: world.companyId,
          templateId: world.templateId,
          campaignId: campaign.id,
          participantId: participant.id,
          status: "completed",
        },
      });
    };

    // A burst: three interviews complete one after another past the threshold.
    const before = world.jobs.published.length;
    const results: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      await finish(i);
      results.push(
        await withTenant(world.companyId, () =>
          world.ctx.analysis.maybeQueueForCampaign(world.companyId, campaign.id),
        ),
      );
    }
    // One version, not three: the first completion scheduled it and the rest were absorbed.
    expect(results).toEqual([true, false, false]);
    const runs = await db.analysis.findMany({ where: { campaignId: campaign.id } });
    expect(runs).toHaveLength(1);
    // It says who started it and when it will start, and the job waits for that time.
    const stats = runs[0]?.stats as { trigger?: string; autoStartAt?: string };
    expect(stats.trigger).toBe("auto");
    expect(new Date(stats.autoStartAt ?? 0).getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);
    const job = world.jobs.published.slice(before).find((j) => j.name === "analysis.run");
    expect(job?.startAfterSeconds).toBe(5 * 60);

    // The owner still sees it in the list, as automatic and waiting.
    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${campaign.id}/analyses`,
      headers: h,
    });
    expect(listed.json<{ analyses: { stats: { trigger?: string } }[] }>().analyses[0]?.stats.trigger).toBe(
      "auto",
    );

    // A run the owner asks for carries no trigger and no wait.
    await db.analysis.update({ where: { id: runs[0]!.id }, data: { status: "done" } });
    const manual = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaign.id}/analyses`,
      headers: h,
    });
    expect(manual.statusCode).toBe(202);
    const manualRow = await db.analysis.findFirstOrThrow({
      where: { campaignId: campaign.id, version: 2 },
    });
    expect((manualRow.stats as { trigger?: string }).trigger).toBeUndefined();
    expect((manualRow.stats as { autoStartAt?: string }).autoStartAt).toBeUndefined();
  });
});
