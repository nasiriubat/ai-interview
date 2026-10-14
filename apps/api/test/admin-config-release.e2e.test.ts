import type { Server } from "node:http";
import { shippedTemplates, withTenant } from "@aidp/db";
import { DEFAULT_CONSENT_TEXT } from "@aidp/shared";
import { describeDb } from "@aidp/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

/**
 * The 2026.10 admin-configuration slice (D-180 to D-189): settings history and the operator-only
 * ceilings, notices to tenant admins, template versions and restore with their settings carried,
 * the voice and feature switches, the localized consent default, and tenant ceilings with the
 * onboarding checklist.
 */
suite("admin configuration, 2026.10", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };
  let admin: Record<string, string>;
  let operator: Record<string, string>;

  beforeAll(async () => {
    model = await fakeModelServer(
      () => "ready",
      (name, content) => {
        if (name === "clusters") {
          const ids = [...content.matchAll(/\[([a-z0-9]+)\]/g)].map((m) => String(m[1]));
          return { clusters: [{ key: "k", name: "Double entry", summary: "S.", factIds: ids }] };
        }
        if (name === "opportunity")
          return {
            title: "Single entry",
            summary: "S.",
            solutionClass: "automation",
            rationale: "R.",
            factors: factors(4, 2),
            dataNeeded: [],
            risks: [],
          };
        return { executiveSummary: "E.", nextSteps: ["Do it"], caveats: "C." };
      },
    );
    world = await testWorld(model.url);
    admin = { authorization: `Bearer ${world.adminToken}` };
    operator = { authorization: `Bearer ${world.operatorToken}` };
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  const call = (
    method: "GET" | "POST" | "PUT" | "PATCH",
    url: string,
    headers: Record<string, string>,
    payload?: unknown,
  ) =>
    world.app.inject({
      method,
      url: `/api/v1${url}`,
      headers,
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
  const putSettings = (values: Record<string, unknown>, query = "scope=tenant", as = admin) =>
    call("PUT", `/settings?${query}`, as, { values });

  /** A second tenant with its own admin, for the isolation assertions. */
  async function otherTenant(): Promise<Record<string, string>> {
    const { encode } = await import("@auth/core/jwt");
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const company = await world.db.company.create({ data: { name: `Other ${suffix}` } });
    const email = `other-${suffix}@test.io`;
    await world.db.user.create({ data: { companyId: company.id, email, role: "admin" } });
    const token = await encode({
      token: { email },
      secret: world.ctx.config.AUTH_SECRET,
      salt: "authjs.session-token",
    });
    return { authorization: `Bearer ${token}` };
  }

  async function openCampaign(
    name: string,
    templateId = world.templateId,
  ): Promise<{ id: string; link: string }> {
    const created = await call("POST", "/campaigns", admin, {
      templateId,
      name,
      verification: "open",
    });
    expect(created.statusCode).toBe(201);
    const body = created.json<{ campaign: { id: string }; link: { url: string } }>();
    await call("POST", `/campaigns/${body.campaign.id}/open`, admin);
    return { id: body.campaign.id, link: body.link.url.split("/p/")[1]! };
  }

  async function join(link: string): Promise<{ token: string; sessionId: string; status: number }> {
    const res = await world.app.inject({ method: "POST", url: `/api/v1/p/${link}/open`, payload: {} });
    const body = res.json<{ participantToken?: string; sessionId?: string }>();
    return {
      token: `Bearer pt.${body.participantToken ?? ""}`,
      sessionId: body.sessionId ?? "",
      status: res.statusCode,
    };
  }

  describe("settings history and operator-only keys", () => {
    it("lists who changed which keys, newest first, and never a value", async () => {
      await putSettings({ "campaign.completionThreshold": 7 });
      await putSettings({ "campaign.completionThreshold": 8, "privacy.kAnonymity": 4 });
      const res = await call("GET", "/settings/history?limit=10", admin);
      expect(res.statusCode).toBe(200);
      const body = res.json<{
        items: { at: string; scope: string; keys: string[]; actor: { email: string } | null }[];
      }>();
      expect(body.items[0]?.keys.sort()).toEqual(["campaign.completionThreshold", "privacy.kAnonymity"]);
      expect(body.items[0]?.actor?.email).toBe(world.adminEmail);
      expect(body.items[0]?.scope).toBe("tenant");
      expect(JSON.stringify(body)).not.toContain('"value"');
      expect(Date.parse(body.items[0]!.at)).toBeGreaterThanOrEqual(Date.parse(body.items[1]!.at));

      const filtered = await call("GET", "/settings/history?key=privacy.kAnonymity", admin);
      const items = filtered.json<{ items: { keys: string[] }[] }>().items;
      expect(items).toHaveLength(1);
      expect(items[0]?.keys).toContain("privacy.kAnonymity");
    });

    it("keeps one tenant's history from another, and platform history from a tenant admin", async () => {
      const other = await otherTenant();
      const theirs = await call("GET", "/settings/history", other);
      expect(theirs.statusCode).toBe(200);
      expect(theirs.json<{ items: unknown[] }>().items).toEqual([]);
      const platform = await call("GET", "/settings/history?scope=platform", admin);
      expect(platform.statusCode).toBe(403);
    });

    it("pages by the time of the last row", async () => {
      const first = await call("GET", "/settings/history?limit=1", admin);
      const page = first.json<{ items: { id: string }[]; next: string | null }>();
      expect(page.items).toHaveLength(1);
      expect(page.next).not.toBeNull();
      const second = await call(
        "GET",
        `/settings/history?limit=1&before=${encodeURIComponent(page.next!)}`,
        admin,
      );
      expect(second.json<{ items: { id: string }[] }>().items[0]?.id).not.toBe(page.items[0]?.id);
    });

    it("lets only the operator write a ceiling, at any scope", async () => {
      const refused = await putSettings({ "ceiling.maxActiveCampaigns": 99 });
      expect(refused.statusCode).toBe(403);
      expect(refused.body).toContain("platform operator");
      // Mixed with an allowed key, the whole save is refused: nothing lands.
      const mixed = await putSettings({ "ceiling.storageBytes": 1, "campaign.completionThreshold": 9 });
      expect(mixed.statusCode).toBe(403);
      const stored = await world.db.setting.findMany({
        where: {
          scopeId: world.companyId,
          key: { in: ["ceiling.storageBytes", "campaign.completionThreshold"] },
        },
      });
      expect(stored.find((s) => s.key === "ceiling.storageBytes")).toBeUndefined();

      const ok = await putSettings(
        { "ceiling.maxActiveCampaigns": 50 },
        `scope=tenant&scopeId=${world.companyId}`,
        operator,
      );
      expect(ok.statusCode).toBe(200);
      // The catalog tells the screen which keys are read-only and when each appeared.
      const view = await call("GET", "/settings?scope=tenant", admin);
      const entry = view
        .json<{ catalog: { key: string; operatorOnly: boolean; since: string | null }[] }>()
        .catalog.find((c) => c.key === "ceiling.maxActiveCampaigns");
      expect(entry).toMatchObject({ operatorOnly: true, since: "2026.10" });
      await putSettings(
        { "ceiling.maxActiveCampaigns": null },
        `scope=tenant&scopeId=${world.companyId}`,
        operator,
      );
    });
  });

  describe("template versions, restore and the settings they carry", () => {
    let templateId: string;
    let baseBody: Record<string, unknown>;

    beforeAll(async () => {
      const t = shippedTemplates()[0]!;
      const row = await world.db.interviewTemplate.create({
        data: {
          companyId: world.companyId,
          key: "versions_probe",
          version: 1,
          name: "Probe v1",
          objective: t.objective,
          privacyMode: t.privacyMode,
          participantFields: t.participantFields,
          coverageAreas: t.coverageAreas,
          aiInstructions: t.aiInstructions,
          adaptivity: t.adaptivity,
          widgetPolicy: t.widgetPolicy,
          outputs: t.outputs,
          status: "published",
        },
      });
      templateId = row.id;
      baseBody = (await call("GET", `/templates/${templateId}`, admin)).json<Record<string, unknown>>();
    });

    const edit = async (id: string, name: string) =>
      call("PUT", `/templates/${id}`, admin, { ...baseBody, name });

    it("carries template-scoped settings to the next version on edit", async () => {
      // A campaign can only be made on a published row, so it is made before the first edit.
      const pinned = await call("POST", "/campaigns", admin, {
        templateId,
        name: "Pinned to v1",
        verification: "open",
      });
      expect(pinned.statusCode).toBe(201);
      const set = await putSettings({ "voice.voiceName": "alloy" }, `scope=template&scopeId=${templateId}`);
      expect(set.statusCode).toBe(200);
      const v2 = (await edit(templateId, "Probe v2")).json<{ id: string; version: number }>();
      expect(v2.version).toBe(2);
      const carried = await call("GET", `/settings?scope=template&scopeId=${v2.id}`, admin);
      expect(carried.json<{ values: Record<string, unknown> }>().values["voice.voiceName"]).toBe("alloy");
      // And the old row keeps its own: history is not rewritten.
      const old = await call("GET", `/settings?scope=template&scopeId=${templateId}`, admin);
      expect(old.json<{ values: Record<string, unknown> }>().values["voice.voiceName"]).toBe("alloy");
    });

    it("lists versions with what changed and how many campaigns hold each", async () => {
      const res = await call("GET", `/templates/${templateId}/versions`, admin);
      expect(res.statusCode).toBe(200);
      const { versions } = res.json<{
        versions: {
          id: string;
          version: number;
          latest: boolean;
          campaigns: number;
          changedFields: string[];
          createdBy: unknown;
        }[];
      }>();
      expect(versions.map((v) => v.version)).toEqual([2, 1]);
      expect(versions[0]).toMatchObject({ latest: true, campaigns: 0 });
      expect(versions[0]?.changedFields).toEqual(["name"]);
      expect(versions[1]).toMatchObject({ latest: false, campaigns: 1, changedFields: [] });
    });

    it("restores an old version as a new one, never touching history or pinned campaigns", async () => {
      const before = await world.db.interviewTemplate.findMany({
        where: { companyId: world.companyId, key: "versions_probe" },
        orderBy: { version: "asc" },
      });
      const v1 = before.find((r) => r.version === 1)!;
      const latest = before.find((r) => r.version === 2)!;
      const res = await call("POST", `/templates/${v1.id}/restore`, admin);
      expect(res.statusCode).toBe(201);
      const restored = res.json<{ id: string; version: number; name: string; status: string }>();
      expect(restored).toMatchObject({ version: 3, name: "Probe v1", status: "published" });

      const after = await world.db.interviewTemplate.findMany({
        where: { companyId: world.companyId, key: "versions_probe" },
        orderBy: { version: "asc" },
      });
      expect(after).toHaveLength(3);
      // v1 and v2 are exactly as they were, except that the previous latest is now archived.
      expect(after[0]).toEqual(v1);
      expect(after[1]).toEqual({ ...latest, status: "archived" });
      // The campaign pinned to v1 still holds v1.
      const pinned = await world.db.campaign.findFirstOrThrow({
        where: { companyId: world.companyId, name: "Pinned to v1" },
      });
      expect(pinned.templateId).toBe(v1.id);
      // Settings come from the version that was in force.
      const carried = await call("GET", `/settings?scope=template&scopeId=${restored.id}`, admin);
      expect(carried.json<{ values: Record<string, unknown> }>().values["voice.voiceName"]).toBe("alloy");

      const audit = await world.db.auditLog.findFirstOrThrow({
        where: { companyId: world.companyId, action: "template.restore" },
      });
      expect(audit.diff).toMatchObject({ fromVersion: 1, newVersion: 3 });
    });

    it("refuses to restore the current version, a platform template, or another tenant's", async () => {
      const latest = await world.db.interviewTemplate.findFirstOrThrow({
        where: { companyId: world.companyId, key: "versions_probe" },
        orderBy: { version: "desc" },
      });
      expect((await call("POST", `/templates/${latest.id}/restore`, admin)).statusCode).toBe(409);

      const platform = await world.db.interviewTemplate.findFirst({ where: { companyId: null } });
      if (platform) {
        expect((await call("POST", `/templates/${platform.id}/restore`, admin)).statusCode).toBe(403);
      }
      const other = await otherTenant();
      expect((await call("POST", `/templates/${latest.id}/restore`, other)).statusCode).toBe(404);
      expect((await call("GET", `/templates/${latest.id}/versions`, other)).statusCode).toBe(404);
    });

    it("lets a member read versions but not restore", async () => {
      const { encode } = await import("@auth/core/jwt");
      const email = `member-${Date.now().toString(36)}@test.io`;
      await world.db.user.create({ data: { companyId: world.companyId, email, role: "member" } });
      const token = await encode({
        token: { email },
        secret: world.ctx.config.AUTH_SECRET,
        salt: "authjs.session-token",
      });
      const member = { authorization: `Bearer ${token}` };
      expect((await call("GET", `/templates/${templateId}/versions`, member)).statusCode).toBe(200);
      expect((await call("POST", `/templates/${templateId}/restore`, member)).statusCode).toBe(403);
    });
  });

  describe("voice and feature switches", () => {
    it("ANDs the template's voice switch with the tenant's, in the view and on the route", async () => {
      const campaign = await openCampaign("Voice switch");
      const { token } = await join(campaign.link);
      const view = async () =>
        (
          await world.app.inject({
            method: "GET",
            url: "/api/v1/p/session",
            headers: { authorization: token },
          })
        ).json<{ session: { capabilities: { recordedVoice: boolean; liveVoice: boolean } } }>().session
          .capabilities;
      expect((await view()).recordedVoice).toBe(true);

      // Off at the template: the browser is told, and the route refuses with a feature code.
      await putSettings({ "voice.enabled": false }, `scope=template&scopeId=${world.templateId}`);
      expect((await view()).recordedVoice).toBe(false);
      const blocked = await world.app.inject({
        method: "POST",
        url: "/api/v1/p/session/voice-turns",
        headers: { authorization: token },
        payload: {},
      });
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json<{ error: { code: string } }>().error.code).toBe("feature_disabled");

      // On at the template cannot win against off at the tenant.
      await putSettings({ "voice.enabled": true }, `scope=template&scopeId=${world.templateId}`);
      await putSettings({ "voice.enabled": false });
      expect((await view()).recordedVoice).toBe(false);
      await putSettings({ "voice.enabled": null });
      await putSettings({ "voice.enabled": null }, `scope=template&scopeId=${world.templateId}`);
      expect((await view()).recordedVoice).toBe(true);
    });

    it("sends no widget and offers no options mode while features.optionsView is off", async () => {
      const campaign = await openCampaign("Options off");
      const { token, sessionId } = await join(campaign.link);
      await putSettings({ "features.optionsView": false });
      const view = await world.app.inject({
        method: "GET",
        url: "/api/v1/p/session",
        headers: { authorization: token },
      });
      expect(
        view.json<{ session: { capabilities: { optionsView: boolean } } }>().session.capabilities.optionsView,
      ).toBe(false);
      // The engine's template allows no widget, so the prompt says none and none is admitted.
      const session = await withTenant(world.companyId, async () => {
        const chain = [
          { scope: "template" as const, scopeId: world.templateId },
          { scope: "tenant" as const, scopeId: world.companyId },
        ];
        const bundle = await world.ctx.engines.forSession(world.companyId, chain, sessionId);
        return bundle.store.snapshot(sessionId);
      });
      expect(session.template.widgetPolicy).toMatchObject({ allowedTypes: [], maxPerTurns: 0 });
      await putSettings({ "features.optionsView": null });
      const on = await withTenant(world.companyId, async () => {
        const chain = [{ scope: "tenant" as const, scopeId: world.companyId }];
        const bundle = await world.ctx.engines.forSession(world.companyId, chain, sessionId);
        return bundle.store.snapshot(sessionId);
      });
      expect(on.template.widgetPolicy.maxPerTurns).toBeGreaterThan(0);
    });

    it("refuses promote and a chained template while features.chaining is off", async () => {
      const campaign = await openCampaign("Chaining");
      const analysis = await world.db.analysis.create({
        data: { companyId: world.companyId, campaignId: campaign.id, version: 1, status: "done" },
      });
      const opportunity = await world.db.opportunity.create({
        data: {
          companyId: world.companyId,
          analysisId: analysis.id,
          title: "O",
          summary: "s",
          solutionClass: "ai",
          factors: {},
          rationale: "r",
          rankScore: 1,
          clusterKey: "o",
        },
      });
      await putSettings({ "features.chaining": false });
      const promote = await call("POST", `/opportunities/${opportunity.id}/promote`, admin);
      expect(promote.statusCode).toBe(403);
      expect(promote.json<{ error: { code: string } }>().error.code).toBe("feature_disabled");

      const body = (await call("GET", `/templates/${world.templateId}`, admin)).json<
        Record<string, unknown>
      >();
      const chained = await call("POST", "/templates", admin, {
        ...body,
        key: "chain_probe",
        chainToKey: "requirements_discovery",
      });
      expect(chained.statusCode).toBe(403);
      const plain = await call("POST", "/templates", admin, {
        ...body,
        key: "chain_probe",
        chainToKey: null,
      });
      expect(plain.statusCode).toBe(201);

      await putSettings({ "features.chaining": null });
      const on = await call("POST", `/opportunities/${opportunity.id}/promote`, admin);
      expect(on.statusCode).not.toBe(403);
    });
  });

  describe("consent default", () => {
    it("is the Finnish text for a Finnish template and English otherwise, and an explicit text wins", async () => {
      const t = shippedTemplates()[0]!;
      const fi = await world.db.interviewTemplate.create({
        data: {
          companyId: world.companyId,
          key: "consent_fi",
          version: 1,
          name: "Suomi",
          language: "fi",
          objective: t.objective,
          privacyMode: t.privacyMode,
          participantFields: t.participantFields,
          coverageAreas: t.coverageAreas,
          aiInstructions: t.aiInstructions,
          adaptivity: t.adaptivity,
          widgetPolicy: t.widgetPolicy,
          outputs: t.outputs,
          status: "published",
        },
      });
      const finnish = await openCampaign("Consent fi", fi.id);
      const english = await openCampaign("Consent en");
      const read = async (link: string) =>
        (await world.app.inject({ method: "GET", url: `/api/v1/p/${link}` })).json<{
          campaign: { consentText: string; consentVersion: string };
        }>().campaign;

      const fiView = await read(finnish.link);
      const enView = await read(english.link);
      expect(fiView.consentText).toBe(DEFAULT_CONSENT_TEXT.fi);
      expect(enView.consentText).toBe(DEFAULT_CONSENT_TEXT.en);
      expect(fiView.consentVersion).not.toBe(enView.consentVersion);

      // Someone's own words are shown as written, whatever the template's language.
      await putSettings(
        { "campaign.consentText": "Our own consent text." },
        `scope=campaign&scopeId=${finnish.id}`,
      );
      const own = await read(finnish.link);
      expect(own.consentText).toBe("Our own consent text.");
      // The hash is of the words shown, so a stored version for that text stays valid.
      const again = await read(finnish.link);
      expect(again.consentVersion).toBe(own.consentVersion);
    });

    it("records the version a participant saw and keeps it when the words change", async () => {
      const campaign = await openCampaign("Consent record");
      const { token, sessionId } = await join(campaign.link);
      const shown = (await world.app.inject({ method: "GET", url: `/api/v1/p/${campaign.link}` })).json<{
        campaign: { consentVersion: string };
      }>().campaign.consentVersion;
      const res = await world.app.inject({
        method: "POST",
        url: "/api/v1/p/session/consent",
        headers: { authorization: token },
        payload: { consentVersion: shown },
      });
      expect(res.statusCode).toBeLessThan(300);
      await putSettings({ "campaign.consentText": "Edited words." }, `scope=campaign&scopeId=${campaign.id}`);
      const row = await world.db.session.findUniqueOrThrow({ where: { id: sessionId } });
      expect(row.consentVersion).toBe(shown);
      const now = (await world.app.inject({ method: "GET", url: `/api/v1/p/${campaign.link}` })).json<{
        campaign: { consentVersion: string };
      }>().campaign.consentVersion;
      expect(now).not.toBe(shown);
    });

    it("pins the template version of a session to the campaign's row", async () => {
      const campaign = await openCampaign("Pinned version");
      const { sessionId } = await join(campaign.link);
      const row = await world.db.session.findUniqueOrThrow({
        where: { id: sessionId },
        include: { template: true },
      });
      expect(row.templateVersion).toBe(row.template.version);
    });
  });

  describe("notices to a tenant's admins", () => {
    it("tells the admins once when a campaign reaches its threshold and again when its analysis is ready", async () => {
      const campaign = await openCampaign("Notice campaign");
      await putSettings({ "campaign.completionThreshold": 1 }, `scope=campaign&scopeId=${campaign.id}`);
      await world.db.campaign.update({ where: { id: campaign.id }, data: { completionThreshold: 1 } });
      const { sessionId } = await join(campaign.link);
      await world.db.fact.create({
        data: {
          companyId: world.companyId,
          sessionId,
          kind: "task",
          extractorVersion: "extraction@1",
          batchEndSeq: 2,
          ordinal: 0,
          payload: {
            kind: "task",
            name: "Charting twice",
            frequency: "daily",
            minutesPerOccurrence: 30,
            tools: ["Excel"],
            painScore: 6,
            quote: "q",
          },
        },
      });
      await world.db.session.update({ where: { id: sessionId }, data: { status: "completed" } });

      await withTenant(world.companyId, async () => {
        expect(await world.ctx.analysis.maybeQueueForCampaign(world.companyId, campaign.id)).toBe(true);
        // A second completion re-checks; the key is the campaign, so it is not a second notice.
        await world.ctx.analysis.maybeQueueForCampaign(world.companyId, campaign.id);
      });
      const thresholds = world.alerts.ofKind("campaign.threshold").filter((a) => a.key.endsWith(campaign.id));
      expect(thresholds.length).toBeGreaterThanOrEqual(1);
      expect(new Set(thresholds.map((a) => a.key)).size).toBe(1);
      expect(thresholds[0]).toMatchObject({ companyId: world.companyId });
      expect(thresholds[0]?.localized?.fi?.title).toContain("Haastatteluja on tarpeeksi");

      const queued = await world.db.analysis.findFirstOrThrow({ where: { campaignId: campaign.id } });
      await withTenant(world.companyId, () => world.ctx.analysis.run(queued.id));
      const ready = world.alerts
        .ofKind("analysis.ready")
        .filter((a) => a.key === `analysis.ready:${queued.id}`);
      expect(ready).toHaveLength(1);
      expect(ready[0]?.context).toMatchObject({ campaignId: campaign.id, analysisId: queued.id });
      // No answer text, quote or participant rides along.
      expect(JSON.stringify(ready[0])).not.toContain("Charting twice");
    });
  });

  describe("tenant ceilings and onboarding", () => {
    it("derives the checklist from what the tenant has, and stores only the dismissal", async () => {
      const other = await otherTenant();
      const fresh = (await call("GET", "/onboarding", other)).json<{
        steps: { key: string; done: boolean }[];
        done: number;
        complete: boolean;
        dismissed: boolean;
        next: string | null;
      }>();
      expect(fresh.steps.map((s) => s.key)).toEqual(["provider", "template", "campaign", "invite"]);
      expect(fresh.done).toBe(0);
      expect(fresh.next).toBe("provider");

      const mine = (await call("GET", "/onboarding", admin)).json<{
        steps: { key: string; done: boolean; source?: string }[];
        dismissed: boolean;
      }>();
      expect(mine.steps.find((s) => s.key === "provider")).toMatchObject({ done: true, source: "tenant" });
      expect(mine.steps.find((s) => s.key === "campaign")?.done).toBe(true);
      expect(mine.dismissed).toBe(false);

      const dismissed = await call("POST", "/onboarding/dismiss", other);
      expect(dismissed.json<{ dismissed: boolean }>().dismissed).toBe(true);
      // The other tenant's dismissal is not mine.
      expect((await call("GET", "/onboarding", admin)).json<{ dismissed: boolean }>().dismissed).toBe(false);
    });

    it("refuses the campaign that would pass ceiling.maxActiveCampaigns, and tells the tenant at 80 and 100 percent", async () => {
      const active = await world.db.campaign.count({
        where: { companyId: world.companyId, status: { in: ["draft", "open", "analyzing"] } },
      });
      const max = active + 5;
      await putSettings(
        { "ceiling.maxActiveCampaigns": max },
        `scope=tenant&scopeId=${world.companyId}`,
        operator,
      );
      const created: string[] = [];
      let refused:
        { statusCode: number; json: () => { error: { code: string; details: unknown } } } | undefined;
      for (let i = 0; i < 6; i++) {
        const res = await call("POST", "/campaigns", admin, {
          templateId: world.templateId,
          name: `Ceiling ${i}`,
          verification: "open",
        });
        if (res.statusCode === 201) created.push(res.json<{ campaign: { id: string } }>().campaign.id);
        else refused = res;
      }
      expect(created).toHaveLength(5);
      expect(refused?.statusCode).toBe(403);
      expect(refused?.json().error.code).toBe("limit_reached");
      expect(refused?.json().error.details).toEqual({ limit: "maxActiveCampaigns", current: max, max });

      const warnings = world.alerts
        .ofKind("ceiling.warning")
        .filter((a) => a.key.startsWith(`ceiling.warning:${world.companyId}:maxActiveCampaigns`));
      const reached = world.alerts
        .ofKind("ceiling.reached")
        .filter((a) => a.key.startsWith(`ceiling.reached:${world.companyId}:maxActiveCampaigns`));
      expect(warnings.length).toBeGreaterThan(0);
      expect(reached.length).toBeGreaterThan(0);
      expect(reached[0]?.localized?.fi?.title).toContain("Raja saavutettu");

      // Closing one frees a place.
      await call("POST", `/campaigns/${created[0]}/close`, admin);
      const again = await call("POST", "/campaigns", admin, {
        templateId: world.templateId,
        name: "Ceiling again",
        verification: "open",
      });
      expect(again.statusCode).toBe(201);
      await putSettings(
        { "ceiling.maxActiveCampaigns": null },
        `scope=tenant&scopeId=${world.companyId}`,
        operator,
      );
    });

    it("refuses a new interview past ceiling.maxSessionsPerMonth and leaves no participant behind", async () => {
      const campaign = await openCampaign("Session ceiling");
      const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
      const used = await world.db.session.count({
        where: { companyId: world.companyId, createdAt: { gte: monthStart } },
      });
      await putSettings(
        { "ceiling.maxSessionsPerMonth": used },
        `scope=tenant&scopeId=${world.companyId}`,
        operator,
      );
      const participantsBefore = await world.db.participant.count({ where: { companyId: world.companyId } });
      const res = await join(campaign.link);
      expect(res.status).toBe(403);
      expect(await world.db.participant.count({ where: { companyId: world.companyId } })).toBe(
        participantsBefore,
      );
      await putSettings(
        { "ceiling.maxSessionsPerMonth": used + 100 },
        `scope=tenant&scopeId=${world.companyId}`,
        operator,
      );
      expect((await join(campaign.link)).status).toBeLessThan(300);
      await putSettings(
        { "ceiling.maxSessionsPerMonth": null },
        `scope=tenant&scopeId=${world.companyId}`,
        operator,
      );
    });

    it("treats 0 as no ceiling", async () => {
      await putSettings(
        { "ceiling.maxActiveCampaigns": 0 },
        `scope=tenant&scopeId=${world.companyId}`,
        operator,
      );
      const res = await call("POST", "/campaigns", admin, {
        templateId: world.templateId,
        name: "No ceiling",
        verification: "open",
      });
      expect(res.statusCode).toBe(201);
      await putSettings(
        { "ceiling.maxActiveCampaigns": null },
        `scope=tenant&scopeId=${world.companyId}`,
        operator,
      );
    });
  });

  describe("the operator creates a tenant", () => {
    it("queues one invitation in the tenant's language, sets its ceilings, and shows utilisation", async () => {
      const email = `first-${Date.now().toString(36)}@new-tenant.test`;
      const res = await call("POST", "/operator/tenants", operator, {
        name: "Uusi Oy",
        adminEmail: email,
        language: "fi",
        ceilings: { maxActiveCampaigns: 3, maxSessionsPerMonth: 40 },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json<{ tenant: { id: string }; invitation: { to: string; language: string } }>();
      expect(body.invitation).toEqual({ to: email, language: "fi" });

      const job = world.jobs.published.filter(
        (j) =>
          j.name === "email.send" &&
          (j.payload as { idempotencyKey: string }).idempotencyKey === `tenant-invite:${body.tenant.id}`,
      );
      expect(job).toHaveLength(1);
      const payload = job[0]!.payload as { to: string; subject: string; text: string; companyId: string };
      expect(payload).toMatchObject({ to: email, companyId: body.tenant.id });
      expect(payload.subject).toContain("Uusi Oy");
      expect(payload.subject).toContain("ylläpitäjäksi");
      expect(payload.text).toContain("/auth/signin?email=");

      const settings = await world.db.setting.findMany({
        where: { scope: "tenant", scopeId: body.tenant.id },
      });
      const byKey = Object.fromEntries(settings.map((s) => [s.key, s.value]));
      expect(byKey).toMatchObject({
        "branding.language": "fi",
        "ceiling.maxActiveCampaigns": 3,
        "ceiling.maxSessionsPerMonth": 40,
      });

      const list = await call("GET", "/operator/tenants?q=Uusi", operator);
      const row = list
        .json<{
          tenants: {
            id: string;
            utilisation: { metric: string; used: number; max: number; percent: number | null }[];
            onboarding: { done: number; total: number };
          }[];
        }>()
        .tenants.find((t) => t.id === body.tenant.id);
      expect(row?.utilisation.find((u) => u.metric === "maxActiveCampaigns")).toMatchObject({
        used: 0,
        max: 3,
        percent: 0,
      });
      expect(row?.onboarding).toMatchObject({ done: 0, total: 4 });

      // The same address cannot start a second tenant.
      const again = await call("POST", "/operator/tenants", operator, { name: "Dup", adminEmail: email });
      expect(again.statusCode).toBe(409);
    });

    it("defaults to English", async () => {
      const email = `en-${Date.now().toString(36)}@new-tenant.test`;
      const res = await call("POST", "/operator/tenants", operator, { name: "Fresh Ltd", adminEmail: email });
      expect(res.statusCode).toBe(201);
      const tenant = res.json<{ tenant: { id: string } }>().tenant;
      const job = world.jobs.published.find(
        (j) =>
          j.name === "email.send" &&
          (j.payload as { idempotencyKey: string }).idempotencyKey === `tenant-invite:${tenant.id}`,
      );
      expect((job?.payload as { subject: string }).subject).toContain("You have been invited as an admin");
    });

    it("keeps a tenant admin from creating a tenant", async () => {
      const res = await call("POST", "/operator/tenants", admin, { name: "X", adminEmail: "x@y.test" });
      expect(res.statusCode).toBe(403);
    });
  });
});
