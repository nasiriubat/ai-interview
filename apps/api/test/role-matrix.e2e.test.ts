import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { shippedTemplates } from "@aidp/db";
import { INTERNAL_AUTH_HEADER } from "@aidp/shared";
import { describeDb } from "@aidp/testing";
import { encode } from "@auth/core/jwt";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Access } from "../src/auth/access.js";
import { fakeModelServer, testWorld, TEST_AUTH_SECRET, type TestWorld } from "./helpers.js";

/*
 * The role matrix (engineering 4.2b): every route the app serves, against every kind of caller.
 *
 * The matrix is generated from `app.routeTable`, which the access guard fills as routes register,
 * so a new route cannot ship without a row: the test fails until the snapshot is regenerated
 * (`UPDATE_ROLE_MATRIX=1`) and the diff reviewed. The snapshot is also checked against the policy
 * each access level promises, so a regenerated snapshot cannot quietly record a hole.
 *
 * Callers:
 *   anonymous         no credential
 *   participant       a participant session token
 *   member            staff, role member, tenant A
 *   admin             staff, role admin, tenant A
 *   operator          the platform operator
 *   crossTenantAdmin  admin of tenant B, holding tenant A's ids
 *
 * For the first five the request is a probe: ids that do not exist and an empty body. That reaches
 * the guard (the thing under test) and then fails validation or the lookup, so no principal
 * changes state. The last column is the isolation check: where a route takes a tenant resource,
 * tenant B's admin asks for tenant A's real one, with a valid body so that validation does not
 * answer first. It must be a 404, not a 403 (that would confirm the id exists) and not a 2xx.
 */

const suite = describeDb;

const SNAPSHOT = join(dirname(fileURLToPath(import.meta.url)), "role-matrix.snapshot.json");

const KINDS = ["anonymous", "participant", "member", "admin", "operator", "crossTenantAdmin"] as const;
type Kind = (typeof KINDS)[number];

interface Row {
  access: Access;
  /** Whether the isolation probe ran with tenant A's real ids. */
  isolation: boolean;
  statuses: Record<Kind, number>;
}

/** What the guard alone must answer, per access level and caller; `null` is "let it through". */
function policy(access: Access, kind: Kind): number | null {
  const staffKind =
    kind === "member" || kind === "admin" || kind === "operator" || kind === "crossTenantAdmin";
  switch (access) {
    case "public":
      return null;
    case "participant":
      return kind === "participant" ? null : 401;
    case "internal":
      return 401; // these callers are none of the people it is for
    case "staff":
      return staffKind ? null : 401;
    case "admin":
      if (!staffKind) return 401;
      return kind === "member" ? 403 : null;
    case "operator":
      if (!staffKind) return 401;
      return kind === "operator" ? null : 403;
  }
}

suite("role matrix: every route against every kind of caller", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };

  const staff = (token: string) => ({ authorization: `Bearer ${token}` });
  const jwt = (email: string) =>
    encode({ token: { email }, secret: TEST_AUTH_SECRET, salt: "authjs.session-token" });

  let tokens: Record<"member" | "admin" | "operator" | "crossTenantAdmin", string>;
  let participantToken = "";
  let linkToken = "";
  /** Tenant A's real resources, by the name the route templates use for them. */
  const real: Record<string, string> = {};

  beforeAll(async () => {
    model = await fakeModelServer(() => "x");
    world = await testWorld(model.url, { RATE_LIMIT_MAX: "100000", RATE_LIMIT_EXPENSIVE_MAX: "100000" });
    const { app, db } = world;
    const suffix = Date.now().toString(36);

    const memberEmail = `member-${suffix}@test.io`;
    await db.user.create({ data: { companyId: world.companyId, email: memberEmail, role: "member" } });
    const b = await db.company.create({ data: { name: `Tenant B ${suffix}`, monthlyBudgetCents: 1000 } });
    const bAdminEmail = `b-admin-${suffix}@test.io`;
    await db.user.create({ data: { companyId: b.id, email: bAdminEmail, role: "admin" } });
    tokens = {
      member: await jwt(memberEmail),
      admin: world.adminToken,
      operator: world.operatorToken,
      crossTenantAdmin: await jwt(bAdminEmail),
    };

    // A campaign that anyone with the link may join, so a participant session can be had on demand.
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: staff(world.adminToken),
      payload: { templateId: world.templateId, name: "Matrix", verification: "open" },
    });
    const campaign = created.json<{ campaign: { id: string }; link: { url: string } }>();
    real.campaign = campaign.campaign.id;
    linkToken = campaign.link.url.split("/p/")[1]!;
    await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${real.campaign}/open`,
      headers: staff(world.adminToken),
    });
    const joined = await joinAsParticipant();
    participantToken = joined.token;
    real.session = joined.sessionId;

    real.template = world.templateId;
    real.provider = (await db.provider.findFirstOrThrow({ where: { companyId: world.companyId } })).id;
    real.user = (await db.user.findFirstOrThrow({ where: { email: world.adminEmail } })).id;
    real.tenant = world.companyId;
    const budget = await app.inject({
      method: "POST",
      url: "/api/v1/budgets",
      headers: staff(world.adminToken),
      payload: { scope: "campaign", scopeId: real.campaign, limitCents: 100, period: "total" },
    });
    real.budget = budget.json<{ budget: { id: string } }>().budget.id;
    const analysis = await db.analysis.create({
      data: { companyId: world.companyId, campaignId: real.campaign, version: 1, status: "done" },
    });
    real.analysis = analysis.id;
    real.other = (
      await db.analysis.create({
        data: { companyId: world.companyId, campaignId: real.campaign, version: 2, status: "done" },
      })
    ).id;
    const opportunity = await db.opportunity.create({
      data: {
        companyId: world.companyId,
        analysisId: analysis.id,
        title: "Matrix",
        summary: "s",
        solutionClass: "ai",
        factors: {},
        rationale: "r",
        rankScore: 1,
        clusterKey: "matrix",
      },
    });
    real.opportunity = opportunity.id;
    const req = await app.inject({
      method: "POST",
      url: "/api/v1/requirements",
      headers: staff(world.adminToken),
      payload: { title: "Matrix requirements" },
    });
    real.requirement = req.json<{ session: { id: string } }>().session.id;
  });

  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  async function joinAsParticipant(): Promise<{ token: string; sessionId: string }> {
    const res = await world.app.inject({
      method: "POST",
      url: `/api/v1/p/${linkToken}/open`,
      payload: {},
    });
    const body = res.json<{ participantToken: string; sessionId: string }>();
    return { token: `pt.${body.participantToken}`, sessionId: body.sessionId };
  }

  /**
   * The id a path parameter stands for, by the route it is in. `missing` is the probe: syntactically
   * fine, owned by nobody.
   */
  function fill(url: string, mode: "missing" | "real"): { url: string; usedReal: boolean } {
    let usedReal = false;
    const pick = (name: string): string => {
      const missing: Record<string, string> = {
        id: "missing_id",
        otherId: "missing_other",
        invId: "missing_invitation",
        attachmentId: "missing_attachment",
        linkToken: "missing-link-token",
        token: "missing-token",
        findingId: "missing_finding",
        key: "overview",
        v: "1",
        other: "2",
        queue: "session.extract",
        name: "retention.sweep",
      };
      if (mode === "missing") return missing[name] ?? "missing";
      const resource = (): string | undefined => {
        if (url.includes("/operator/tenants/")) return real.tenant;
        if (url.includes("/users/")) return real.user;
        if (url.includes("/templates/")) return real.template;
        if (url.includes("/providers/")) return real.provider;
        if (url.includes("/budgets/")) return real.budget;
        if (url.includes("/opportunities/")) return real.opportunity;
        if (url.includes("/analyses/")) return real.analysis;
        if (url.includes("/requirements/")) return real.requirement;
        if (url.includes("/sessions/")) return real.session;
        if (url.includes("/campaigns/")) return real.campaign;
        return undefined;
      };
      if (name === "id") {
        const r = resource();
        if (r) {
          usedReal = true;
          return r;
        }
      }
      if (name === "otherId" && real.other) {
        usedReal = true;
        return real.other;
      }
      return missing[name] ?? "missing";
    };
    return { url: url.replace(/:([A-Za-z]+)/g, (_m, name: string) => pick(name)), usedReal };
  }

  /** A body that passes validation, so a cross-tenant id is what decides the answer. */
  function validBody(method: string, template: string): unknown {
    const key = `${method} ${template.replace("/api/v1", "")}`;
    const t = shippedTemplates()[0]!;
    const { version: _version, ...templateBody } = t;
    const bodies: Record<string, unknown> = {
      "PATCH /users/:id": { name: "Renamed" },
      "PUT /templates/:id": templateBody,
      "POST /templates/:id/preview": {},
      "PATCH /campaigns/:id": { name: "Renamed" },
      "POST /campaigns/:id/invitations": { emails: ["someone@example.test"] },
      "PATCH /providers/:id": { name: "Renamed" },
      "PUT /providers/:id/prices": { prices: [] },
      "PATCH /opportunities/:id": { note: "x" },
      "POST /opportunities/:id/status": { status: "new" },
      "POST /requirements/:id/path": { path: "technical" },
      "PUT /requirements/:id/sections/:key": { markdown: "x" },
      "POST /requirements/:id/findings/:findingId": { outcome: "accepted" },
      "PUT /requirements/:id/spec/diagrams/:key": {
        mermaid: "flowchart LR\n  A-->B",
        description: "x",
      },
      "POST /requirements/:id/spec/diagrams": { mermaid: "flowchart LR\n  A-->B", description: "x" },
      "POST /requirements/:id/versions": {},
      "POST /requirements/:id/versions/:v/github": { repository: "a/b", token: "t" },
      "POST /requirements/:id/invitations": { email: "someone@example.test" },
    };
    return bodies[key] ?? {};
  }

  /** Routes whose tenant resource is named in the body rather than the path. */
  const BODY_ISOLATION: Record<string, () => unknown> = {
    "POST /templates": () => ({ copyFromId: real.template }),
    "POST /budgets": () => ({ scope: "campaign", scopeId: real.campaign, limitCents: 1, period: "total" }),
    "PUT /routes": () => ({
      routes: [{ purpose: "interview_turn", providerId: real.provider, model: "m" }],
    }),
  };

  async function call(
    method: string,
    url: string,
    headers: Record<string, string>,
    payload: unknown,
  ): Promise<number> {
    const hasBody = !["GET", "HEAD", "DELETE", "OPTIONS"].includes(method);
    const res = await world.app.inject({
      method: method as "GET",
      url,
      headers: hasBody ? { ...headers, "content-type": "application/json" } : headers,
      ...(hasBody ? { payload: JSON.stringify(payload) } : {}),
    });
    return res.statusCode;
  }

  /** The statuses for one route, across all six kinds of caller. */
  async function probe(method: string, template: string, access: Access): Promise<Row> {
    const withQuery = (u: string): string => (u.endsWith("/export") ? `${u}?format=md` : u);
    const missing = withQuery(fill(template, "missing").url);
    const key = `${method} ${template.replace("/api/v1", "")}`;
    const bodyIsolation = BODY_ISOLATION[key];
    const isoFill = fill(template, "real");
    const isolation = isoFill.usedReal || bodyIsolation !== undefined;
    const isoUrl = withQuery(isoFill.url);
    const isoBody = bodyIsolation ? bodyIsolation() : validBody(method, template);

    const statuses = {} as Record<Kind, number>;
    statuses.anonymous = await call(method, missing, {}, {});
    // Participant routes run their handler, so each probe gets a session of its own to spend.
    const pt = access === "participant" ? (await joinAsParticipant()).token : participantToken;
    statuses.participant = await call(method, missing, staff(pt), {});
    statuses.member = await call(method, missing, staff(tokens.member), {});
    statuses.admin = await call(method, missing, staff(tokens.admin), {});
    statuses.operator = await call(method, missing, staff(tokens.operator), {});
    statuses.crossTenantAdmin = isolation
      ? await call(method, isoUrl, staff(tokens.crossTenantAdmin), isoBody)
      : await call(method, missing, staff(tokens.crossTenantAdmin), {});
    if (access === "internal") {
      // The shared secret is the one credential these routes take; it is not a principal.
      expect(await call(method, missing, { [INTERNAL_AUTH_HEADER]: TEST_AUTH_SECRET }, {})).not.toBe(401);
    }
    return { access, isolation, statuses };
  }

  it("covers every route in the table, matches the committed snapshot, and honours the policy", async () => {
    const table = world.app.routeTable;
    expect(table.length).toBeGreaterThan(100);
    const actual: Record<string, Row> = {};
    for (const r of table) {
      const key = `${r.method} ${r.url.replace("/api/v1", "")}`;
      // A websocket upgrade is closed by its handler with a status; the plain request still gets a row.
      actual[key] = await probe(r.method, r.url, r.access);
    }

    // The matrix has to say something about every route, and be allowed to say nothing wrong.
    const violations: string[] = [];
    for (const [key, row] of Object.entries(actual)) {
      // The socket is upgraded or refused by its handler with a close code (voice-live.e2e covers
      // that); a plain request to it is not part of the guard's policy and must simply not succeed.
      if (key.endsWith("/p/session/live")) {
        for (const kind of KINDS) {
          if (row.statuses[kind] !== 404)
            violations.push(`${key} as ${kind}: ${row.statuses[kind]}, not 404`);
        }
        continue;
      }
      for (const kind of KINDS) {
        const expected = policy(row.access, kind);
        const got = row.statuses[kind];
        if (expected !== null && got !== expected) {
          violations.push(`${key} as ${kind}: expected ${expected}, got ${got}`);
        }
        if (expected === null && got === 401) {
          violations.push(`${key} as ${kind}: let through by policy but answered 401`);
        }
      }
      if (row.isolation && (row.access === "staff" || row.access === "admin")) {
        const got = row.statuses.crossTenantAdmin;
        if (got !== 404)
          violations.push(`${key}: tenant B asked for tenant A's resource and got ${got}, not 404`);
      }
    }
    expect(violations).toEqual([]);

    if (process.env.UPDATE_ROLE_MATRIX === "1" || !existsSync(SNAPSHOT)) {
      const sorted = Object.fromEntries(Object.entries(actual).sort(([a], [b]) => a.localeCompare(b)));
      writeFileSync(SNAPSHOT, `${JSON.stringify(sorted, null, 2)}\n`);
    }
    const committed = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Record<string, Row>;
    // Fails closed in both directions: a route with no row, and a row for a route that is gone.
    expect(Object.keys(actual).sort()).toEqual(Object.keys(committed).sort());
    expect(actual).toEqual(committed);
  }, 180_000);
});
