import { renderLiveSpec } from "@aidp/ai";
import { tenantTransaction } from "@aidp/db";
import {
  HandoffSchema,
  SessionStateSchema,
  SpecDocumentSchema,
  type BundleFormat,
  type LiveSpec,
  type SessionState,
  type SpecDocument,
} from "@aidp/shared";
import type { InterviewTemplate as TemplateRow, Prisma, SpecVersion } from "@prisma/client";
import { templateFromRow } from "../sessions/prisma-store.js";
import type { SettingScopeRef } from "../settings/service.js";
import { RequirementsForbiddenError, RequirementsNotFoundError, SpecVersionNotReadyError } from "./errors.js";
import { parseEdits, pathOf, REQUIREMENTS_TEMPLATE_KEY } from "./helpers.js";
import type { RequirementsServiceDeps, RequirementsSession, SessionRow, Viewer } from "./types.js";

const VALIDITY_KEYS: SettingScopeRef["scope"][] = ["template", "tenant"];

/**
 * What the parts of the requirements service share: the dependencies, and the lookups every part
 * starts from (load a session as a viewer, the settings chain, the live spec of a row). The parts
 * (sessions, versions, exports, invitations) each hold one of these and nothing else of each
 * other, so a part can be read, and tested, without the others.
 */
export class RequirementsContext {
  constructor(readonly deps: RequirementsServiceDeps) {}

  async load(companyId: string, id: string, viewer: Viewer): Promise<SessionRow> {
    const row = await this.deps.db.session.findFirst({
      where: { id, companyId, ownerUserId: { not: null } },
      include: { template: true },
    });
    if (!row) throw new RequirementsNotFoundError("Session");
    if (viewer.role === "member" && row.ownerUserId !== viewer.userId) throw new RequirementsForbiddenError();
    return row;
  }

  async requirementsTemplate(companyId: string): Promise<TemplateRow | null> {
    return this.deps.db.interviewTemplate.findFirst({
      where: {
        key: REQUIREMENTS_TEMPLATE_KEY,
        status: "published",
        OR: [{ companyId }, { companyId: null }],
      },
      // Tenant copy first: a plain desc sort would put the platform row (null companyId) first in Postgres.
      orderBy: [{ companyId: { sort: "desc", nulls: "last" } }, { version: "desc" }],
    });
  }

  chain(row: { templateId: string; companyId: string }): SettingScopeRef[] {
    return VALIDITY_KEYS.map((scope) => ({
      scope,
      scopeId: scope === "template" ? row.templateId : row.companyId,
    }));
  }

  async liveSpecOf(row: SessionRow, state?: SessionState): Promise<LiveSpec> {
    const sections = (await this.deps.settings.get("requirements.specSections", this.chain(row))) as string[];
    return renderLiveSpec({
      title: row.title,
      path: pathOf(row.path),
      state: state ?? SessionStateSchema.parse(row.state),
      edits: parseEdits(row.specEdits),
      sections,
    });
  }

  async bundleFormat(row: SessionRow): Promise<BundleFormat> {
    return await this.deps.settings.get("exports.bundleFormat", this.chain(row));
  }

  sessionView(row: SessionRow): RequirementsSession {
    const state = SessionStateSchema.safeParse(row.state);
    const coverage = state.success ? state.data.coverage : {};
    const areas = templateFromRow(row.template).coverageAreas.map((a) => ({
      key: a.key,
      name: a.name,
      status: coverage[a.key]?.status ?? "untouched",
    }));
    const handoff = row.handoff ? HandoffSchema.safeParse(row.handoff) : undefined;
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      path: pathOf(row.path),
      sourceKind: row.sourceKind,
      ownerUserId: row.ownerUserId,
      handoff: handoff?.success ? handoff.data : null,
      templateId: row.templateId,
      language: row.template.language,
      progress: { areas },
      phase: state.success ? state.data.phase : "areas",
      createdAt: row.createdAt,
      ...(row.startedAt ? { startedAt: row.startedAt } : {}),
      ...(row.endedAt ? { endedAt: row.endedAt } : {}),
    };
  }

  async versionRow(sessionId: string, v: number): Promise<SpecVersion> {
    const row = await this.deps.db.specVersion.findFirst({ where: { sessionId, version: v } });
    if (!row) throw new RequirementsNotFoundError("Version");
    return row;
  }

  documentOf(version: SpecVersion): SpecDocument {
    if (version.status !== "done") throw new SpecVersionNotReadyError(version.version, version.status);
    return SpecDocumentSchema.parse(version.spec);
  }

  async appendEvent(sessionId: string, type: string, payload: unknown): Promise<void> {
    await tenantTransaction(this.deps.db, async (tx) => {
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
}
