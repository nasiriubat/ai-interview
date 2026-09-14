import type { NewMessage, SessionSnapshot, SessionStore, StoredMessage } from "@aidp/ai";
import { tenantTransaction } from "@aidp/db";
import {
  HandoffSchema,
  InterviewTemplateSchema,
  SessionStateSchema,
  WidgetResponseSchema,
  WidgetSchema,
  type InterviewTemplate,
  type Modality,
  type Path,
  type SessionState,
} from "@aidp/shared";
import type { InterviewTemplate as TemplateRow, Prisma, PrismaClient } from "@prisma/client";

/** The template contract parsed from its database row. */
export function templateFromRow(t: TemplateRow): InterviewTemplate {
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

/** SessionStore on Prisma. Message sequence numbers are assigned in a transaction. */
export class PrismaSessionStore implements SessionStore {
  constructor(private readonly db: PrismaClient) {}

  async appendMessage(sessionId: string, m: NewMessage): Promise<StoredMessage> {
    return tenantTransaction(this.db, async (tx) => {
      const last = await tx.message.findFirst({
        where: { sessionId },
        orderBy: { seq: "desc" },
        select: { seq: true },
      });
      const row = await tx.message.create({
        data: {
          sessionId,
          seq: (last?.seq ?? 0) + 1,
          role: m.role,
          modality: m.modality,
          content: m.content,
          ...(m.widget ? { widget: m.widget } : {}),
          ...(m.widgetResponse ? { widgetResponse: m.widgetResponse } : {}),
          areaKey: m.areaKey ?? null,
        },
      });
      return toStored(row);
    });
  }

  async recentMessages(sessionId: string, limit: number): Promise<StoredMessage[]> {
    const rows = await this.db.message.findMany({
      where: { sessionId },
      orderBy: { seq: "desc" },
      take: limit,
    });
    return rows.reverse().map(toStored);
  }

  async messagesAfter(sessionId: string, seq: number): Promise<StoredMessage[]> {
    const rows = await this.db.message.findMany({
      where: { sessionId, seq: { gt: seq } },
      orderBy: { seq: "asc" },
    });
    return rows.map(toStored);
  }

  async saveState(sessionId: string, state: SessionState): Promise<void> {
    await this.db.session.update({
      where: { id: sessionId },
      data: { state: state as Prisma.InputJsonValue },
    });
  }

  async saveSummary(sessionId: string, summary: string): Promise<void> {
    await this.db.session.update({ where: { id: sessionId }, data: { summary } });
  }

  async appendEvent(sessionId: string, type: string, payload: unknown): Promise<void> {
    await tenantTransaction(this.db, async (tx) => {
      const last = await tx.sessionEvent.findFirst({
        where: { sessionId },
        orderBy: { seq: "desc" },
        select: { seq: true },
      });
      await tx.sessionEvent.create({
        data: { sessionId, seq: (last?.seq ?? 0) + 1, type, payload: payload as Prisma.InputJsonValue },
      });
    });
  }

  /** Loads what the engine needs. Throws when the session does not exist. */
  async snapshot(
    sessionId: string,
  ): Promise<SessionSnapshot & { status: string; modePreference: string; participantId: string | null }> {
    const row = await this.db.session.findUniqueOrThrow({
      where: { id: sessionId },
      include: { template: true },
    });
    const template = templateFromRow(row.template);
    const handoff = row.handoff ? HandoffSchema.safeParse(row.handoff) : undefined;
    return {
      id: row.id,
      companyId: row.companyId,
      ...(row.campaignId ? { campaignId: row.campaignId } : {}),
      template,
      state: SessionStateSchema.parse(row.state),
      summary: row.summary,
      ...(row.path ? { path: row.path as Path } : {}),
      ...(handoff?.success ? { handoff: handoff.data } : {}),
      status: row.status,
      modePreference: row.modePreference,
      participantId: row.participantId,
    };
  }
}

export function toStored(row: {
  id: string;
  seq: number;
  role: string;
  modality: string;
  content: string;
  widget: unknown;
  widgetResponse: unknown;
  areaKey: string | null;
  createdAt: Date;
}): StoredMessage {
  const widget = row.widget ? WidgetSchema.safeParse(row.widget) : undefined;
  const response = row.widgetResponse ? WidgetResponseSchema.safeParse(row.widgetResponse) : undefined;
  return {
    id: row.id,
    seq: row.seq,
    role: row.role as "user" | "assistant",
    modality: row.modality as Modality,
    content: row.content,
    ...(widget?.success ? { widget: widget.data } : {}),
    ...(response?.success ? { widgetResponse: response.data } : {}),
    ...(row.areaKey ? { areaKey: row.areaKey } : {}),
    createdAt: row.createdAt,
  };
}
