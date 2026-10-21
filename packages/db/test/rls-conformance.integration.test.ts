import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  describeDb,
  purgeAuditLog,
  APP_ROLE_TEST_PASSWORD,
  APP_ROLE_TEST_USER,
  setAppRolePassword,
} from "@aidp/testing";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SCOPED_MODELS, withSystemTenant, withTenant, withTenantScope } from "../src/index.js";

/**
 * The RLS conformance test (D-140): one factory per model, two tenants, and for every table the
 * same five facts proved against Postgres as `app_api`:
 *
 *   1. a tenant reads its own rows (the test is not vacuous),
 *   2. a tenant sees none of the other's, whatever the query asks,
 *   3. a write that names the other tenant is refused,
 *   4. a row cannot be moved to the other tenant,
 *   5. with no tenant in context nothing tenant-owned is visible, and the system context sees both.
 *
 * The list of models is not written here. It is read from the Prisma datamodel, and a model with
 * no factory fails the suite with an instruction, so the person who adds a table is the person who
 * extends this file. That is the whole point: migration 0008 enumerated tables by hand, and nine of
 * them were missed.
 */

/** Tables that are deliberately outside row-level security, and why. Mirrors deploy/lib/rls-exempt.txt. */
const RLS_EXEMPT: Record<string, string> = {
  VerificationToken: "Auth.js magic-link tokens are minted before any tenant is known",
  PlatformAsset: "The platform's public logo: no tenant owns it and anyone may read it (D-432)",
};

const here = dirname(fileURLToPath(import.meta.url));
const EXEMPT_FILE = join(here, "../../../deploy/lib/rls-exempt.txt");

const API_PASSWORD = APP_ROLE_TEST_PASSWORD;
const apiUrl = (owner: string): string => {
  const u = new URL(owner);
  u.username = APP_ROLE_TEST_USER;
  u.password = API_PASSWORD;
  return u.toString();
};

/** Everything one tenant owns: one row per model, created as the owner role. */
interface World {
  companyId: string;
  tag: string;
  userId: string;
  templateId: string;
  campaignId: string;
  participantId: string;
  sessionId: string;
  attachmentId: string;
  factId: string;
  analysisId: string;
  opportunityId: string;
  providerId: string;
}

type Factory = (db: PrismaClient, w: World, tag: string) => Promise<unknown>;

/**
 * One factory per model. Each creates one row owned by `w.companyId`, using the parents in `w`. The
 * same factory is run as `app_api` in the *other* tenant's context to prove the write is refused.
 */
const factories: Record<string, Factory> = {
  Company: (db, _w, tag) => db.company.create({ data: { name: `RLS ${tag}` } }),
  User: (db, w, tag) =>
    db.user.create({ data: { companyId: w.companyId, email: `u-${tag}@rls.test`, role: "member" } }),
  Participant: (db, w, tag) =>
    db.participant.create({
      data: { companyId: w.companyId, campaignId: w.campaignId, tokenHash: `ptok-${tag}` },
    }),
  InterviewTemplate: (db, w, tag) =>
    db.interviewTemplate.create({
      data: { companyId: w.companyId, key: `k-${tag}`, name: "t", objective: "o", privacyMode: "anonymous" },
    }),
  Campaign: (db, w, tag) =>
    db.campaign.create({
      data: {
        companyId: w.companyId,
        templateId: w.templateId,
        name: `c-${tag}`,
        participationMode: "anonymous",
        linkTokenHash: `link-${tag}`,
        createdById: w.userId,
      },
    }),
  Session: (db, w) =>
    db.session.create({
      data: { companyId: w.companyId, templateId: w.templateId, campaignId: w.campaignId },
    }),
  Message: (db, w, tag) =>
    db.message.create({
      data: {
        companyId: w.companyId,
        sessionId: w.sessionId,
        seq: Math.floor(Math.random() * 1e6),
        role: "user",
        content: `m-${tag}`,
      },
    }),
  SessionEvent: (db, w, tag) =>
    db.sessionEvent.create({
      data: {
        companyId: w.companyId,
        sessionId: w.sessionId,
        seq: Math.floor(Math.random() * 1e6),
        type: "x",
        payload: { tag },
      },
    }),
  Attachment: (db, w, tag) =>
    db.attachment.create({
      data: {
        companyId: w.companyId,
        sessionId: w.sessionId,
        kind: "document",
        filename: "f.txt",
        mime: "text/plain",
        sizeBytes: 1,
        storageKey: `${w.companyId}/${tag}`,
      },
    }),
  AttachmentChunk: (db, w, tag) =>
    db.attachmentChunk.create({
      data: {
        companyId: w.companyId,
        attachmentId: w.attachmentId,
        seq: Math.floor(Math.random() * 1e6),
        text: tag,
      },
    }),
  Fact: (db, w, tag) =>
    db.fact.create({
      data: {
        companyId: w.companyId,
        sessionId: w.sessionId,
        kind: "task",
        payload: { tag },
        extractorVersion: "x",
        batchEndSeq: Math.floor(Math.random() * 1e6),
        ordinal: 0,
      },
    }),
  Analysis: (db, w) =>
    db.analysis.create({
      data: { companyId: w.companyId, campaignId: w.campaignId, version: Math.floor(Math.random() * 1e6) },
    }),
  Opportunity: (db, w, tag) =>
    db.opportunity.create({
      data: {
        companyId: w.companyId,
        analysisId: w.analysisId,
        title: tag,
        summary: "s",
        solutionClass: "ai",
        factors: {},
        rationale: "r",
        rankScore: 1,
        clusterKey: `c-${tag}-${Math.random()}`,
      },
    }),
  OpportunityEvidence: async (db, w, tag) => {
    // The primary key is (opportunity, fact), so each call needs a fact of its own.
    const fact = await db.fact.create({
      data: {
        companyId: w.companyId,
        sessionId: w.sessionId,
        kind: "task",
        payload: { tag },
        extractorVersion: "x",
        batchEndSeq: Math.floor(Math.random() * 1e6),
        ordinal: 1,
      },
    });
    return db.opportunityEvidence.create({
      data: { companyId: w.companyId, opportunityId: w.opportunityId, factId: fact.id, snippet: tag },
    });
  },
  ClusterEdit: (db, w, tag) =>
    db.clusterEdit.create({
      data: {
        companyId: w.companyId,
        campaignId: w.campaignId,
        op: "merge",
        payload: { op: "merge", anchors: [[tag], [`${tag}-2`]] },
      },
    }),
  Report: (db, w, tag) =>
    db.report.create({
      data: {
        companyId: w.companyId,
        analysisId: w.analysisId,
        version: Math.floor(Math.random() * 1e6),
        markdown: tag,
      },
    }),
  SpecVersion: (db, w, tag) =>
    db.specVersion.create({
      data: {
        companyId: w.companyId,
        sessionId: w.sessionId,
        version: Math.floor(Math.random() * 1e6),
        spec: {},
        specMd: tag,
        bundle: {},
      },
    }),
  Invitation: (db, w, tag) =>
    db.invitation.create({
      data: {
        companyId: w.companyId,
        campaignId: w.campaignId,
        emailHash: `ih-${tag}-${Math.random()}`,
        tokenHash: `it-${tag}-${Math.random()}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    }),
  CampaignEmailHash: (db, w, tag) =>
    db.campaignEmailHash.create({
      data: { companyId: w.companyId, campaignId: w.campaignId, emailHash: `eh-${tag}-${Math.random()}` },
    }),
  EmailCode: (db, w, tag) =>
    db.emailCode.create({
      data: {
        companyId: w.companyId,
        campaignId: w.campaignId,
        emailHash: `ec-${tag}`,
        codeHash: "c",
        expiresAt: new Date(Date.now() + 60_000),
      },
    }),
  Setting: (db, w, tag) =>
    db.setting.create({
      data: { scope: "tenant", scopeId: w.companyId, key: `k-${tag}-${Math.random()}`, value: 1 },
    }),
  PromptVersion: (db, w, tag) =>
    db.promptVersion.create({
      data: { companyId: w.companyId, key: `p-${tag}`, version: Math.floor(Math.random() * 1e6), body: "b" },
    }),
  Provider: (db, w, tag) =>
    db.provider.create({
      data: { companyId: w.companyId, kind: "openai", name: `p-${tag}`, apiKeyEnc: "x" },
    }),
  ModelPrice: (db, w, tag) =>
    db.modelPrice.create({
      data: {
        providerId: w.providerId,
        model: `m-${tag}-${Math.random()}`,
        inputPerMtok: 1,
        cachedInputPerMtok: 1,
        outputPerMtok: 1,
        source: "admin",
      },
    }),
  Route: (db, w, tag) =>
    db.route.create({
      data: {
        companyId: w.companyId,
        purpose: `p-${tag}-${Math.random()}`,
        providerId: w.providerId,
        model: "m",
        maxOutputTokens: 100,
      },
    }),
  Budget: (db, w, tag) =>
    db.budget.create({
      data: {
        companyId: w.companyId,
        scope: "session",
        scopeId: `${tag}-${Math.random()}`,
        limitCents: 1,
        period: "total",
      },
    }),
  LlmCall: (db, w) =>
    db.llmCall.create({
      data: {
        companyId: w.companyId,
        purpose: "interview_turn",
        providerId: w.providerId,
        model: "m",
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
        status: "ok",
        costCents: 0,
      },
    }),
  AuditLog: (db, w, tag) =>
    db.auditLog.create({
      data: { companyId: w.companyId, action: "rls.test", targetType: "t", targetId: tag },
    }),
  SentEmail: (db, w, tag) =>
    db.sentEmail.create({ data: { companyId: w.companyId, idempotencyKey: `se-${tag}-${Math.random()}` } }),
  FallbackRoute: (db, w, tag) =>
    db.fallbackRoute.create({
      data: {
        companyId: w.companyId,
        purpose: `p-${tag}-${Math.random()}`,
        providerId: w.providerId,
        model: "m",
        maxOutputTokens: 100,
      },
    }),
  TenantStatement: (db, w) =>
    db.tenantStatement.create({
      data: {
        companyId: w.companyId,
        month: `20${Math.floor(10 + Math.random() * 89)}-0${Math.ceil(Math.random() * 9)}`,
        lines: [],
        totals: {},
        counts: {},
      },
    }),
  ErasureLedger: (db, w, tag) =>
    db.erasureLedger.create({
      data: { kind: "session", targetId: `er-${tag}-${Math.random()}`, companyId: w.companyId },
    }),
  UsageCounter: (db, w, tag) =>
    db.usageCounter.create({
      data: { companyId: w.companyId, key: `uc-${tag}-${Math.random()}`, windowStart: new Date(), count: 1 },
    }),
  OpsAlert: (db, w, tag) =>
    db.opsAlert.create({
      data: {
        companyId: w.companyId,
        key: `oa-${tag}-${Math.random()}`,
        kind: "k",
        severity: "info",
        title: "t",
      },
    }),
  ErrorGroup: (db, w, tag) =>
    db.errorGroup.create({
      data: {
        companyId: w.companyId,
        groupKey: `eg-${tag}-${Math.random()}`,
        fingerprint: `fp-${tag}`,
        source: "api",
        severity: "error",
        name: "Error",
        message: "m",
      },
    }),
  // The group is created with it, in the same tenant, so the write is refused as a whole.
  ErrorOccurrence: (db, w, tag) =>
    db.errorOccurrence.create({
      data: {
        company: { connect: { id: w.companyId } },
        source: "api",
        severity: "error",
        name: "Error",
        message: "m",
        group: {
          create: {
            company: { connect: { id: w.companyId } },
            groupKey: `eo-${tag}-${Math.random()}`,
            fingerprint: `fp-${tag}`,
            source: "api",
            severity: "error",
            name: "Error",
            message: "m",
          },
        },
      },
    }),
};

/** The column that names the owner: `id` for Company itself, `companyId` for everything else. */
const ownerColumn = (model: string): string => (model === "Company" ? "id" : "companyId");

describeDb("row-level security conformance (D-140)", () => {
  const owner = new PrismaClient();
  let api: PrismaClient;
  let scoped: PrismaClient;
  const tag = randomBytes(5).toString("hex");
  let a: World;
  let b: World;

  /** Runs one raw statement as app_api with the tenant setting on the same connection. */
  const rawAs = async <T>(tenant: string | null, sql: string, ...params: unknown[]): Promise<T[]> => {
    if (tenant === null) return api.$queryRawUnsafe<T[]>(sql, ...params);
    const results = await api.$transaction([
      api.$executeRawUnsafe("SELECT set_config('app.company_id', $1, TRUE)", tenant),
      api.$queryRawUnsafe<T[]>(sql, ...params),
    ]);
    return results[1];
  };
  const rawExecAs = async (tenant: string, sql: string, ...params: unknown[]): Promise<number> => {
    const results = await api.$transaction([
      api.$executeRawUnsafe("SELECT set_config('app.company_id', $1, TRUE)", tenant),
      api.$executeRawUnsafe(sql, ...params),
    ]);
    return results[1];
  };

  async function buildWorld(label: string): Promise<World> {
    const t = `${tag}${label}`;
    const w = { tag: t } as World;
    w.companyId = ((await factories.Company?.(owner, w, t)) as { id: string }).id;
    const make = async (model: string, key: string): Promise<string> => {
      const row = (await factories[model]?.(owner, w, t)) as { id?: string } | undefined;
      const id = row?.id;
      if (!id) throw new Error(`factory ${model} returned no id`);
      Object.assign(w, { [key]: id });
      return id;
    };
    await make("User", "userId");
    await make("InterviewTemplate", "templateId");
    await make("Campaign", "campaignId");
    await make("Participant", "participantId");
    await make("Session", "sessionId");
    await make("Attachment", "attachmentId");
    await make("Fact", "factId");
    await make("Analysis", "analysisId");
    await make("Opportunity", "opportunityId");
    await make("Provider", "providerId");
    // Every other model gets one row of its own.
    const built = new Set([
      "Company",
      "User",
      "InterviewTemplate",
      "Campaign",
      "Participant",
      "Session",
      "Attachment",
      "Fact",
      "Analysis",
      "Opportunity",
      "Provider",
    ]);
    for (const model of Object.keys(factories)) {
      if (!built.has(model)) await factories[model]?.(owner, w, t);
    }
    return w;
  }

  async function purge(companyId: string | undefined): Promise<void> {
    if (!companyId) return;
    const campaigns = (await owner.campaign.findMany({ where: { companyId }, select: { id: true } })).map(
      (c) => c.id,
    );
    const where = { companyId };
    await owner.opportunityEvidence.deleteMany({ where });
    await owner.report.deleteMany({ where });
    await owner.opportunity.deleteMany({ where });
    await owner.analysis.deleteMany({ where });
    await owner.invitation.deleteMany({ where });
    await owner.campaignEmailHash.deleteMany({ where });
    await owner.emailCode.deleteMany({ where });
    await owner.specVersion.deleteMany({ where });
    await owner.attachmentChunk.deleteMany({ where });
    await owner.attachment.deleteMany({ where });
    await owner.fact.deleteMany({ where });
    await owner.sessionEvent.deleteMany({ where });
    await owner.message.deleteMany({ where });
    await owner.llmCall.deleteMany({ where });
    await owner.fallbackRoute.deleteMany({ where });
    await owner.tenantStatement.deleteMany({ where });
    await owner.erasureLedger.deleteMany({ where });
    await owner.session.deleteMany({ where });
    await owner.participant.deleteMany({ where });
    await owner.setting.deleteMany({
      where: { OR: [{ scopeId: companyId }, { scopeId: { in: campaigns } }] },
    });
    await owner.campaign.deleteMany({ where });
    await owner.route.deleteMany({ where });
    await owner.provider.deleteMany({ where });
    await owner.budget.deleteMany({ where });
    await purgeAuditLog(owner, [companyId]);
    await owner.opsAlert.deleteMany({ where });
    await owner.errorOccurrence.deleteMany({ where });
    await owner.errorGroup.deleteMany({ where });
    await owner.sentEmail.deleteMany({ where });
    await owner.promptVersion.deleteMany({ where });
    await owner.interviewTemplate.deleteMany({ where });
    await owner.user.deleteMany({ where });
    await owner.company.delete({ where: { id: companyId } });
  }

  beforeAll(async () => {
    await setAppRolePassword(owner);
    api = new PrismaClient({ datasources: { db: { url: apiUrl(process.env.DATABASE_URL ?? "") } } });
    scoped = withTenantScope(api);
    a = await buildWorld("a");
    b = await buildWorld("b");
  });

  afterAll(async () => {
    await api.$disconnect();
    await purge(a.companyId);
    await purge(b.companyId);
    await owner.$disconnect();
  });

  describe("the model list is complete", () => {
    const models = Prisma.dmmf.datamodel.models;

    it("gives every model a factory, so a new table has to extend this suite", () => {
      const missing = models
        .map((m) => m.name)
        .filter((name) => !(name in factories) && !(name in RLS_EXEMPT));
      expect(
        missing,
        `Add a factory for ${missing.join(", ")} to rls-conformance.integration.test.ts, or, if it is ` +
          "deliberately outside row-level security, to RLS_EXEMPT and deploy/lib/rls-exempt.txt with a reason.",
      ).toEqual([]);
    });

    it("gives every model a tenant column, or a written reason why not", () => {
      const untenanted = models
        .filter((m) => m.name !== "Company" && !m.fields.some((f) => f.name === "companyId"))
        .map((m) => m.name)
        .filter((name) => !(name in RLS_EXEMPT));
      expect(untenanted).toEqual([]);
    });

    it("lists every model with a required companyId in the scoped client", () => {
      const missing = models
        .filter((m) => m.fields.some((f) => f.name === "companyId" && f.isRequired))
        .map((m) => m.name)
        .filter((name) => !SCOPED_MODELS.has(name));
      expect(missing).toEqual([]);
    });

    it("keeps the exempt list short, reasoned, and the same as the one the preflight reads", () => {
      expect(Object.keys(RLS_EXEMPT).length).toBeLessThanOrEqual(3);
      const file = readFileSync(EXEMPT_FILE, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "" && !l.startsWith("#"))
        .map((l) => l.trim().split(/\s+/)[0] ?? "")
        // `_prisma_migrations` is Prisma's own table, not a model; the preflight needs to know it.
        .filter((n) => n !== "_prisma_migrations")
        .sort();
      expect(file).toEqual(Object.keys(RLS_EXEMPT).sort());
      for (const reason of Object.values(RLS_EXEMPT)) expect(reason.length).toBeGreaterThan(10);
    });

    it("has row-level security and a real policy on every public table that is not exempt", async () => {
      // The same rule deploy/lib/preflight.sh enforces on boot, asked of the migrated database.
      const rows = await owner.$queryRawUnsafe<{ relname: string }[]>(
        `SELECT c.relname FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
            AND c.relname <> ALL ($1::text[])
            AND (NOT c.relrowsecurity
                 OR NOT EXISTS (
                   SELECT 1 FROM pg_policies p
                    WHERE p.schemaname = 'public' AND p.tablename = c.relname
                      AND p.policyname = 'tenant_isolation' AND 'app_api' = ANY (p.roles)
                      AND p.qual LIKE '%app.company_id%' AND p.with_check LIKE '%app.company_id%'))
          ORDER BY c.relname`,
        [...Object.keys(RLS_EXEMPT), "_prisma_migrations"],
      );
      expect(rows.map((r) => r.relname)).toEqual([]);
    });
  });

  describe.each(Object.keys(factories))("%s", (model) => {
    const table = `"${model}"`;
    const col = `"${ownerColumn(model)}"`;

    it("shows a tenant its own rows and none of the other's", async () => {
      const mine = await rawAs<{ n: bigint }>(
        a.companyId,
        `SELECT count(*) AS n FROM ${table} WHERE ${col} = $1`,
        a.companyId,
      );
      expect(Number(mine[0]?.n)).toBeGreaterThanOrEqual(1);
      // Asking for the other tenant's rows by name returns nothing: the database filters, not the query.
      const theirs = await rawAs<{ n: bigint }>(
        a.companyId,
        `SELECT count(*) AS n FROM ${table} WHERE ${col} = $1`,
        b.companyId,
      );
      expect(Number(theirs[0]?.n)).toBe(0);
      const all = await rawAs<{ n: bigint }>(
        a.companyId,
        `SELECT count(*) AS n FROM ${table} WHERE ${col} IS NOT NULL AND ${col} <> $1`,
        a.companyId,
      );
      expect(Number(all[0]?.n)).toBe(0);
    });

    it("refuses a write that names the other tenant", async () => {
      await withTenant(a.companyId, async () => {
        await expect(factories[model]?.(scoped, b, `${tag}x`)).rejects.toThrow();
      });
      // And nothing landed: the same query as the owner finds no row for the attempt.
      const rows = await owner.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM ${table} WHERE ${col} = $1`,
        b.companyId,
      );
      expect(Number(rows[0]?.n)).toBeGreaterThanOrEqual(1);
    });

    it("does not let the other tenant's rows be changed or deleted", async () => {
      const before = await owner.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM ${table} WHERE ${col} = $1`,
        b.companyId,
      );
      if (model === "AuditLog") {
        // The application role has no DELETE on the audit log at all (migration 0019, D-163): the
        // statement is refused outright, which is stronger than matching no rows.
        await expect(
          rawExecAs(a.companyId, `DELETE FROM ${table} WHERE ${col} = $1`, b.companyId),
        ).rejects.toThrow(/permission denied/);
      } else {
        const deleted = await rawExecAs(a.companyId, `DELETE FROM ${table} WHERE ${col} = $1`, b.companyId);
        expect(deleted).toBe(0);
      }
      const after = await owner.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM ${table} WHERE ${col} = $1`,
        b.companyId,
      );
      expect(after[0]?.n).toEqual(before[0]?.n);
    });

    it("does not let a row be moved to the other tenant", async () => {
      const owned = async (company: string): Promise<number> =>
        Number(
          (
            await owner.$queryRawUnsafe<{ n: bigint }[]>(
              `SELECT count(*) AS n FROM ${table} WHERE ${col} = $1`,
              company,
            )
          )[0]?.n,
        );
      const before = await owned(b.companyId);
      const attempt = rawExecAs(
        a.companyId,
        `UPDATE ${table} SET ${col} = $1 WHERE ${col} = $2`,
        b.companyId,
        a.companyId,
      );
      if (model === "Setting" || model === "ModelPrice") {
        // The owner of these rows is derived by a trigger from the scope or the provider, so the
        // column cannot be set at all: the statement runs and the derivation puts it back.
        await attempt;
      } else {
        await expect(attempt).rejects.toThrow();
      }
      expect(await owned(b.companyId)).toBe(before);
    });

    it("shows nothing tenant-owned with no tenant in context, and everything to the system", async () => {
      const none = await rawAs<{ n: bigint }>(
        null,
        `SELECT count(*) AS n FROM ${table} WHERE ${col} IS NOT NULL`,
      );
      expect(Number(none[0]?.n)).toBe(0);
      await withSystemTenant(async () => {
        const rows = await rawAs<{ n: bigint }>(
          "system",
          `SELECT count(*) AS n FROM ${table} WHERE ${col} IN ($1, $2)`,
          a.companyId,
          b.companyId,
        );
        expect(Number(rows[0]?.n)).toBeGreaterThanOrEqual(2);
      });
    });
  });

  describe("derived tenants (Setting, ModelPrice)", () => {
    it("derives a campaign setting's tenant from the campaign, so it cannot be forged", async () => {
      // As A, a setting whose scope is B's campaign: the campaign is invisible to A, so the row has
      // no owner A can name and the database refuses it.
      await withTenant(a.companyId, async () => {
        await expect(
          scoped.setting.create({
            data: { scope: "campaign", scopeId: b.campaignId, key: "campaign.linkExpiryDays", value: 3 },
          }),
        ).rejects.toThrow();
      });
      // As A, a setting that claims platform scope is not A's to write.
      await withTenant(a.companyId, async () => {
        await expect(
          scoped.setting.create({ data: { scope: "platform", scopeId: "", key: "forged", value: 1 } }),
        ).rejects.toThrow(/row-level security/i);
      });
    });

    it("lets every tenant read platform settings and prices, and none write them", async () => {
      await owner.setting.create({ data: { scope: "platform", scopeId: "", key: `plat-${tag}`, value: 1 } });
      const platformProvider = await owner.provider.create({
        data: { companyId: null, kind: "openai", name: `plat-${tag}`, apiKeyEnc: "x" },
      });
      await owner.modelPrice.create({
        data: {
          providerId: platformProvider.id,
          model: "m",
          inputPerMtok: 1,
          cachedInputPerMtok: 1,
          outputPerMtok: 1,
          source: "seed",
        },
      });
      try {
        await withTenant(a.companyId, async () => {
          expect(await scoped.setting.count({ where: { key: `plat-${tag}` } })).toBe(1);
          expect(await scoped.modelPrice.count({ where: { providerId: platformProvider.id } })).toBe(1);
          await expect(
            scoped.setting.update({
              where: { scope_scopeId_key: { scope: "platform", scopeId: "", key: `plat-${tag}` } },
              data: { value: 2 },
            }),
          ).rejects.toThrow();
          await expect(
            scoped.modelPrice.create({
              data: {
                providerId: platformProvider.id,
                model: "m2",
                inputPerMtok: 1,
                cachedInputPerMtok: 1,
                outputPerMtok: 1,
                source: "admin",
              },
            }),
          ).rejects.toThrow(/row-level security/i);
        });
      } finally {
        await owner.setting.deleteMany({ where: { key: `plat-${tag}` } });
        await owner.provider.delete({ where: { id: platformProvider.id } });
      }
    });
  });

  describe("composite foreign keys", () => {
    it("refuse a child that names a different tenant than its parent, even as the owner", async () => {
      await expect(
        owner.message.create({
          data: { companyId: b.companyId, sessionId: a.sessionId, seq: 987654, role: "user", content: "x" },
        }),
      ).rejects.toThrow(/foreign key/i);
      await expect(
        owner.invitation.create({
          data: {
            companyId: b.companyId,
            campaignId: a.campaignId,
            emailHash: `fk-${tag}`,
            tokenHash: `fk-${tag}`,
            expiresAt: new Date(),
          },
        }),
      ).rejects.toThrow(/foreign key/i);
    });
  });
});
