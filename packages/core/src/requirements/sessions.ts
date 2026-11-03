import { mergeFacts } from "@aidp/ai";
import { containsInsensitive, tenantBatch } from "@aidp/db";
import {
  SessionStateSchema,
  SPEC_SECTION_KEYS,
  type Finding,
  type FindingOutcome,
  type LiveSpec,
  type Path,
  type SessionInvitation,
  type SessionState,
  type SpecEdits,
} from "@aidp/shared";
import type { Prisma } from "@prisma/client";
import { newToken } from "../crypto.js";
import { requestFinish, templateFromRow, toStored } from "../sessions/prisma-store.js";
import type { RequirementsContext } from "./context.js";
import { InvalidSectionError, PathRequiredError, RequirementsNotFoundError } from "./errors.js";
import {
  parseEdits,
  pathOf,
  publicInvitations,
  reopenedState,
  REQUIREMENTS_TEMPLATE_KEY,
  versionSummary,
} from "./helpers.js";
import type {
  RequirementsListItem,
  RequirementsServiceDeps,
  RequirementsSession,
  SpecVersionSummary,
  Viewer,
} from "./types.js";

/** Creation, the live spec, owner edits and finding outcomes, and template preview. */
export class RequirementsSessions {
  constructor(private readonly cx: RequirementsContext) {}

  private get deps(): RequirementsServiceDeps {
    return this.cx.deps;
  }

  async create(
    companyId: string,
    ownerUserId: string,
    input: {
      title: string;
      prompt?: string | undefined;
      path?: Path | undefined;
      templateId?: string | undefined;
      /** Accepted for the contract; the template's language governs the interview and the document. */
      language?: string | undefined;
    },
  ): Promise<RequirementsSession> {
    const { db } = this.deps;
    const template = input.templateId
      ? await db.interviewTemplate.findFirst({
          where: { id: input.templateId, status: "published", OR: [{ companyId }, { companyId: null }] },
        })
      : await this.cx.requirementsTemplate(companyId);
    if (!template) throw new RequirementsNotFoundError("Template");
    const parsed = templateFromRow(template);

    let state = SessionStateSchema.parse({});
    const prompt = input.prompt?.trim();
    if (prompt) {
      state = {
        ...state,
        facts: mergeFacts(state.facts, [
          { kind: "spec_field", section: "overview", path: "idea", value: prompt, source: "user" },
        ]),
        coverage: parsed.coverageAreas.some((a) => a.key === "problem")
          ? {
              ...state.coverage,
              problem: {
                status: "partial",
                known: prompt.slice(0, 200),
                missing: "confirm the problem and success measure",
                followUpsUsed: 0,
              },
            }
          : state.coverage,
      };
    }
    const row = await db.session.create({
      data: {
        companyId,
        templateId: template.id,
        ownerUserId,
        sourceKind: "text",
        title: input.title.trim().slice(0, 120),
        ...(input.path ? { path: input.path } : {}),
        status: "consented",
        consentedAt: new Date(),
        state: state as Prisma.InputJsonValue,
        templateVersion: template.version,
      },
      include: { template: true },
    });
    return this.cx.sessionView(row);
  }

  /**
   * One page of requirements sessions with the row count beside it (contract 19). `q` matches the
   * title and `status` narrows; both only ever narrow the viewer's own set (D-79). Newest first
   * unless `orderBy` says otherwise.
   */
  async list(
    companyId: string,
    viewer: Viewer,
    page: {
      limit: number;
      offset: number;
      q?: string | undefined;
      status?: string | undefined;
      orderBy?: Prisma.SessionOrderByWithRelationInput[];
    } = { limit: 50, offset: 0 },
  ): Promise<{ sessions: RequirementsListItem[]; total: number }> {
    const where: Prisma.SessionWhereInput = {
      companyId,
      ownerUserId: viewer.role === "member" ? viewer.userId : { not: null },
      template: { key: REQUIREMENTS_TEMPLATE_KEY },
      // Template previews are owned sessions too; their participant is the previewing admin.
      OR: [{ participantId: null }, { participant: { userId: null } }],
      AND: [
        { status: { not: "deleted" } },
        ...(page.status ? [{ status: page.status }] : []),
        ...(page.q ? [{ title: containsInsensitive(page.q) }] : []),
      ],
    };
    const [rows, total] = await tenantBatch(this.deps.db, [
      this.deps.db.session.findMany({
        where,
        include: { owner: { select: { email: true } }, _count: { select: { specs: true } } },
        orderBy: page.orderBy ?? [{ createdAt: "desc" }],
        take: page.limit,
        skip: page.offset,
      }),
      this.deps.db.session.count({ where }),
    ]);
    const sessions = rows.map((r) => {
      const state = SessionStateSchema.safeParse(r.state);
      const findings = state.success ? state.data.findings : [];
      return {
        id: r.id,
        title: r.title,
        status: r.status,
        path: pathOf(r.path),
        sourceKind: r.sourceKind,
        ownerUserId: r.ownerUserId,
        ...(r.owner ? { ownerEmail: r.owner.email } : {}),
        versions: r._count.specs,
        openFindings: findings.filter((f) => f.status === "open" || f.status === "raised").length,
        createdAt: r.createdAt,
        ...(r.endedAt ? { endedAt: r.endedAt } : {}),
      };
    });
    return { sessions, total };
  }

  async get(
    companyId: string,
    id: string,
    viewer: Viewer,
  ): Promise<{
    session: RequirementsSession;
    messages: ReturnType<typeof toStored>[];
    spec: LiveSpec;
    versions: SpecVersionSummary[];
    invitations: SessionInvitation[];
  }> {
    const row = await this.cx.load(companyId, id, viewer);
    const [messages, versions, spec] = await Promise.all([
      row.status === "deleted"
        ? []
        : this.deps.db.message.findMany({ where: { sessionId: row.id }, orderBy: { seq: "asc" } }),
      this.deps.db.specVersion.findMany({ where: { sessionId: row.id }, orderBy: { version: "desc" } }),
      this.cx.liveSpecOf(row),
    ]);
    return {
      session: this.cx.sessionView(row),
      messages: messages.map(toStored),
      spec,
      versions: versions.map(versionSummary),
      invitations: publicInvitations(row.invitations),
    };
  }

  /** The live spec after a turn, rendered from the state the engine just persisted (or the stored one). */
  async liveSpec(companyId: string, id: string, state?: SessionState): Promise<LiveSpec> {
    const row = await this.deps.db.session.findFirst({
      where: { id, companyId },
      include: { template: true },
    });
    if (!row) throw new RequirementsNotFoundError("Session");
    return this.cx.liveSpecOf(row, state);
  }

  async setPath(companyId: string, id: string, path: Path, viewer: Viewer): Promise<void> {
    const row = await this.cx.load(companyId, id, viewer);
    await this.deps.db.session.update({ where: { id: row.id }, data: { path } });
  }

  /** The engine must have a path before the first turn when the template asks for one. */
  /** The viewer may work in this session (owner or admin); throws not-found or forbidden otherwise. */
  async assertAccess(companyId: string, id: string, viewer: Viewer): Promise<void> {
    await this.cx.load(companyId, id, viewer);
  }

  async assertTurnAllowed(companyId: string, id: string, viewer: Viewer): Promise<void> {
    const row = await this.cx.load(companyId, id, viewer);
    if (row.template.pathSelection !== "none" && !row.path) throw new PathRequiredError();
  }

  /** "I'm done": the next turn asks the closing question (same device as the participant flow). */
  async requestCompletion(companyId: string, id: string, viewer: Viewer): Promise<void> {
    const row = await this.cx.load(companyId, id, viewer);
    if (row.status === "completed" || row.status === "deleted") return;
    // A flag, not a turn-count sentinel (D-170): `chooseFocus` closes on it, and the turn count stays
    // the number of turns that were taken.
    await requestFinish(this.deps.db, row.id);
  }

  /** A completed session becomes active again; the engine continues from the areas (FR-26). */
  async reopen(companyId: string, id: string, viewer: Viewer): Promise<void> {
    const row = await this.cx.load(companyId, id, viewer);
    if (row.status !== "completed") return;
    const state = SessionStateSchema.parse(row.state);
    const turns = await this.deps.db.message.count({ where: { sessionId: row.id, role: "assistant" } });
    const maxTurns = await this.deps.settings.get("engine.maxTurns", this.cx.chain(row));
    const next: SessionState = reopenedState(state, turns, maxTurns);
    await this.deps.db.session.update({
      where: { id: row.id },
      data: { status: "active", endedAt: null, state: next as Prisma.InputJsonValue },
    });
  }

  async editSection(
    companyId: string,
    id: string,
    key: string,
    markdown: string,
    userId: string,
    viewer: Viewer,
  ): Promise<LiveSpec> {
    const row = await this.cx.load(companyId, id, viewer);
    const live = await this.cx.liveSpecOf(row);
    const known =
      (SPEC_SECTION_KEYS as readonly string[]).includes(key) || live.sections.some((s) => s.key === key);
    if (!known) throw new InvalidSectionError(key);
    const edits = parseEdits(row.specEdits);
    const { [key]: _removed, ...rest } = edits;
    const next: SpecEdits = markdown.trim()
      ? { ...rest, [key]: { markdown, editedAt: new Date().toISOString(), editedBy: userId } }
      : rest;
    await this.deps.db.session.update({ where: { id: row.id }, data: { specEdits: next } });
    await this.cx.appendEvent(row.id, "spec_edit", { key, chars: markdown.trim().length });
    return this.cx.liveSpecOf({ ...row, specEdits: next });
  }

  async settleFinding(
    companyId: string,
    id: string,
    findingId: string,
    outcome: FindingOutcome,
    note: string | undefined,
    userId: string,
    viewer: Viewer,
  ): Promise<LiveSpec> {
    const row = await this.cx.load(companyId, id, viewer);
    const state = SessionStateSchema.parse(row.state);
    const finding = state.findings.find((f) => f.id === findingId);
    if (!finding) throw new RequirementsNotFoundError("Finding");
    const findings: Finding[] = state.findings.map((f) =>
      f.id === findingId
        ? {
            ...f,
            status: outcome,
            decidedTurn: state.turnCount,
            ...(note?.trim() ? { note: note.trim() } : {}),
          }
        : f,
    );
    const next: SessionState = { ...state, findings };
    await this.deps.db.session.update({
      where: { id: row.id },
      data: { state: next as Prisma.InputJsonValue },
    });
    await this.cx.appendEvent(row.id, "finding", {
      kind: "outcome",
      findingId,
      outcome,
      by: "owner",
      userId,
    });
    return this.cx.liveSpecOf(row, next);
  }

  /** A throwaway session on the template, owned by the admin, opened as a participant. */
  async preview(
    companyId: string,
    templateId: string,
    adminUserId: string,
    path?: Path,
  ): Promise<{ participantToken: string; sessionId: string }> {
    const { db, crypto } = this.deps;
    const template = await db.interviewTemplate.findFirst({
      where: { id: templateId, OR: [{ companyId }, { companyId: null }] },
    });
    if (!template) throw new RequirementsNotFoundError("Template");
    const token = newToken(24);
    const participant = await db.participant.create({
      data: {
        companyId,
        campaignId: null,
        userId: adminUserId,
        fields: {},
        tokenHash: crypto.hashToken(token),
      },
    });
    const chosen = path ?? (template.pathSelection === "none" ? null : "technical");
    const session = await db.session.create({
      data: {
        companyId,
        templateId: template.id,
        participantId: participant.id,
        ownerUserId: adminUserId,
        sourceKind: "text",
        title: "Preview",
        status: "consented",
        consentedAt: new Date(),
        path: chosen,
        templateVersion: template.version,
      },
    });
    return { participantToken: token, sessionId: session.id };
  }
}
