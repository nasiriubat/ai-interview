import type { Server } from "node:http";
import { SHIPPED_PROMPTS } from "@aidp/ai";
import { shippedTemplates } from "@aidp/db";
import { describeDb } from "@aidp/testing";
import { encode } from "@auth/core/jwt";
import { afterAll, beforeAll, expect, it } from "vitest";
import { actionIsDeclared, AUDIT_DECLARATIONS } from "../src/auth/audit-actions.js";
import { fakeModelServer, testWorld, type TestWorld } from "./helpers.js";

/*
 * Every administrative mutation leaves an audit row (FR-51), proven route by route.
 *
 * Each scenario names the route as `app.routeTable` spells it, and the last test fails closed in
 * both directions: a mutating admin, operator or staff route that no scenario exercised (and that
 * has no stated exemption) fails it, and so does a scenario for a route that is gone.
 *
 * Each row is checked for who did it (`actorId`), what it was done to (`targetType`, `targetId`),
 * the tenant it is filed under, and that the diff carries no secret the request contained.
 */

const suite = describeDb;

const GOOD_KEY = "sk-audit-rows-test-key-0123456789abcdef";

type Method = "POST" | "PUT" | "PATCH" | "DELETE";
type Actor = "admin" | "operator" | "member";

interface Expect {
  action: string;
  targetType: string;
  targetId?: string;
  /** Whose tenant the row is filed under; defaults to the actor's own. */
  companyId?: string | ((body: unknown) => string);
  actor: Actor;
  /** Strings from the request that must not appear anywhere in the stored diff. */
  secrets?: string[];
}

/** A request body sent as it is, for the routes that take an upload rather than JSON. */
class RawBody {
  constructor(
    readonly body: Buffer,
    readonly contentType: string,
  ) {}
}

/**
 * Mutating routes with no audit row, on purpose, and why: the declarations in
 * `auth/audit-actions.ts` that name a reason instead of an action.
 */
const EXEMPT: Record<string, string> = Object.fromEntries(
  Object.entries(AUDIT_DECLARATIONS).flatMap(([route, d]) => ("none" in d ? [[route, d.none]] : [])),
);

suite("audit rows: every administrative mutation writes one", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };
  const as = (token: string) => ({ authorization: `Bearer ${token}` });

  // State carried between scenarios, in the order the tests run.
  const s: Record<string, string> = {};
  const userIds: Record<Actor, string> = { admin: "", operator: "", member: "" };
  const tokens: Record<Actor, string> = { admin: "", operator: "", member: "" };
  const exercised = new Set<string>();

  beforeAll(async () => {
    model = await fakeModelServer(() => "ok");
    world = await testWorld(
      model.url,
      { OPENAI_BASE_URL: model.url, RATE_LIMIT_MAX: "100000", RATE_LIMIT_EXPENSIVE_MAX: "100000" },
      {
        github: {
          pushFiles: () =>
            Promise.resolve({
              commitUrl: "https://github.test/c/1",
              commitSha: "abc123",
              files: 1,
              branch: "main",
            }),
        },
      },
    );
    const { db } = world;
    userIds.admin = (await db.user.findFirstOrThrow({ where: { email: world.adminEmail } })).id;
    const op = await db.user.findFirstOrThrow({ where: { email: world.operatorEmail } });
    userIds.operator = op.id;
    s.operatorCompany = op.companyId;
    const memberEmail = `audit-member-${Date.now().toString(36)}@test.io`;
    userIds.member = (
      await db.user.create({ data: { companyId: world.companyId, email: memberEmail, role: "member" } })
    ).id;
    tokens.admin = world.adminToken;
    tokens.operator = world.operatorToken;
    tokens.member = await encode({
      token: { email: memberEmail },
      secret: world.ctx.config.AUTH_SECRET,
      salt: "authjs.session-token",
    });
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  /**
   * Runs a request and asserts the audit row it must have written. `route` is the key the route
   * table uses, so the completeness test knows what was exercised.
   */
  async function audited(
    route: string,
    url: string,
    payload: unknown,
    expected: Expect,
  ): Promise<Awaited<ReturnType<TestWorld["app"]["inject"]>>> {
    exercised.add(route);
    const method = route.split(" ")[0] as Method;
    const since = new Date(Date.now() - 1000);
    const raw = payload instanceof RawBody ? payload : null;
    const res = await world.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: {
        ...as(tokens[expected.actor]),
        ...(raw
          ? { "content-type": raw.contentType }
          : payload === undefined
            ? {}
            : { "content-type": "application/json" }),
      },
      ...(raw ? { payload: raw.body } : payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
    expect([200, 201, 202], `${route} -> ${res.statusCode} ${res.body.slice(0, 200)}`).toContain(
      res.statusCode,
    );
    // The route's own declaration must name the action it really wrote (D-163).
    const declared = AUDIT_DECLARATIONS[route];
    expect(
      Array.isArray(declared) && actionIsDeclared(declared as readonly string[], expected.action),
      `${route} does not declare ${expected.action} in auth/audit-actions.ts`,
    ).toBe(true);
    const companyId =
      typeof expected.companyId === "function"
        ? expected.companyId(res.json())
        : (expected.companyId ?? (expected.actor === "operator" ? s.operatorCompany! : world.companyId));
    const rows = await world.db.auditLog.findMany({
      where: { companyId, action: expected.action, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
    });
    expect(rows.length, `no ${expected.action} audit row for ${route}`).toBeGreaterThan(0);
    const row = rows[0]!;
    expect(row).toMatchObject({ actorId: userIds[expected.actor], targetType: expected.targetType });
    if (expected.targetId !== undefined) expect(row.targetId).toBe(expected.targetId);
    const diff = JSON.stringify(row.diff ?? null);
    for (const secret of expected.secrets ?? []) {
      expect(diff, `${expected.action} diff leaks a secret`).not.toContain(secret);
    }
    return res;
  }

  const templateBody = (() => {
    const { version: _version, ...body } = shippedTemplates()[0]!;
    return body;
  })();

  // ---------- users ----------

  it("POST /users and PATCH /users/:id", async () => {
    const created = await audited(
      "POST /users",
      "/users",
      { email: `invited-${Date.now().toString(36)}@test.io`, role: "member" },
      { action: "user.create", targetType: "user", actor: "admin" },
    );
    const id = created.json<{ user: { id: string } }>().user.id;
    await audited(
      "PATCH /users/:id",
      `/users/${id}`,
      { name: "Renamed" },
      { action: "user.update", targetType: "user", targetId: id, actor: "admin" },
    );
    await audited(
      "PATCH /users/:id",
      `/users/${id}`,
      { disabled: true },
      { action: "user.disable", targetType: "user", targetId: id, actor: "admin" },
    );
    await audited("DELETE /users/:id", `/users/${id}`, undefined, {
      action: "user.delete",
      targetType: "user",
      targetId: id,
      actor: "admin",
    });
  });

  it("PATCH /me and POST /me/sessions/revoke: the person's own profile and sessions (D-344)", async () => {
    await audited(
      "PATCH /me",
      "/me",
      { name: "Own name" },
      { action: "user.update", targetType: "user", targetId: userIds.member, actor: "member" },
    );
    // Revoking ends that person's tokens, so it runs as a user of its own and not as the member the
    // later scenarios still need.
    const email = `audit-revoke-${Date.now().toString(36)}@test.io`;
    const user = await world.db.user.create({ data: { companyId: world.companyId, email, role: "member" } });
    const saved = { id: userIds.member, token: tokens.member };
    userIds.member = user.id;
    tokens.member = await encode({
      token: { email },
      secret: world.ctx.config.AUTH_SECRET,
      salt: "authjs.session-token",
    });
    try {
      await audited(
        "POST /me/sessions/revoke",
        "/me/sessions/revoke",
        { confirm: true },
        {
          action: "user.sessions_revoke",
          targetType: "user",
          targetId: user.id,
          actor: "member",
        },
      );
    } finally {
      userIds.member = saved.id;
      tokens.member = saved.token;
    }
  });

  // ---------- templates ----------

  it("POST /templates, PUT /templates/:id, publish, preview, archive", async () => {
    const copy = await audited(
      "POST /templates",
      "/templates",
      { copyFromId: world.templateId },
      { action: "template.create", targetType: "template", actor: "admin" },
    );
    const id = copy.json<{ id: string }>().id;
    await audited("PUT /templates/:id", `/templates/${id}`, templateBody, {
      action: "template.update",
      targetType: "template",
      actor: "admin",
    });
    await audited("POST /templates/:id/publish", `/templates/${id}/publish`, undefined, {
      action: "template.published",
      targetType: "template",
      actor: "admin",
    });
    await audited(
      "POST /templates/:id/preview",
      `/templates/${world.templateId}/preview`,
      {},
      {
        action: "template.preview",
        targetType: "template",
        targetId: world.templateId,
        actor: "admin",
      },
    );
    await audited("POST /templates/:id/archive", `/templates/${id}/archive`, undefined, {
      action: "template.archived",
      targetType: "template",
      actor: "admin",
    });
    // The edit above made version 2; restoring version 1 writes version 3 and one row for it.
    const restored = await audited("POST /templates/:id/restore", `/templates/${id}/restore`, undefined, {
      action: "template.restore",
      targetType: "template",
      actor: "admin",
    });
    expect(restored.json<{ version: number }>().version).toBe(3);
  });

  it("POST /onboarding/dismiss", async () => {
    await audited("POST /onboarding/dismiss", "/onboarding/dismiss", undefined, {
      action: "onboarding.dismiss",
      targetType: "company",
      targetId: world.companyId,
      actor: "admin",
    });
  });

  // ---------- settings ----------

  it("PUT /settings names the keys and never a value", async () => {
    await audited(
      "PUT /settings",
      "/settings",
      { values: { "branding.productName": "Audit Secret Product Name" } },
      {
        action: "settings.update",
        targetType: "settings:tenant",
        targetId: world.companyId,
        actor: "admin",
        secrets: ["Audit Secret Product Name"],
      },
    );
  });

  it("POST /settings/email/test", async () => {
    await audited("POST /settings/email/test", "/settings/email/test", undefined, {
      action: "settings.email_test",
      targetType: "settings:tenant",
      actor: "admin",
    });
  });

  // ---------- campaigns ----------

  it("POST /campaigns, PATCH, open, close", async () => {
    const created = await audited(
      "POST /campaigns",
      "/campaigns",
      { templateId: world.templateId, name: "Audit campaign", verification: "open" },
      { action: "campaign.create", targetType: "campaign", actor: "admin" },
    );
    const id = created.json<{ campaign: { id: string } }>().campaign.id;
    s.campaign = id;
    await audited(
      "PATCH /campaigns/:id",
      `/campaigns/${id}`,
      { name: "Audit campaign renamed" },
      { action: "campaign.update", targetType: "campaign", targetId: id, actor: "admin" },
    );
    await audited("POST /campaigns/:id/open", `/campaigns/${id}/open`, undefined, {
      action: "campaign.open",
      targetType: "campaign",
      targetId: id,
      actor: "admin",
    });
    await audited("POST /campaigns/:id/close", `/campaigns/${id}/close`, undefined, {
      action: "campaign.closed",
      targetType: "campaign",
      targetId: id,
      actor: "admin",
    });
  });

  it("POST /campaigns/:id/invitations, remind, revoke", async () => {
    await audited(
      "POST /campaigns/:id/invitations",
      `/campaigns/${s.campaign}/invitations`,
      { emails: [`invitee-${Date.now().toString(36)}@example.test`] },
      { action: "campaign.invite", targetType: "campaign", targetId: s.campaign!, actor: "admin" },
    );
    const list = await world.app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${s.campaign}/invitations`,
      headers: as(world.adminToken),
    });
    const invitation = list.json<{ invitations: { id: string }[] }>().invitations[0]!;
    await audited(
      "POST /campaigns/:id/invitations/:invId/remind",
      `/campaigns/${s.campaign}/invitations/${invitation.id}/remind`,
      undefined,
      {
        action: "invitation.remind",
        targetType: "invitation",
        targetId: invitation.id,
        actor: "admin",
      },
    );
    await audited(
      "POST /campaigns/:id/invitations/:invId/revoke",
      `/campaigns/${s.campaign}/invitations/${invitation.id}/revoke`,
      undefined,
      {
        action: "invitation.revoke",
        targetType: "invitation",
        targetId: invitation.id,
        actor: "admin",
      },
    );
  });

  // ---------- providers, routes, prices ----------

  it("POST /providers, PATCH, prices, routes, test, DELETE: no key in any diff", async () => {
    const key = "sk-audit-created-0123456789";
    const rotated = "sk-audit-rotated-0123456789";
    const created = await audited(
      "POST /providers",
      "/providers",
      { kind: "openai_compatible", name: "Audit provider", baseUrl: model.url, apiKey: key },
      { action: "provider.create", targetType: "provider", actor: "admin", secrets: [key] },
    );
    const id = created.json<{ provider: { id: string } }>().provider.id;
    await audited(
      "PATCH /providers/:id",
      `/providers/${id}`,
      { name: "Audit provider renamed", apiKey: rotated },
      {
        action: "provider.update",
        targetType: "provider",
        targetId: id,
        actor: "admin",
        secrets: [rotated],
      },
    );
    await audited(
      "PUT /providers/:id/prices",
      `/providers/${id}/prices`,
      { prices: [{ model: "m", inputPerMtok: 1, outputPerMtok: 2 }] },
      { action: "prices.update", targetType: "provider", targetId: id, actor: "admin" },
    );
    await audited(
      "PUT /routes",
      "/routes",
      { routes: [] },
      {
        action: "routes.update",
        targetType: "routes",
        actor: "admin",
      },
    );
    await audited("POST /providers/:id/test", `/providers/${id}/test`, undefined, {
      action: "provider.test",
      targetType: "provider",
      targetId: id,
      actor: "admin",
    });
    // A provider the ledger has seen cannot be erased: 409, not the 500 it used to be.
    const used = await world.app.inject({
      method: "DELETE",
      url: `/api/v1/providers/${id}`,
      headers: as(world.adminToken),
    });
    expect(used.statusCode).toBe(409);
    const fresh = await audited(
      "POST /providers",
      "/providers",
      { kind: "openai_compatible", name: "Audit unused", baseUrl: model.url, apiKey: key },
      { action: "provider.create", targetType: "provider", actor: "admin", secrets: [key] },
    );
    const freshId = fresh.json<{ provider: { id: string } }>().provider.id;
    await audited("DELETE /providers/:id", `/providers/${freshId}`, undefined, {
      action: "provider.delete",
      targetType: "provider",
      targetId: freshId,
      actor: "admin",
    });
  });

  // ---------- budgets ----------

  it("POST /budgets and DELETE /budgets/:id (the delete wrote no row before this suite)", async () => {
    const set = await audited(
      "POST /budgets",
      "/budgets",
      { scope: "campaign", scopeId: s.campaign, limitCents: 500, period: "total" },
      { action: "budget.set", targetType: "budget", actor: "admin" },
    );
    const id = set.json<{ budget: { id: string } }>().budget.id;
    await audited("DELETE /budgets/:id", `/budgets/${id}`, undefined, {
      action: "budget.delete",
      targetType: "budget",
      targetId: id,
      actor: "admin",
    });
  });

  // ---------- voice ----------

  it("POST /admin/voice/openai keeps the key out of the row, then PUT /admin/voice/live", async () => {
    await audited(
      "POST /admin/voice/openai",
      "/admin/voice/openai",
      { apiKey: GOOD_KEY },
      { action: "voice.openai_connect", targetType: "provider", actor: "admin", secrets: [GOOD_KEY] },
    );
    await audited(
      "PUT /admin/voice/live",
      "/admin/voice/live",
      { enabled: true },
      {
        action: "voice.live_toggle",
        targetType: "settings:tenant",
        targetId: world.companyId,
        actor: "admin",
      },
    );
  });

  // ---------- analysis ----------

  it("POST /campaigns/:id/analyses", async () => {
    await audited("POST /campaigns/:id/analyses", `/campaigns/${s.campaign}/analyses`, undefined, {
      action: "analysis.start",
      targetType: "campaign",
      targetId: s.campaign!,
      actor: "admin",
    });
  });

  it("PATCH /opportunities/:id, status, promote", async () => {
    const factor = { score: 3, rationale: "r" };
    const analysis = await world.db.analysis.create({
      data: { companyId: world.companyId, campaignId: s.campaign!, version: 90, status: "done" },
    });
    const opportunity = await world.db.opportunity.create({
      data: {
        companyId: world.companyId,
        analysisId: analysis.id,
        title: "Audit opportunity",
        summary: "s",
        solutionClass: "automation",
        factors: {
          expected_impact: factor,
          affected_employees: factor,
          frequency: factor,
          implementation_complexity: factor,
          data_availability: factor,
          risk: factor,
          ai_suitability: factor,
        },
        rationale: "r",
        rankScore: 1,
        clusterKey: "audit",
      },
    });
    const id = opportunity.id;
    await audited(
      "PATCH /opportunities/:id",
      `/opportunities/${id}`,
      { note: "looked at it" },
      { action: "opportunity.override", targetType: "opportunity", targetId: id, actor: "admin" },
    );
    await audited(
      "POST /opportunities/:id/status",
      `/opportunities/${id}/status`,
      { status: "shortlisted" },
      { action: "opportunity.shortlisted", targetType: "opportunity", targetId: id, actor: "admin" },
    );
    await audited("POST /opportunities/:id/promote", `/opportunities/${id}/promote`, undefined, {
      action: "opportunity.promote",
      targetType: "opportunity",
      targetId: id,
      actor: "admin",
    });
  });

  it("cluster merge, split, rename and undo (FR-18)", async () => {
    const factor = { score: 3, rationale: "r" };
    const factors = {
      expected_impact: factor,
      affected_employees: factor,
      frequency: factor,
      implementation_complexity: factor,
      data_availability: factor,
      risk: factor,
      ai_suitability: factor,
    };
    let version = 700;
    /** A finished, editable analysis that is the newest of the campaign. */
    const editable = async (): Promise<{ analysisId: string; ids: string[] }> => {
      const a = await world.db.analysis.create({
        data: {
          companyId: world.companyId,
          campaignId: s.campaign!,
          // Ten apart: a merge queues the edit run at the next number.
          version: (version += 10),
          status: "done",
          clusters: [{ key: "ca", name: "A", summary: "", factIds: ["f1", "f2", "f3"] }],
        },
      });
      const ids: string[] = [];
      for (const [i, facts] of [["f1", "f2"], ["f3"]].entries()) {
        const o = await world.db.opportunity.create({
          data: {
            companyId: world.companyId,
            analysisId: a.id,
            title: `Cluster ${i}`,
            summary: "s",
            solutionClass: "automation",
            factors,
            rationale: "r",
            rankScore: 1,
            clusterKey: `audit-cluster-${version}-${i}`,
            factIds: facts,
            stats: { participants: 5 },
          },
        });
        ids.push(o.id);
      }
      return { analysisId: a.id, ids };
    };

    const first = await editable();
    await audited(
      "PATCH /opportunities/:id",
      `/opportunities/${first.ids[0]}`,
      { title: "A clearer name" },
      { action: "cluster.rename", targetType: "opportunity", targetId: first.ids[0]!, actor: "admin" },
    );
    const merged = await audited(
      "POST /analyses/:id/opportunities/merge",
      `/analyses/${first.analysisId}/opportunities/merge`,
      { opportunityIds: first.ids, title: "Both" },
      { action: "cluster.merge", targetType: "analysis", targetId: first.analysisId, actor: "admin" },
    );
    const editId = merged.json<{ editId: string }>().editId;

    const second = await editable();
    await audited(
      "POST /opportunities/:id/split",
      `/opportunities/${second.ids[0]}/split`,
      { parts: [["f1"], ["f2"]] },
      { action: "cluster.split", targetType: "opportunity", targetId: second.ids[0]!, actor: "admin" },
    );

    await editable();
    await audited(
      "DELETE /campaigns/:id/cluster-edits/:editId",
      `/campaigns/${s.campaign}/cluster-edits/${editId}`,
      undefined,
      { action: "cluster.edit.undo", targetType: "campaign", targetId: s.campaign!, actor: "admin" },
    );
  });

  // ---------- requirements (staff routes, members included) ----------

  it("the requirements workspace: create through push, as a member", async () => {
    const created = await audited(
      "POST /requirements",
      "/requirements",
      { title: "Audit requirements" },
      { action: "requirements.create", targetType: "session", actor: "member" },
    );
    const id = created.json<{ session: { id: string } }>().session.id;
    const base = `/requirements/${id}`;
    const onSession = (action: string, secrets?: string[]): Expect => ({
      action,
      targetType: "session",
      targetId: id,
      actor: "member",
      ...(secrets ? { secrets } : {}),
    });
    await audited(
      "POST /requirements/:id/path",
      `${base}/path`,
      { path: "technical" },
      onSession("requirements.path"),
    );
    await audited(
      "POST /requirements/:id/complete",
      `${base}/complete`,
      undefined,
      onSession("requirements.complete"),
    );
    // Reading the session after "I'm done" used to answer 500 (turnCount stored as -1).
    const after = await world.app.inject({
      method: "GET",
      url: `/api/v1${base}`,
      headers: as(tokens.member),
    });
    expect(after.statusCode).toBe(200);
    await audited(
      "POST /requirements/:id/reopen",
      `${base}/reopen`,
      undefined,
      onSession("requirements.reopen"),
    );
    await audited(
      "PUT /requirements/:id/sections/:key",
      `${base}/sections/overview`,
      { markdown: "Owner-written overview" },
      onSession("requirements.section_edit", ["Owner-written overview"]),
    );
    // Diagrams are edits of the same column; each of the three writes says which one it was.
    const added = await audited(
      "POST /requirements/:id/spec/diagrams",
      `${base}/spec/diagrams`,
      { mermaid: "flowchart LR\n  A-->B", description: "Hand-off", title: "Hand-off" },
      onSession("requirements.diagram_add"),
    );
    const diagramKey = added.json<{ key: string }>().key;
    await audited(
      "PUT /requirements/:id/spec/diagrams/:key",
      `${base}/spec/diagrams/${diagramKey}`,
      { mermaid: "flowchart LR\n  A-->B-->C", description: "Hand-off, with review" },
      onSession("requirements.diagram_edit"),
    );
    await audited(
      "DELETE /requirements/:id/spec/diagrams/:key",
      `${base}/spec/diagrams/${diagramKey}`,
      undefined,
      onSession("requirements.diagram_reset"),
    );
    // A finding to settle, put on the session directly: raising one takes a model turn.
    const row = await world.db.session.findUniqueOrThrow({ where: { id } });
    await world.db.session.update({
      where: { id },
      data: {
        state: {
          ...(row.state as object),
          findings: [
            {
              id: "f_audit",
              type: "missing_decision",
              section: "overview",
              description: "No owner is named",
              resolution: "Name one",
              default: "The requester",
              status: "open",
              raisedTurn: 0,
            },
          ],
        },
      },
    });
    await audited(
      "POST /requirements/:id/findings/:findingId",
      `${base}/findings/f_audit`,
      { outcome: "accepted" },
      onSession("requirements.finding"),
    );
    await audited(
      "POST /requirements/:id/versions",
      `${base}/versions`,
      {},
      onSession("requirements.version"),
    );
    // The queued version is what the worker would generate; a finished one is what can be pushed.
    await world.db.specVersion.updateMany({
      where: { sessionId: id },
      data: {
        status: "done",
        spec: { title: "Audit", generatedAt: new Date().toISOString(), sections: [] },
        bundle: { format: "generic", files: [{ path: "SPEC.md", content: "x" }] },
      },
    });
    await audited(
      "POST /requirements/:id/versions/:v/github",
      `${base}/versions/1/github`,
      { repository: "owner/name", token: "ghp_audit_token_value" },
      onSession("requirements.github_push", ["ghp_audit_token_value"]),
    );
    const invited = await audited(
      "POST /requirements/:id/invitations",
      `${base}/invitations`,
      { email: `req-invitee-${Date.now().toString(36)}@example.test` },
      onSession("requirements.invite"),
    );
    const invitationId = invited.json<{ invitation: { id: string } }>().invitation.id;
    await audited(
      "POST /requirements/:id/invitations/:invId/revoke",
      `${base}/invitations/${invitationId}/revoke`,
      undefined,
      onSession("requirements.revoke"),
    );
  });

  // ---------- operator ----------

  it("the operator's platform providers, routes and prices", async () => {
    const key = "sk-audit-platform-0123456789";
    const created = await audited(
      "POST /operator/providers",
      "/operator/providers",
      { kind: "openai_compatible", name: "Platform audit", baseUrl: model.url, apiKey: key },
      { action: "provider.create", targetType: "provider", actor: "operator", secrets: [key] },
    );
    const id = created.json<{ provider: { id: string } }>().provider.id;
    await audited(
      "PATCH /operator/providers/:id",
      `/operator/providers/${id}`,
      { name: "Platform audit renamed" },
      { action: "provider.update", targetType: "provider", targetId: id, actor: "operator" },
    );
    await audited(
      "PUT /operator/providers/:id/prices",
      `/operator/providers/${id}/prices`,
      { prices: [{ model: "m", inputPerMtok: 1, outputPerMtok: 2 }] },
      { action: "prices.update", targetType: "provider", targetId: id, actor: "operator" },
    );
    await audited(
      "PUT /operator/routes",
      "/operator/routes",
      { routes: [] },
      {
        action: "routes.update",
        targetType: "routes",
        actor: "operator",
      },
    );
    await audited("POST /operator/providers/:id/test", `/operator/providers/${id}/test`, undefined, {
      action: "provider.test",
      targetType: "provider",
      targetId: id,
      actor: "operator",
    });
    await audited("DELETE /operator/providers/:id", `/operator/providers/${id}`, undefined, {
      action: "provider.delete",
      targetType: "provider",
      targetId: id,
      actor: "operator",
    });
  });

  it("POST /operator/tenants and PATCH /operator/tenants/:id are filed under the tenant", async () => {
    const tenantOf = (body: unknown): string => (body as { tenant: { id: string } }).tenant.id;
    const created = await audited(
      "POST /operator/tenants",
      "/operator/tenants",
      { name: "Audit tenant", adminEmail: `audit-tenant-${Date.now().toString(36)}@test.io` },
      { action: "tenant.create", targetType: "company", actor: "operator", companyId: tenantOf },
    );
    const id = created.json<{ tenant: { id: string } }>().tenant.id;
    await audited(
      "PATCH /operator/tenants/:id",
      `/operator/tenants/${id}`,
      { name: "Audit tenant renamed" },
      {
        action: "tenant.update",
        targetType: "company",
        targetId: id,
        actor: "operator",
        companyId: id,
      },
    );
  });

  it("export and offboarding requests are filed under the operator's company, not the tenant's (D-225, D-226)", async () => {
    const name = `Audit offboard ${Date.now().toString(36)}`;
    const created = await world.app.inject({
      method: "POST",
      url: "/api/v1/operator/tenants",
      headers: { ...as(tokens.operator), "content-type": "application/json" },
      payload: JSON.stringify({ name, adminEmail: `audit-off-${Date.now().toString(36)}@test.io` }),
    });
    const id = created.json<{ tenant: { id: string } }>().tenant.id;
    await audited("POST /operator/tenants/:id/export", `/operator/tenants/${id}/export`, undefined, {
      action: "tenant.export_requested",
      targetType: "company",
      targetId: id,
      actor: "operator",
    });
    // Offboarding starts from a suspended tenant and the typed name.
    await world.app.inject({
      method: "PATCH",
      url: `/api/v1/operator/tenants/${id}`,
      headers: { ...as(tokens.operator), "content-type": "application/json" },
      payload: JSON.stringify({ status: "suspended" }),
    });
    await audited(
      "POST /operator/tenants/:id/offboard",
      `/operator/tenants/${id}/offboard`,
      { confirmName: name },
      {
        action: "tenant.offboard_requested",
        targetType: "company",
        targetId: id,
        actor: "operator",
      },
    );
  });

  it("the operator's job verbs are filed under the job's tenant", async () => {
    const dead = world.jobAdmin.addDead("analysis.run", {
      id: "33333333-3333-4333-8333-333333333333",
      sourceId: "44444444-4444-4444-8444-444444444444",
      raw: { analysisId: "an-audit", companyId: world.companyId },
      error: "timed out",
    });
    await audited(
      "POST /operator/jobs/dead/:queue/:id/retry",
      `/operator/jobs/dead/analysis.run/${dead.id}/retry`,
      undefined,
      {
        action: "job.retry",
        targetType: "job",
        targetId: dead.id,
        companyId: world.companyId,
        actor: "operator",
      },
    );
    const other = world.jobAdmin.addDead("analysis.run", {
      id: "55555555-5555-4555-8555-555555555555",
      sourceId: "66666666-6666-4666-8666-666666666666",
      raw: { analysisId: "an-audit-2", companyId: world.companyId },
      error: "timed out",
    });
    await audited(
      "POST /operator/jobs/dead/:queue/:id/discard",
      `/operator/jobs/dead/analysis.run/${other.id}/discard`,
      undefined,
      {
        action: "job.discard",
        targetType: "job",
        targetId: other.id,
        companyId: world.companyId,
        actor: "operator",
      },
    );
    await audited("POST /operator/jobs/run/:name", "/operator/jobs/run/ops.health-sweep", undefined, {
      action: "job.run_now",
      targetType: "job",
      targetId: "ops.health-sweep",
      actor: "operator",
    });
    await audited("POST /operator/crypto/rekey", "/operator/crypto/rekey", undefined, {
      action: "crypto.rekey_requested",
      targetType: "platform",
      actor: "operator",
    });
  });

  it("PUT and DELETE /operator/branding/logo: the platform logo (D-434)", async () => {
    // The smallest PNG header the check accepts: a signature and an IHDR of 64 x 32.
    const ihdr = Buffer.alloc(25);
    ihdr.writeUInt32BE(13, 0);
    ihdr.write("IHDR", 4, "latin1");
    ihdr.writeUInt32BE(64, 8);
    ihdr.writeUInt32BE(32, 12);
    const logo = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr]);
    const boundary = "----audit-logo";
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="logo.png"\r\n` +
          "Content-Type: image/png\r\n\r\n",
      ),
      logo,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    await audited(
      "PUT /operator/branding/logo",
      "/operator/branding/logo",
      new RawBody(body, `multipart/form-data; boundary=${boundary}`),
      {
        action: "branding.logo_update",
        targetType: "platform",
        targetId: "branding.logo",
        actor: "operator",
      },
    );
    await audited("DELETE /operator/branding/logo", "/operator/branding/logo", undefined, {
      action: "branding.logo_remove",
      targetType: "platform",
      targetId: "branding.logo",
      actor: "operator",
    });
  });

  it("acknowledging a flagged interview is audited, and keeps the reason out of the diff", async () => {
    const flagged = await world.db.session.create({
      data: {
        companyId: world.companyId,
        templateId: world.templateId,
        status: "active",
        flagged: true,
        flagReason: "SECRET-REASON the participant sounded distressed",
        flaggedAt: new Date(),
      },
    });
    await audited(
      "POST /sessions/:id/flag/ack",
      `/sessions/${flagged.id}/flag/ack`,
      { note: "SECRET-NOTE called them back" },
      {
        action: "session.flag.ack",
        targetType: "session",
        targetId: flagged.id,
        actor: "admin",
        secrets: ["SECRET-REASON", "SECRET-NOTE"],
      },
    );
  });

  // ---------- prompts ----------

  it("prompt versions, canary, activation, rollback and reset", async () => {
    const body = SHIPPED_PROMPTS.interviewer!.body.replace("Warm, brief, specific.", "SECRET-PROMPT-WORDS.");
    const created = await audited(
      "POST /prompts/:key/versions",
      "/prompts/interviewer/versions",
      { body, note: "audit scenario" },
      {
        action: "prompt.create",
        targetType: "prompt",
        targetId: "interviewer",
        actor: "admin",
        secrets: ["SECRET-PROMPT-WORDS"],
      },
    );
    const v = created.json<{ version: number }>().version;
    await audited(
      "POST /prompts/:key/versions/:v/activate",
      `/prompts/interviewer/versions/${v}/activate`,
      { canaryShare: 0.25 },
      { action: "prompt.canary", targetType: "prompt", targetId: "interviewer", actor: "admin" },
    );
    await audited("DELETE /prompts/:key/canary", "/prompts/interviewer/canary", undefined, {
      action: "prompt.canary_stop",
      targetType: "prompt",
      targetId: "interviewer",
      actor: "admin",
    });
    await audited(
      "POST /prompts/:key/versions/:v/activate",
      `/prompts/interviewer/versions/${v}/activate`,
      { canaryShare: 1 },
      { action: "prompt.activate", targetType: "prompt", targetId: "interviewer", actor: "admin" },
    );
    await audited("POST /prompts/:key/reset", "/prompts/interviewer/reset", undefined, {
      action: "prompt.reset",
      targetType: "prompt",
      targetId: "interviewer",
      actor: "admin",
    });
    await audited("POST /prompts/:key/rollback", "/prompts/interviewer/rollback", undefined, {
      action: "prompt.rollback",
      targetType: "prompt",
      targetId: "interviewer",
      actor: "admin",
    });
    // The check route is exempt by declaration; it must really leave nothing behind.
    const before = await world.db.auditLog.count({ where: { companyId: world.companyId } });
    const checked = await world.app.inject({
      method: "POST",
      url: "/api/v1/prompts/interviewer/check",
      headers: { ...as(tokens.admin), "content-type": "application/json" },
      payload: JSON.stringify({ body }),
    });
    expect(checked.statusCode).toBe(200);
    expect(await world.db.auditLog.count({ where: { companyId: world.companyId } })).toBe(before);
  });

  // ---------- completeness ----------

  it("exercised every mutating administrative route, or states why not", () => {
    const mutating = world.app.routeTable
      .filter((r) => ["POST", "PUT", "PATCH", "DELETE"].includes(r.method))
      .filter((r) => r.access === "admin" || r.access === "operator" || r.access === "staff")
      .map((r) => `${r.method} ${r.url.replace("/api/v1", "")}`);
    const missing = mutating.filter((k) => !exercised.has(k) && !(k in EXEMPT));
    expect(missing, "add an audit scenario, or an exemption with a reason").toEqual([]);
    const gone = [...exercised, ...Object.keys(EXEMPT)].filter((k) => !mutating.includes(k));
    expect(gone, "a scenario for a route that no longer exists").toEqual([]);
    const stale = Object.keys(AUDIT_DECLARATIONS).filter((k) => !mutating.includes(k));
    expect(stale, "an audit declaration for a route that no longer exists").toEqual([]);
  });
});
