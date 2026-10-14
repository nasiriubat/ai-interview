import type { SettingsService } from "@aidp/core";
import { containsInsensitive, shippedTemplate, tenantBatch, tenantTransaction } from "@aidp/db";
import { InterviewTemplateSchema, type InterviewTemplate, type InterviewTemplateInput } from "@aidp/shared";
import { Prisma, type InterviewTemplate as Template, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { AppError, notFound } from "../../lib/errors.js";
import { listOrder, listQuery, listSpec, searchTerm } from "../../lib/pagination.js";

/**
 * `/templates` (D-79): the tenant's own templates and the platform's, one row per version.
 * `q` matches the name or the key. Without `status`, archived versions are left out. `updatedAt`
 * is the version's creation time: a template is edited by writing a new version row.
 */
export const TemplateList = listSpec({
  sort: { key: "asc", name: "asc", updatedAt: "desc" },
  defaultSort: "key",
  columns: { updatedAt: "createdAt" },
  filters: {
    status: z.enum(["draft", "published", "archived"]).optional(),
    origin: z.enum(["tenant", "platform"]).optional(),
  },
});

export const TemplateListQuery = listQuery(TemplateList);
export type TemplateListQuery = z.output<typeof TemplateListQuery>;

/** The picker's window: every usable template, since the catalogue is small. */
export const ALL_TEMPLATES: Pick<TemplateListQuery, "limit" | "offset" | "sort"> = {
  limit: 200,
  offset: 0,
  sort: "key",
};

/** A template body as accepted by the API: everything but the version, which the service assigns. */
export type TemplateBodyInput = Omit<InterviewTemplateInput, "version">;

/** One version of a template key, as the history panel lists it. */
export interface TemplateVersionView {
  id: string;
  version: number;
  status: string;
  createdAt: Date;
  createdBy: { id: string; name: string | null; email: string } | null;
  /** Fields whose value differs from the version before it; empty for the first version. */
  changedFields: string[];
  /** Campaigns pinned to this exact row (FR-62): they keep it whatever happens to newer versions. */
  campaigns: number;
  /** The highest version of the key: the one new campaigns pick up. */
  latest: boolean;
}

/** Templates are versioned rows: an update creates version n+1 and archives the previous one (FR-60 to FR-63). */
export class TemplateService {
  /**
   * `settings` carries template-scoped settings from one version to the next and answers
   * `features.chaining`. A tool that never edits templates may omit it.
   */
  constructor(
    private readonly db: PrismaClient,
    private readonly settings?: SettingsService,
  ) {}

  /** `features.chaining` off refuses a template that starts another one; clearing the link is always allowed. */
  private async assertChaining(
    companyId: string,
    next: string | null,
    previous: string | null = null,
  ): Promise<void> {
    if (next === null || next === previous || !this.settings) return;
    const on = await this.settings.get("features.chaining", [{ scope: "tenant", scopeId: companyId }]);
    if (!on) throw new AppError("feature_disabled", "Chaining templates is turned off for this organization");
  }

  /** The highest version of the key this row belongs to (the row itself when it is the only one). */
  private latestOf(row: Template): Promise<Template> {
    return this.db.interviewTemplate.findFirstOrThrow({
      where: { companyId: row.companyId, key: row.key },
      orderBy: { version: "desc" },
    });
  }

  /** Every version of the template's key, newest first (FR-62). Platform templates list too: they just cannot be restored. */
  async versions(companyId: string, id: string): Promise<TemplateVersionView[]> {
    const row = await this.get(companyId, id);
    const rows = await this.db.interviewTemplate.findMany({
      where: { companyId: row.companyId, key: row.key },
      orderBy: { version: "desc" },
    });
    const authorIds = [...new Set(rows.map((r) => r.createdById).filter((v): v is string => v !== null))];
    const [authors, pinned] = await Promise.all([
      authorIds.length
        ? this.db.user.findMany({
            where: { id: { in: authorIds }, companyId },
            select: { id: true, name: true, email: true },
          })
        : [],
      this.db.campaign.groupBy({
        by: ["templateId"],
        where: { companyId, templateId: { in: rows.map((r) => r.id) } },
        _count: { _all: true },
      }),
    ]);
    const authorOf = new Map(authors.map((a) => [a.id, a]));
    const pinnedTo = new Map(pinned.map((p) => [p.templateId, p._count._all]));
    return rows.map((r, i) => {
      const before = rows[i + 1];
      const a = r.createdById ? authorOf.get(r.createdById) : undefined;
      return {
        id: r.id,
        version: r.version,
        status: r.status,
        createdAt: r.createdAt,
        createdBy: a ?? null,
        changedFields: before ? changedFields(fromRow(before), fromRow(r)) : [],
        campaigns: pinnedTo.get(r.id) ?? 0,
        latest: i === 0,
      };
    });
  }

  /**
   * A new version with the content of an old one (FR-62). History is never rewritten: the new row
   * is `max + 1`, the previous latest is archived the way an edit archives it, and campaigns
   * pinned to any older row are untouched. Template-scoped settings come from the version that
   * was in force, not from the old one: they are configuration, not content.
   */
  async restore(companyId: string, fromId: string, createdById: string): Promise<Template> {
    const source = await this.get(companyId, fromId);
    if (source.companyId !== companyId)
      throw new AppError("forbidden", "Platform templates cannot be restored; copy one first");
    const latest = await this.latestOf(source);
    if (latest.id === source.id)
      throw new AppError("conflict", "This is already the current version; there is nothing to restore");
    const t = InterviewTemplateSchema.parse({ ...fromRow(source), version: latest.version + 1 });
    await this.assertChaining(companyId, t.chainToKey, latest.chainToKey);
    return tenantTransaction(this.db, async (tx) => {
      if (latest.status !== "archived")
        await tx.interviewTemplate.update({ where: { id: latest.id }, data: { status: "archived" } });
      const created = await tx.interviewTemplate.create({
        data: {
          ...toRow(t),
          companyId,
          status: latest.status === "published" ? "published" : "draft",
          createdById,
        },
      });
      await this.settings?.copyTemplateSettings(tx, latest.id, created.id, createdById);
      return created;
    });
  }

  /**
   * One page of the templates this tenant can use: its own and the platform's (D-79). Archived
   * versions are left out unless `status` asks for them, as the unfiltered list always has.
   */
  async list(
    companyId: string,
    query: Pick<TemplateListQuery, "limit" | "offset" | "sort"> &
      Partial<Pick<TemplateListQuery, "q" | "status" | "origin" | "dir">> = ALL_TEMPLATES,
  ): Promise<{ templates: Template[]; total: number }> {
    const q = searchTerm(query.q);
    const owner =
      query.origin === "tenant"
        ? { companyId }
        : query.origin === "platform"
          ? { companyId: null }
          : { OR: [{ companyId }, { companyId: null }] };
    const where: Prisma.InterviewTemplateWhereInput = {
      AND: [
        owner,
        { status: query.status ?? { not: "archived" } },
        ...(q ? [{ OR: [{ name: containsInsensitive(q) }, { key: containsInsensitive(q) }] }] : []),
      ],
    };
    const dir = query.dir ?? TemplateList.sort[query.sort];
    // A key sorts its versions newest first, so the current version heads its group.
    const orderBy: Prisma.InterviewTemplateOrderByWithRelationInput[] =
      query.sort === "key"
        ? [{ key: dir }, { version: "desc" }, { id: dir }]
        : listOrder<Prisma.InterviewTemplateOrderByWithRelationInput, TemplateListQuery["sort"]>(
            TemplateList,
            query,
          );
    const [templates, total] = await tenantBatch(this.db, [
      this.db.interviewTemplate.findMany({ where, orderBy, take: query.limit, skip: query.offset }),
      this.db.interviewTemplate.count({ where }),
    ]);
    return { templates, total };
  }

  async get(companyId: string, id: string): Promise<Template> {
    const t = await this.db.interviewTemplate.findFirst({
      where: { id, OR: [{ companyId }, { companyId: null }] },
    });
    if (!t) throw notFound("Template");
    return t;
  }

  async create(companyId: string, input: TemplateBodyInput, createdById: string): Promise<Template> {
    const t = InterviewTemplateSchema.parse({ ...input, version: 1 });
    await this.assertChaining(companyId, t.chainToKey);
    const clash = await this.db.interviewTemplate.findFirst({ where: { companyId, key: t.key } });
    if (clash) throw new AppError("conflict", `A template with key '${t.key}' already exists`);
    return this.db.interviewTemplate.create({
      data: { ...toRow(t), companyId, status: "draft", createdById },
    });
  }

  async copy(companyId: string, sourceId: string, createdById: string): Promise<Template> {
    const source = await this.get(companyId, sourceId);
    const key = source.companyId === companyId ? `${source.key}_copy` : source.key;
    const existing = await this.db.interviewTemplate.count({ where: { companyId, key } });
    // A copy made while chaining is off drops the link rather than refusing: copying the shipped
    // opportunity template is how a tenant starts, and the link can be set again once it is on.
    const chaining =
      !this.settings ||
      (await this.settings.get("features.chaining", [{ scope: "tenant", scopeId: companyId }]));
    const t = InterviewTemplateSchema.parse({
      ...fromRow(source),
      key: existing ? `${key}_${existing + 1}` : key,
      version: 1,
      ...(chaining ? {} : { chainToKey: null, chainMapping: null }),
    });
    return this.db.interviewTemplate.create({
      data: { ...toRow(t), companyId, status: "draft", createdById },
    });
  }

  /** New version. Platform-seeded templates cannot be edited in place: copy first. */
  async update(
    companyId: string,
    id: string,
    input: TemplateBodyInput,
    createdById: string,
  ): Promise<Template> {
    const row = await this.get(companyId, id);
    if (row.companyId !== companyId)
      throw new AppError("forbidden", "Copy a platform template before editing it");
    // An edit always builds on the latest version of the key, so editing a stale page cannot
    // collide with a version that was written since, and the settings it carries are the ones
    // in force now.
    const current = await this.latestOf(row);
    const t = InterviewTemplateSchema.parse({ ...input, key: current.key, version: current.version + 1 });
    await this.assertChaining(companyId, t.chainToKey, current.chainToKey);
    return tenantTransaction(this.db, async (tx) => {
      await tx.interviewTemplate.update({ where: { id: current.id }, data: { status: "archived" } });
      const created = await tx.interviewTemplate.create({
        data: {
          ...toRow(t),
          companyId,
          status: current.status === "published" ? "published" : "draft",
          createdById,
        },
      });
      // Settings are keyed by the row id and a version is a new row; without this every edit
      // silently dropped the template's own settings (blueprint section 0, item 3).
      await this.settings?.copyTemplateSettings(tx, current.id, created.id, createdById);
      return created;
    });
  }

  async setStatus(companyId: string, id: string, status: "published" | "archived"): Promise<Template> {
    const current = await this.get(companyId, id);
    if (current.companyId !== companyId)
      throw new AppError("forbidden", "Platform templates cannot be changed");
    return this.db.interviewTemplate.update({ where: { id: current.id }, data: { status } });
  }

  async diffShipped(
    companyId: string,
    id: string,
  ): Promise<{ shipped: InterviewTemplate | null; current: InterviewTemplate; changedFields: string[] }> {
    const current = fromRow(await this.get(companyId, id));
    const shipped = shippedTemplate(current.key.replace(/_copy(_\d+)?$/, "")) ?? null;
    const changedFields = shipped
      ? (Object.keys(current) as (keyof InterviewTemplate)[]).filter(
          (k) => k !== "version" && k !== "key" && JSON.stringify(current[k]) !== JSON.stringify(shipped[k]),
        )
      : [];
    return { shipped, current, changedFields };
  }
}

/** The fields of a template whose value differs between two versions. */
export function changedFields(before: InterviewTemplate, after: InterviewTemplate): string[] {
  return (Object.keys(after) as (keyof InterviewTemplate)[]).filter(
    (k) => k !== "version" && JSON.stringify(before[k]) !== JSON.stringify(after[k]),
  );
}

export function fromRow(t: Template): InterviewTemplate {
  return InterviewTemplateSchema.parse({
    key: t.key,
    version: t.version,
    name: t.name,
    language: t.language,
    objective: t.objective,
    privacyMode: t.privacyMode,
    participantFields: t.participantFields,
    pathSelection: t.pathSelection,
    contextBlock: t.contextBlock,
    coverageAreas: t.coverageAreas,
    aiInstructions: t.aiInstructions,
    adaptivity: t.adaptivity,
    widgetPolicy: t.widgetPolicy,
    issueDetection: t.issueDetection,
    outputs: t.outputs,
    analysisEnabled: t.analysisEnabled,
    chainToKey: t.chainToKey,
    chainMapping: t.chainMapping,
    closingQuestion: t.closingQuestion,
    endSummary: t.endSummary,
    maxTurns: t.maxTurns,
    maxAssistantChars: t.maxAssistantChars,
  });
}

function toRow(t: InterviewTemplate) {
  const json = (v: unknown) => v as Prisma.InputJsonValue;
  return {
    key: t.key,
    version: t.version,
    name: t.name,
    language: t.language,
    objective: t.objective,
    privacyMode: t.privacyMode,
    participantFields: json(t.participantFields),
    pathSelection: t.pathSelection,
    contextBlock: json(t.contextBlock),
    coverageAreas: json(t.coverageAreas),
    aiInstructions: t.aiInstructions,
    adaptivity: json(t.adaptivity),
    widgetPolicy: json(t.widgetPolicy),
    issueDetection: json(t.issueDetection),
    outputs: json(t.outputs),
    analysisEnabled: t.analysisEnabled,
    chainToKey: t.chainToKey,
    chainMapping: t.chainMapping === null ? Prisma.JsonNull : json(t.chainMapping),
    closingQuestion: t.closingQuestion,
    endSummary: t.endSummary,
    maxTurns: t.maxTurns,
    maxAssistantChars: t.maxAssistantChars,
  };
}
