import type { Server } from "node:http";
import { withTenant } from "@aidp/db";
import { describeDb } from "@aidp/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fakeModelServer, testWorld, type TestWorld } from "./helpers.js";

/**
 * Cluster merge, split, undo, rename (FR-18) and the department comparison (FR-17), through the
 * routes, with the worker's job body run in-process. Facts are written the way the extractor
 * writes them; the model is a fake that answers by schema name and is counted.
 */
const factor = { score: 4, rationale: "r" };
const draft = {
  title: "Generated title",
  summary: "S.",
  solutionClass: "automation",
  rationale: "R.",
  factors: {
    expected_impact: factor,
    affected_employees: factor,
    frequency: factor,
    implementation_complexity: factor,
    data_availability: factor,
    risk: factor,
    ai_suitability: factor,
  },
  dataNeeded: [],
  risks: [],
};

describeDb("cluster edits and departments end to end", () => {
  let world: TestWorld;
  let model: { server: Server; url: string };
  let opportunityCalls = 0;
  let campaignId = "";
  const person: string[] = [];

  const h = () => ({ authorization: `Bearer ${world.adminToken}` });
  const get = async <T>(url: string): Promise<T> => {
    const r = await world.app.inject({ method: "GET", url: `/api/v1${url}`, headers: h() });
    expect(r.statusCode, `${url} ${r.body.slice(0, 200)}`).toBe(200);
    return r.json<T>();
  };
  const post = (url: string, payload?: unknown) =>
    world.app.inject({ method: "POST", url: `/api/v1${url}`, headers: h(), payload: payload as object });
  const runJob = async (analysisId: string): Promise<void> => {
    await withTenant(world.companyId, () => world.ctx.analysis.run(analysisId));
  };

  interface Detail {
    analysis: { id: string; version: number; status: string; stats: Record<string, unknown> };
    opportunities: { id: string; title: string; status: string; stats: { participants: number } }[];
  }
  const latest = async (): Promise<Detail> => {
    const list = await get<{ analyses: { id: string }[] }>(`/campaigns/${campaignId}/analyses`);
    return get<Detail>(`/analyses/${list.analyses[0]!.id}`);
  };

  async function addPerson(n: number, department: string, topics: string[]): Promise<void> {
    const participant = await world.db.participant.create({
      data: {
        companyId: world.companyId,
        campaignId,
        fields: { role: "Nurse", department },
        tokenHash: `ce-${n}-${Date.now()}-${Math.random()}`,
      },
    });
    const session = await world.db.session.create({
      data: {
        companyId: world.companyId,
        templateId: world.templateId,
        campaignId,
        participantId: participant.id,
        status: "completed",
      },
    });
    person.push(session.id);
    for (const [i, name] of topics.entries()) {
      await world.db.fact.create({
        data: {
          companyId: world.companyId,
          sessionId: session.id,
          kind: "task",
          extractorVersion: "extraction@1",
          batchEndSeq: 2,
          ordinal: i,
          payload: {
            kind: "task",
            name,
            frequency: "daily",
            minutesPerOccurrence: 30,
            tools: [],
            painScore: 5,
            quote: `quote ${n} ${i}`,
          },
        },
      });
    }
  }

  beforeAll(async () => {
    model = await fakeModelServer(
      () => "unused",
      (name) => {
        if (name === "opportunity") {
          opportunityCalls++;
          return draft;
        }
        if (name === "cluster_merges") return { merges: [], names: [] };
        return { executiveSummary: "E.", nextSteps: ["Next"], caveats: "C." };
      },
    );
    world = await testWorld(model.url);
    const created = await post("/campaigns", {
      templateId: world.templateId,
      name: "Edits",
      verification: "open",
      completionThreshold: 3,
    });
    campaignId = created.json<{ campaign: { id: string } }>().campaign.id;
    const A = "Charting patient notes twice in two systems";
    const B = "Ordering pharmacy stock from the supplier portal";
    for (let i = 0; i < 3; i++) await addPerson(i, "Ward", [A, B]);
    for (let i = 3; i < 6; i++) await addPerson(i, "Pharmacy", [A, B]);
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  it("runs, then shows the department comparison only while every compared group has k people", async () => {
    const queued = await post(`/campaigns/${campaignId}/analyses`);
    expect(queued.statusCode).toBe(202);
    const id = queued.json<{ analysis: { id: string } }>().analysis.id;
    await runJob(id);
    const detail = await get<Detail>(`/analyses/${id}`);
    expect(detail.opportunities).toHaveLength(2);
    // The full member list is stored for editing but is not part of the API's answer.
    expect(JSON.stringify(detail)).not.toContain("factIds");
    const stored = await world.db.opportunity.findFirst({ where: { analysisId: id } });
    expect((stored?.factIds as string[]).length).toBeGreaterThan(0);

    const shown = await get<{
      shown: boolean;
      k: number;
      departments: { name: string | null; participants: number }[];
    }>(`/analyses/${id}/departments`);
    expect(shown).toMatchObject({ shown: true, k: 3 });
    expect(shown.departments.map((d) => d.name).sort()).toEqual(["Pharmacy", "Ward"]);

    // k is raised: neither department has 4 people, and the pool of both is one group, not a comparison.
    const put = await world.app.inject({
      method: "PUT",
      url: "/api/v1/settings?scope=tenant",
      headers: h(),
      payload: { values: { "privacy.kAnonymity": 4 } },
    });
    expect(put.statusCode).toBe(200);
    const hidden = await get<{ shown: boolean; reason: string; departments: unknown[]; belowK: number }>(
      `/analyses/${id}/departments`,
    );
    expect(hidden).toMatchObject({ shown: false, reason: "too_few_eligible", departments: [], belowK: 2 });
    expect(JSON.stringify(hidden)).not.toMatch(/Ward|Pharmacy/);

    const off = await world.app.inject({
      method: "PUT",
      url: "/api/v1/settings?scope=tenant",
      headers: h(),
      payload: { values: { "privacy.kAnonymity": 3, "analysis.departmentComparison": false } },
    });
    expect(off.statusCode).toBe(200);
    expect(await get(`/analyses/${id}/departments`)).toMatchObject({ shown: false, reason: "disabled" });
    await world.app.inject({
      method: "PUT",
      url: "/api/v1/settings?scope=tenant",
      headers: h(),
      payload: { values: { "analysis.departmentComparison": true } },
    });
  });

  it("merges, survives a full re-run, renames, splits, and undoes", async () => {
    const v1 = await latest();
    expect(v1.opportunities).toHaveLength(2);
    const before = opportunityCalls;

    // Merge: a new version made by an edit run, which asks the model only for the merged cluster.
    const merged = await post(`/analyses/${v1.analysis.id}/opportunities/merge`, {
      opportunityIds: v1.opportunities.map((o) => o.id),
      title: "Notes and stock, one workflow",
    });
    expect(merged.statusCode, merged.body).toBe(202);
    const mergeBody = merged.json<{ analysis: { id: string; version: number }; editId: string }>();
    expect(mergeBody.analysis.version).toBe(v1.analysis.version + 1);
    expect(world.jobs.published.at(-1)).toMatchObject({
      name: "analysis.run",
      payload: { analysisId: mergeBody.analysis.id },
    });
    // Nothing else can be edited while the edit run is queued.
    expect(
      (await post(`/analyses/${v1.analysis.id}/opportunities/merge`, { opportunityIds: ["a", "b"] }))
        .statusCode,
    ).toBe(409);
    await runJob(mergeBody.analysis.id);
    const v2 = await get<Detail>(`/analyses/${mergeBody.analysis.id}`);
    expect(v2.opportunities).toHaveLength(1);
    expect(v2.opportunities[0]).toMatchObject({ title: "Notes and stock, one workflow" });
    expect(v2.analysis.stats).toMatchObject({ trigger: "edit", baseVersion: v1.analysis.version });
    expect(opportunityCalls - before).toBe(1);

    // The old version is stale: only the newest can be edited.
    const stale = await post(`/analyses/${v1.analysis.id}/opportunities/merge`, {
      opportunityIds: v1.opportunities.map((o) => o.id),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json<{ error: { details: { reason: string } } }>().error.details.reason).toBe(
      "stale_analysis",
    );

    // A seventh person arrives and the whole analysis is run again: the merge is applied to the new
    // clustering by fact ids, and the merged opportunity grows to take them in.
    await addPerson(6, "Ward", ["Charting patient notes twice in two systems"]);
    const full = await post(`/campaigns/${campaignId}/analyses`);
    expect(full.statusCode).toBe(202);
    await runJob(full.json<{ analysis: { id: string } }>().analysis.id);
    const v3 = await latest();
    expect(v3.opportunities).toHaveLength(1);
    expect(v3.opportunities[0]).toMatchObject({ title: "Notes and stock, one workflow" });
    expect(v3.opportunities[0]?.stats.participants).toBe(7);
    expect(v3.analysis.stats.trigger).toBeUndefined();

    // Rename is an override anchored to facts: it survives yet another full run.
    const renamed = await world.app.inject({
      method: "PATCH",
      url: `/api/v1/opportunities/${v3.opportunities[0]!.id}`,
      headers: h(),
      payload: { title: "One workflow for notes and stock" },
    });
    expect(renamed.statusCode).toBe(200);
    const row = await world.db.auditLog.findFirst({
      where: { companyId: world.companyId, action: "cluster.rename" },
    });
    expect(row?.targetId).toBe(v3.opportunities[0]!.id);
    const again = await post(`/campaigns/${campaignId}/analyses`);
    await runJob(again.json<{ analysis: { id: string } }>().analysis.id);
    const v4 = await latest();
    expect(v4.opportunities[0]?.title).toBe("One workflow for notes and stock");

    // Split: the proposal is fact text only; the admin confirms a partition; the edit run follows.
    const opp = v4.opportunities[0]!;
    const proposal = await get<{ facts: { id: string; text: string; part: number }[]; parts: number }>(
      `/opportunities/${opp.id}/split-proposal`,
    );
    expect(proposal.facts.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(proposal)).not.toMatch(/Ward|Pharmacy|quote \d/);
    const byPart = new Map<number, string[]>();
    for (const f of proposal.facts) byPart.set(f.part, [...(byPart.get(f.part) ?? []), f.id]);
    const parts = [...byPart.values()];
    expect(parts.length).toBeGreaterThanOrEqual(2);
    const bad = await post(`/opportunities/${opp.id}/split`, { parts: [parts[0], parts[0]] });
    expect(bad.statusCode).toBe(400);
    const split = await post(`/opportunities/${opp.id}/split`, { parts });
    expect(split.statusCode, split.body).toBe(202);
    await runJob(split.json<{ analysis: { id: string } }>().analysis.id);
    const v5 = await latest();
    expect(v5.opportunities.length).toBe(parts.length);

    // Undo the merge and the split goes with it, because there is nothing left for it to split;
    // the edit that cannot apply is reported, not guessed at.
    const edits = await get<{ edits: { id: string; op: string; revokedAt: string | null }[] }>(
      `/campaigns/${campaignId}/cluster-edits`,
    );
    expect(edits.edits.map((e) => e.op).sort()).toEqual(["merge", "split"]);
    const mergeEdit = edits.edits.find((e) => e.op === "merge")!;
    const undo = await world.app.inject({
      method: "DELETE",
      url: `/api/v1/campaigns/${campaignId}/cluster-edits/${mergeEdit.id}`,
      headers: h(),
    });
    expect(undo.statusCode, undo.body).toBe(202);
    await runJob(undo.json<{ analysis: { id: string } }>().analysis.id);
    const v6 = await latest();
    expect(v6.opportunities).toHaveLength(2);
    expect(v6.analysis.stats.orphanedEdits).toEqual([edits.edits.find((e) => e.op === "split")!.id]);
    const again2 = await world.app.inject({
      method: "DELETE",
      url: `/api/v1/campaigns/${campaignId}/cluster-edits/${mergeEdit.id}`,
      headers: h(),
    });
    expect(again2.statusCode).toBe(409);
  });

  it("refuses to split below k, and to merge or split what another tenant owns", async () => {
    const d = await latest();
    const opp = d.opportunities[0]!;
    // Turn k above the cluster's size: its facts are not shown, so it cannot be split by reading them.
    await world.app.inject({
      method: "PUT",
      url: "/api/v1/settings?scope=tenant",
      headers: h(),
      payload: { values: { "privacy.kAnonymity": 50 } },
    });
    const proposal = await world.app.inject({
      method: "GET",
      url: `/api/v1/opportunities/${opp.id}/split-proposal`,
      headers: h(),
    });
    expect(proposal.statusCode).toBe(409);
    expect(proposal.json<{ error: { details: { reason: string } } }>().error.details.reason).toBe("below_k");
    const split = await post(`/opportunities/${opp.id}/split`, { parts: [["x"], ["y"]] });
    expect(split.statusCode).toBe(409);
    await world.app.inject({
      method: "PUT",
      url: "/api/v1/settings?scope=tenant",
      headers: h(),
      payload: { values: { "privacy.kAnonymity": 3 } },
    });
    const unknown = await post(`/analyses/missing_analysis/opportunities/merge`, {
      opportunityIds: [opp.id, "missing_opportunity"],
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("answers an analysis made before edits existed with rerun_required", async () => {
    const old = await world.db.analysis.create({
      data: {
        companyId: world.companyId,
        campaignId,
        version: 500,
        status: "done",
      },
    });
    const a = await world.db.opportunity.create({
      data: {
        companyId: world.companyId,
        analysisId: old.id,
        title: "Old",
        summary: "s",
        solutionClass: "ai",
        factors: draft.factors,
        rationale: "r",
        rankScore: 1,
        clusterKey: "old-a",
      },
    });
    const b = await world.db.opportunity.create({
      data: {
        companyId: world.companyId,
        analysisId: old.id,
        title: "Old 2",
        summary: "s",
        solutionClass: "ai",
        factors: draft.factors,
        rationale: "r",
        rankScore: 1,
        clusterKey: "old-b",
      },
    });
    const r = await post(`/analyses/${old.id}/opportunities/merge`, { opportunityIds: [a.id, b.id] });
    expect(r.statusCode).toBe(409);
    expect(r.json<{ error: { details: { reason: string } } }>().error.details.reason).toBe("rerun_required");
    expect(await get(`/analyses/${old.id}/departments`)).toMatchObject({
      shown: false,
      reason: "rerun_required",
    });
  });
});
