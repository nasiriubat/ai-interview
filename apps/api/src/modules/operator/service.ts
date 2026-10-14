import {
  tenantInvitationEmail,
  type CeilingUtilisation,
  type ExportMeta,
  type TenantExporter,
  type JobPublisher,
  type OnboardingState,
  type SettingsService,
  type TenantCeilings,
  type TenantGate,
  type TenantOnboarding,
} from "@aidp/core";
import { tenantBatch, tenantTransaction, withSystemTenant } from "@aidp/db";
import { toListResponse, type ListEnvelope } from "@aidp/shared";
import type { Company, Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { AppError, emailTaken, isUniqueViolation, notFound } from "../../lib/errors.js";
import { defined } from "../../lib/objects.js";
import { contains, listOrder, listQuery, listSpec, searchTerm } from "../../lib/pagination.js";
import type { AuditService } from "../audit/service.js";

/**
 * The platform operator, as a caller. The operator is not a member of the tenants they manage, so
 * these methods take no `companyId`: they take who is acting, and every one of them is audited
 * against the tenant it touched. This is the only module that reads across tenants on purpose.
 */
export interface OperatorActor {
  userId: string;
}

/** `/operator/tenants` (D-79): `q` matches the name, or the id exactly. */
export const TenantList = listSpec({
  sort: { createdAt: "asc", name: "asc", status: "asc" },
  defaultSort: "createdAt",
  filters: {
    status: z.enum(["active", "suspended"]).optional(),
    region: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .max(20)
      .optional(),
  },
});

export const TenantListQuery = listQuery(TenantList);
export type TenantListQuery = z.output<typeof TenantListQuery>;

/** The ceilings an operator may set while creating a tenant; the same keys as `ceiling.*` (D-188). */
export const TenantCeilingsBody = z.object({
  maxActiveCampaigns: z.number().int().min(0).max(100000).optional(),
  maxSessionsPerMonth: z.number().int().min(0).max(10000000).optional(),
  storageBytes: z.number().int().min(0).optional(),
  voiceMinutes: z.number().int().min(0).max(10000000).optional(),
});

export const TenantCreateBody = z.object({
  name: z.string().min(1),
  region: z.string().default("eu"),
  adminEmail: z.email(),
  monthlyBudgetCents: z.number().int().min(0).optional(),
  /** The language of the invitation and of the notices the tenant's admins receive (`branding.language`). */
  language: z.enum(["en", "fi"]).default("en"),
  ceilings: TenantCeilingsBody.optional(),
});
export type TenantCreateBody = z.output<typeof TenantCreateBody>;

export const TenantPatchBody = z.object({
  name: z.string().min(1).optional(),
  status: z.enum(["active", "suspended"]).optional(),
  monthlyBudgetCents: z.number().int().min(0).optional(),
});
export type TenantPatchBody = z.output<typeof TenantPatchBody>;

export type TenantRow = Company & {
  _count: { users: number; campaigns: number; sessions: number };
  /** What each ceiling allows and how much of it is used (D-188). */
  utilisation: CeilingUtilisation[];
  /** The getting-started checklist, derived (D-189). */
  onboarding: OnboardingState;
};

/** What `createTenant` needs beyond the database: the queue for the invitation, and the derived views. */
export interface OperatorExtras {
  jobs: JobPublisher;
  ceilings: TenantCeilings;
  onboarding: TenantOnboarding;
  publicWebUrl: string;
  /** Tenant export (D-225). */
  exporter?: TenantExporter;
}

/** How long a suspended tenant has before `tenant.offboard` removes its data, unless `immediate`. */
export const OFFBOARD_GRACE_DAYS = 7;

export interface PlatformStats {
  tenants: number;
  sessions: Record<string, number>;
  spendByTenant: { companyId: string; costCents: number; calls: number }[];
}

export class OperatorService {
  constructor(
    private readonly db: PrismaClient,
    private readonly settings: SettingsService,
    private readonly tenants: TenantGate,
    private readonly audit: AuditService,
    private readonly extras?: OperatorExtras,
  ) {}

  async listTenants(
    _actor: OperatorActor,
    query: TenantListQuery,
  ): Promise<ListEnvelope<"tenants", TenantRow>> {
    const q = searchTerm(query.q);
    const where: Prisma.CompanyWhereInput = {
      ...(q ? { OR: [{ name: contains(q) }, { id: q }] } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.region ? { region: query.region } : {}),
    };
    const [tenants, total] = await tenantBatch(this.db, [
      this.db.company.findMany({
        where,
        orderBy: listOrder<Prisma.CompanyOrderByWithRelationInput, typeof query.sort>(TenantList, query),
        include: { _count: { select: { users: true, campaigns: true, sessions: true } } },
        take: query.limit,
        skip: query.offset,
      }),
      this.db.company.count({ where }),
    ]);
    // Utilisation and onboarding are derived per tenant, a handful of counts each; a page is at
    // most `limit` tenants, so this is bounded and needs no cache.
    const { ceilings, onboarding } = this.extras ?? {};
    const rows: TenantRow[] = await Promise.all(
      tenants.map(async (t) => ({
        ...t,
        utilisation: ceilings ? await ceilings.utilisation(t.id) : [],
        onboarding: onboarding
          ? await onboarding.state(t.id)
          : { steps: [], done: 0, total: 0, complete: false, dismissed: false, next: null },
      })),
    );
    return toListResponse("tenants", rows, total, query);
  }

  async createTenant(
    actor: OperatorActor,
    body: TenantCreateBody,
  ): Promise<{ company: Company; invitation: { to: string; language: "en" | "fi" } | null }> {
    const budgetDefault = await this.settings.get("cost.defaultMonthlyBudgetCents", []);
    const limit = body.monthlyBudgetCents ?? budgetDefault;
    let company: Company;
    try {
      company = await tenantTransaction(this.db, async (tx) => {
        const c = await tx.company.create({
          data: { name: body.name, region: body.region, monthlyBudgetCents: limit },
        });
        await tx.user.create({
          data: { companyId: c.id, email: body.adminEmail.toLowerCase(), role: "admin" },
        });
        await tx.budget.create({
          data: { companyId: c.id, scope: "tenant", scopeId: c.id, limitCents: limit, period: "month" },
        });
        return c;
      });
    } catch (err) {
      // The company insert rolls back with the user: no tenant is left without an admin.
      if (isUniqueViolation(err)) throw emailTaken();
      throw err;
    }
    // The language and the ceilings are tenant-scope settings, written as the operator does it
    // everywhere else: across tenants, in the system context.
    const values: Record<string, unknown> = { "branding.language": body.language };
    const ceilingKeys = {
      maxActiveCampaigns: "ceiling.maxActiveCampaigns",
      maxSessionsPerMonth: "ceiling.maxSessionsPerMonth",
      storageBytes: "ceiling.storageBytes",
      voiceMinutes: "ceiling.voiceMinutes",
    } as const;
    for (const [k, key] of Object.entries(ceilingKeys)) {
      const v = body.ceilings?.[k as keyof typeof ceilingKeys];
      if (v !== undefined) values[key] = v;
    }
    await withSystemTenant(async () =>
      this.settings.set({ scope: "tenant", scopeId: company.id }, values, actor.userId),
    );
    // The first admin is told, in the tenant's language. The key is the tenant's own id, so a
    // retried request or a replayed job is one mail (D-105).
    let invitation: { to: string; language: "en" | "fi" } | null = null;
    if (this.extras) {
      const productName = await withSystemTenant(async () =>
        this.settings.get("branding.productName", [{ scope: "tenant", scopeId: company.id }]),
      );
      const mail = tenantInvitationEmail({
        language: body.language,
        companyName: company.name,
        productName,
        signInUrl: `${this.extras.publicWebUrl.replace(/\/+$/, "")}/auth/signin?email=${encodeURIComponent(body.adminEmail.toLowerCase())}`,
      });
      await this.extras.jobs.publish("email.send", {
        to: body.adminEmail.toLowerCase(),
        subject: mail.subject,
        text: mail.text,
        companyId: company.id,
        idempotencyKey: `tenant-invite:${company.id}`,
      });
      invitation = { to: body.adminEmail.toLowerCase(), language: body.language };
    }
    await this.audit.record(company.id, {
      actorId: actor.userId,
      action: "tenant.create",
      targetType: "company",
      targetId: company.id,
      diff: {
        language: body.language,
        invited: invitation !== null,
        ceilings: Object.keys(body.ceilings ?? {}),
      },
    });
    return { company, invitation };
  }

  async updateTenant(actor: OperatorActor, id: string, body: TenantPatchBody): Promise<Company> {
    const existing = await this.db.company.findUnique({ where: { id } });
    if (!existing) throw notFound("Tenant");
    const tenant = await this.db.company.update({ where: { id: existing.id }, data: defined(body) });
    // This process sees the new status at once; the worker and any other replica within the
    // gate's short cache lifetime (S8).
    this.tenants.invalidate(tenant.id);
    if (body.monthlyBudgetCents !== undefined) {
      await this.db.budget.upsert({
        where: { scope_scopeId: { scope: "tenant", scopeId: tenant.id } },
        create: {
          companyId: tenant.id,
          scope: "tenant",
          scopeId: tenant.id,
          limitCents: body.monthlyBudgetCents,
          period: "month",
        },
        update: { limitCents: body.monthlyBudgetCents },
      });
    }
    await this.audit.record(tenant.id, {
      actorId: actor.userId,
      action: "tenant.update",
      targetType: "company",
      targetId: tenant.id,
      diff: body,
    });
    return tenant;
  }

  /** Platform-wide numbers: tenants, sessions by status, this month's spend per tenant. */
  async stats(_actor: OperatorActor): Promise<PlatformStats> {
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const [tenants, sessions, spend] = await Promise.all([
      this.db.company.count(),
      this.db.session.groupBy({ by: ["status"], _count: { _all: true } }),
      this.db.llmCall.groupBy({
        by: ["companyId"],
        where: { createdAt: { gte: monthStart } },
        _sum: { costCents: true },
        _count: { _all: true },
      }),
    ]);
    return {
      tenants,
      sessions: Object.fromEntries(sessions.map((s) => [s.status, s._count._all])),
      spendByTenant: spend.map((s) => ({
        companyId: s.companyId,
        costCents: s._sum.costCents ?? 0,
        calls: s._count._all,
      })),
    };
  }

  private exporter(): TenantExporter {
    const e = this.extras?.exporter;
    if (!e) throw new AppError("internal", "Tenant export is not configured");
    return e;
  }

  /**
   * Queues a signed, sealed export of a tenant (D-225). Audited under the operator's own company,
   * not the tenant's: the tenant's audit trail is what offboarding removes, and "who took a copy
   * of this tenant's data" has to outlive it.
   */
  async requestExport(
    actor: OperatorActor,
    operatorCompanyId: string,
    tenantId: string,
  ): Promise<{ queued: true }> {
    const tenant = await withSystemTenant(async () =>
      this.db.company.findUnique({ where: { id: tenantId }, select: { id: true, status: true } }),
    );
    if (!tenant || tenant.status === "deleted") throw notFound("Tenant");
    if (!this.extras) throw new AppError("internal", "Jobs are not configured");
    await this.extras.jobs.publish("tenant.export", { companyId: tenantId, requestedBy: actor.userId });
    await this.audit.record(operatorCompanyId, {
      actorId: actor.userId,
      action: "tenant.export_requested",
      targetType: "company",
      targetId: tenantId,
      diff: {},
    });
    return { queued: true };
  }

  async listExports(tenantId: string): Promise<ExportMeta[]> {
    return this.exporter().list(tenantId);
  }

  /** The decrypted archive of one export, with the audit row that says who took it. */
  async openExport(
    actor: OperatorActor,
    operatorCompanyId: string,
    tenantId: string,
    stamp: string,
  ): Promise<{ meta: ExportMeta; body: AsyncIterable<Buffer> }> {
    const exporter = this.exporter();
    const meta = await exporter.readMeta(tenantId, stamp);
    if (!meta) throw notFound("Export");
    const body = await exporter.open(tenantId, stamp);
    await this.audit.record(operatorCompanyId, {
      actorId: actor.userId,
      action: "tenant.export_downloaded",
      targetType: "company",
      targetId: tenantId,
      diff: { stamp },
    });
    return { meta, body };
  }

  /**
   * Starts offboarding (D-226): the tenant must be suspended first and the operator must type its
   * name. An export is taken now, and the purge is queued for after the grace period; reactivating
   * the tenant in between cancels it (the job checks). `immediate` queues the purge at once.
   */
  async requestOffboard(
    actor: OperatorActor,
    operatorCompanyId: string,
    tenantId: string,
    body: { confirmName: string; immediate: boolean },
  ): Promise<{ queued: true; purgeAfter: string | null }> {
    const tenant = await withSystemTenant(async () =>
      this.db.company.findUnique({ where: { id: tenantId }, select: { id: true, name: true, status: true } }),
    );
    if (!tenant || tenant.status === "deleted") throw notFound("Tenant");
    if (tenant.status !== "suspended")
      throw new AppError("conflict", "Suspend the tenant first: offboarding starts from a suspended tenant");
    if (body.confirmName !== tenant.name)
      throw new AppError("validation", "The confirmation does not match the tenant's name");
    if (!this.extras) throw new AppError("internal", "Jobs are not configured");
    await this.extras.jobs.publish("tenant.export", { companyId: tenantId, requestedBy: actor.userId });
    const graceSeconds = body.immediate ? 0 : OFFBOARD_GRACE_DAYS * 86_400;
    await this.extras.jobs.publish(
      "tenant.offboard",
      { companyId: tenantId, requestedBy: actor.userId, graceCheck: true },
      {
        singletonKey: `tenant.offboard:${tenantId}`,
        ...(graceSeconds > 0 ? { startAfterSeconds: graceSeconds } : {}),
      },
    );
    const purgeAfter = graceSeconds > 0 ? new Date(Date.now() + graceSeconds * 1000).toISOString() : null;
    await this.audit.record(operatorCompanyId, {
      actorId: actor.userId,
      action: "tenant.offboard_requested",
      targetType: "company",
      targetId: tenantId,
      diff: { immediate: body.immediate, purgeAfter },
    });
    return { queued: true, purgeAfter };
  }

  /**
   * A job's audit row lands on the tenant it belonged to, if that tenant still exists; otherwise
   * on the operator's own company. A job verb is audited with this.
   */
  async auditJob(
    actor: OperatorActor,
    entry: {
      jobCompanyId: string | null;
      fallbackCompanyId: string;
      action: string;
      targetId: string;
      diff?: unknown;
    },
  ): Promise<void> {
    let companyId = entry.fallbackCompanyId;
    if (entry.jobCompanyId) {
      const id = entry.jobCompanyId;
      const found = await withSystemTenant(async () =>
        this.db.company.findUnique({ where: { id }, select: { id: true } }),
      );
      if (found) companyId = found.id;
    }
    await this.audit.record(companyId, {
      actorId: actor.userId,
      action: entry.action,
      targetType: "job",
      targetId: entry.targetId,
      ...(entry.diff !== undefined ? { diff: entry.diff } : {}),
    });
  }
}
