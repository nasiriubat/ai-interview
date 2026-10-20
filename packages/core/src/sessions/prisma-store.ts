import {
  addExtractedFacts,
  reconcileBackgroundProgress,
  type ExtractionCommit,
  type NewMessage,
  type SessionSnapshot,
  type SessionStore,
  type StoredMessage,
} from "@aidp/ai";
import { tenantTransaction } from "@aidp/db";
import {
  HandoffSchema,
  InterviewTemplateSchema,
  SessionStateSchema,
  WidgetResponseSchema,
  WidgetSchema,
  type Fact,
  type InterviewTemplate,
  type Modality,
  type RecapCache,
  type SessionEventType,
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
  /**
   * `widgets: false` is `features.optionsView` off (D-187): the template the engine sees allows no
   * widget, so the prompt says none and `admitWidget` drops any the model sends anyway.
   */
  constructor(
    private readonly db: PrismaClient,
    private readonly options: { widgets?: boolean } = {},
  ) {}

  async appendMessage(sessionId: string, m: NewMessage): Promise<StoredMessage> {
    return tenantTransaction(this.db, async (tx) => {
      const last = await tx.message.findFirst({
        where: { sessionId },
        orderBy: { seq: "desc" },
        select: { seq: true },
      });
      const row = await tx.message.create({
        data: {
          companyId: await sessionCompany(tx, sessionId),
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

  /**
   * Whole-state write, for the turn. Reconciled against the stored document under a row lock so a
   * turn that started before a background job committed cannot move the job's cursors backwards
   * (see `reconcileBackgroundProgress`).
   */
  async saveState(sessionId: string, state: SessionState): Promise<void> {
    await tenantTransaction(this.db, async (tx) => {
      const rows = await tx.$queryRaw<{ state: unknown }[]>`
        SELECT state FROM "Session" WHERE id = ${sessionId} FOR UPDATE`;
      const stored = SessionStateSchema.safeParse(rows[0]?.state ?? {});
      const next = stored.success ? reconcileBackgroundProgress(stored.data, state) : state;
      await tx.session.update({
        where: { id: sessionId },
        data: { state: next as Prisma.InputJsonValue },
      });
    });
  }

  async commitSummary(sessionId: string, summary: string, upToSeq: number): Promise<void> {
    await tenantTransaction(this.db, async (tx) => {
      // Only the one key, and only forwards: the document may have moved on since the job read it.
      await tx.$executeRaw`
        UPDATE "Session"
        SET summary = ${summary},
            state = jsonb_set(state, '{summaryUpToSeq}', to_jsonb(
              GREATEST(COALESCE((state->>'summaryUpToSeq')::int, 0), ${upToSeq}::int)))
        WHERE id = ${sessionId} AND status <> 'deleted'`;
    });
  }

  /**
   * Caches the resume recap in the state document (D-172). One key is patched, so a turn or a
   * background job running beside a page load is not undone.
   */
  async commitRecap(sessionId: string, recap: RecapCache): Promise<void> {
    await tenantTransaction(this.db, async (tx) => {
      await tx.$executeRaw`
        UPDATE "Session"
        SET state = jsonb_set(COALESCE(state, '{}'::jsonb), '{recap}', ${JSON.stringify(recap)}::jsonb)
        WHERE id = ${sessionId} AND status <> 'deleted'`;
    });
  }

  async appendEvent(sessionId: string, type: SessionEventType, payload: unknown): Promise<void> {
    await tenantTransaction(this.db, (tx) => appendEventIn(tx, sessionId, type, payload));
  }

  /**
   * One extraction batch in one transaction (FR-14, NFR-09). The cursor compare-and-set is the
   * first statement and also takes the row lock, so two overlapping runs serialize here and the
   * loser sees a moved cursor, writes nothing and reports `stale`.
   *
   * The state is patched in place with `jsonb_set` rather than replaced: the stored document is
   * the source of truth for everything this job does not own, and the facts are appended to what
   * is stored, not to what the job read minutes ago.
   */
  async commitExtraction(sessionId: string, c: ExtractionCommit): Promise<"committed" | "stale"> {
    return tenantTransaction(this.db, async (tx) => {
      // The row lock first: the cursor compare below and the write after it are one critical
      // section, and the facts the batch is added to are the ones stored now (D-302).
      const rows = await tx.$queryRaw<{ facts: unknown; cursor: number }[]>`
        SELECT COALESCE(state->'facts', '[]'::jsonb) AS facts,
               COALESCE((state->>'lastExtractedSeq')::int, 0) AS cursor
        FROM "Session"
        WHERE id = ${sessionId} AND status <> 'deleted'
        FOR UPDATE`;
      const row = rows[0];
      if (row?.cursor !== c.fromSeq) return "stale";
      const stored = Array.isArray(row.facts) ? (row.facts as Fact[]) : [];
      // A spec field already held under the same id is not appended a second time, and a
      // different capability under a taken id is renumbered, so no id lists two things.
      const added = addExtractedFacts(stored, c.facts);
      await tx.$executeRaw`
        UPDATE "Session"
        SET state = jsonb_set(
              jsonb_set(state, '{lastExtractedSeq}', to_jsonb(${c.toSeq}::int)),
              '{facts}',
              ${JSON.stringify(added.facts)}::jsonb)
        WHERE id = ${sessionId}`;
      if (added.accepted.length > 0) {
        // (sessionId, batchEndSeq, ordinal) is unique: a batch that somehow commits twice
        // writes its rows once.
        await tx.fact.createMany({
          skipDuplicates: true,
          data: added.accepted.map((f, ordinal) => ({
            companyId: c.companyId,
            sessionId,
            kind: f.kind,
            payload: f as Prisma.InputJsonValue,
            extractorVersion: c.extractorVersion,
            ...(c.language ? { language: c.language } : {}),
            batchEndSeq: c.toSeq,
            ordinal,
          })),
        });
      }
      await appendEventIn(tx, sessionId, "facts_extracted", {
        ...c.event,
        count: added.accepted.length,
        ...(added.dropped > 0 ? { droppedAtCommit: added.dropped } : {}),
      });
      return "committed";
    });
  }

  /** Loads what the engine needs. Throws when the session does not exist. */
  async snapshot(
    sessionId: string,
  ): Promise<SessionSnapshot & { status: string; modePreference: string; participantId: string | null }> {
    const row = await this.db.session.findUniqueOrThrow({
      where: { id: sessionId },
      include: {
        template: true,
        // Documents and images only: a voice recording's transcript is already the participant's
        // own turn in the transcript, so listing it again would say everything twice.
        attachments: {
          where: { kind: { in: ["document", "image"] } },
          select: { filename: true, kind: true, summary: true, status: true },
          orderBy: { createdAt: "asc" },
          take: 20,
        },
        participant: { select: { fields: true } },
      },
    });
    const parsed = templateFromRow(row.template);
    const template =
      this.options.widgets === false
        ? { ...parsed, widgetPolicy: { ...parsed.widgetPolicy, allowedTypes: [], maxPerTurns: 0 } }
        : parsed;
    const handoff = row.handoff ? HandoffSchema.safeParse(row.handoff) : undefined;
    return {
      id: row.id,
      companyId: row.companyId,
      ...(row.campaignId ? { campaignId: row.campaignId } : {}),
      template,
      state: withFormProfile(SessionStateSchema.parse(row.state), row.participant?.fields),
      summary: row.summary,
      ...(row.path ? { path: row.path as Path } : {}),
      ...(handoff?.success ? { handoff: handoff.data } : {}),
      ...(row.attachments.length > 0
        ? {
            attachments: row.attachments.map((a) => ({
              filename: a.filename,
              kind: a.kind,
              summary: a.summary ?? "",
              status: a.status,
            })),
          }
        : {}),
      status: row.status,
      modePreference: row.modePreference,
      participantId: row.participantId,
    };
  }
}

type Tx = Parameters<Parameters<typeof tenantTransaction>[1]>[0];

/** Takes the session row lock for the rest of the transaction. Re-entrant: the holder may take it again. */
export async function lockSessionRow(tx: Tx, sessionId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "Session" WHERE id = ${sessionId} FOR UPDATE`;
}

async function appendEventIn(
  tx: Tx,
  sessionId: string,
  type: SessionEventType,
  payload: unknown,
): Promise<void> {
  // The next number is "highest so far plus one", which is only right for one writer at a time.
  // A turn (the API) and an extraction commit (the worker) append to the same session within
  // milliseconds of each other, and without this lock both read the same highest seq: the second
  // insert fails the (sessionId, seq) unique constraint, and when that is the participant's turn the
  // participant is told "Something went wrong" mid-interview (found by the full-stack drill, one
  // participant, turn 12 of 20). The session row is the one thing every writer already contends
  // on, so locking it serializes the appends and nothing else.
  await lockSessionRow(tx, sessionId);
  const last = await tx.sessionEvent.findFirst({
    where: { sessionId },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  await tx.sessionEvent.create({
    data: {
      companyId: await sessionCompany(tx, sessionId),
      sessionId,
      seq: (last?.seq ?? 0) + 1,
      type,
      payload: payload as Prisma.InputJsonValue,
    },
  });
  if (type === "flag") {
    // The first flag of a session wins and stays (D-173); the where clause makes a later one a
    // no-op on the row while its event is still appended above.
    const raw = (payload as { reason?: unknown } | null)?.reason;
    const reason = typeof raw === "string" ? raw.slice(0, 1000) : "";
    await tx.session.updateMany({
      where: { id: sessionId, flagged: false },
      data: { flagged: true, flagReason: reason, flaggedAt: new Date() },
    });
  }
}

/**
 * "I'm done": sets `finishRequested` on the session's state so the next turn is the closing
 * question (D-170). One key is patched in place rather than the whole document rewritten, so a
 * running turn or background job is not undone, and `turnCount` is never touched (the sentinel
 * this replaces corrupted turn statistics). A no-op on a completed or deleted session.
 */
export async function requestFinish(db: PrismaClient, sessionId: string): Promise<void> {
  await tenantTransaction(db, async (tx) => {
    await tx.$executeRaw`
      UPDATE "Session"
      SET state = jsonb_set(COALESCE(state, '{}'::jsonb), '{finishRequested}', 'true'::jsonb)
      WHERE id = ${sessionId} AND status NOT IN ('completed', 'deleted')`;
  });
}

/**
 * The tenant a session belongs to, read from the session row itself. Child rows carry it as a
 * denormalised column behind a composite foreign key (D-140), so the writer states the owner it
 * read rather than the one the request context happens to hold; under the system context those
 * differ and the key would refuse the write.
 */
async function sessionCompany(tx: Tx, sessionId: string): Promise<string> {
  const row = await tx.session.findUniqueOrThrow({ where: { id: sessionId }, select: { companyId: true } });
  return row.companyId;
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

/**
 * The role and department the participant typed on the details screen, until the interview has
 * learned its own. Without them the first question asked for the role the person had just given.
 */
export function withFormProfile(state: SessionState, fields: unknown): SessionState {
  const form = (fields ?? {}) as Record<string, unknown>;
  const text = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : undefined;
  const role = state.profile.role ?? text(form.role);
  const department = state.profile.department ?? text(form.department);
  return {
    ...state,
    profile: { ...state.profile, ...(role ? { role } : {}), ...(department ? { department } : {}) },
  };
}
