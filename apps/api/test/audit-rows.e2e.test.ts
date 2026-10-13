import type { Server } from "node:http";
import { shippedTemplates } from "@aidp/db";
import { describeDb } from "@aidp/testing";
import { encode } from "@auth/core/jwt";
import { afterAll, beforeAll, expect, it } from "vitest";
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

/** Mutating routes with no audit row, on purpose, and why. */
const EXEMPT: Record<string, string> = {
  "POST /requirements/:id/turns":
    "A conversation turn is the interview itself, stored as messages; it is not an administrative action.",
};

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
  ): Promise<{ json: <T>() => T }> {
    exercised.add(route);
    const method = route.split(" ")[0] as Method;
    const since = new Date(Date.now() - 1000);
    const res = await world.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: {
        ...as(tokens[expected.actor]),
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
    expect([200, 201, 202], `${route} -> ${res.statusCode} ${res.body.slice(0, 200)}`).toContain(
      res.statusCode,
    );
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
    return { json: <T>() => res.json<T>() };
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
      data: { campaignId: s.campaign!, version: 90, status: "done" },
    });
    const opportunity = await world.db.opportunity.create({
      data: {
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
  });
});
