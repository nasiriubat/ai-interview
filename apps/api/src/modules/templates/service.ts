import type { InterviewTemplate as Template } from "@prisma/client";
import { Prisma, type PrismaClient } from "@prisma/client";
import { shippedTemplate } from "@aidp/db";
import { InterviewTemplateSchema, type InterviewTemplate, type InterviewTemplateInput } from "@aidp/shared";
import { AppError, notFound } from "../../lib/errors.js";

/** A template body as accepted by the API: everything but the version, which the service assigns. */
export type TemplateBodyInput = Omit<InterviewTemplateInput, "version">;

/** Templates are versioned rows: an update creates version n+1 and archives the previous one (FR-60 to FR-63). */
export class TemplateService {
  constructor(private readonly db: PrismaClient) {}

  list(companyId: string): Promise<Template[]> {
    return this.db.interviewTemplate.findMany({
      where: { OR: [{ companyId }, { companyId: null }], status: { not: "archived" } },
      orderBy: [{ key: "asc" }, { version: "desc" }],
    });
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
    const t = InterviewTemplateSchema.parse({
      ...fromRow(source),
      key: existing ? `${key}_${existing + 1}` : key,
      version: 1,
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
    const current = await this.get(companyId, id);
    if (current.companyId !== companyId)
      throw new AppError("forbidden", "Copy a platform template before editing it");
    const t = InterviewTemplateSchema.parse({ ...input, key: current.key, version: current.version + 1 });
    return this.db.$transaction(async (tx) => {
      await tx.interviewTemplate.update({ where: { id: current.id }, data: { status: "archived" } });
      return tx.interviewTemplate.create({
        data: {
          ...toRow(t),
          companyId,
          status: current.status === "published" ? "published" : "draft",
          createdById,
        },
      });
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
