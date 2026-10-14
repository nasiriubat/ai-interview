import { PrismaSessionStore, toStored, type SettingsService } from "@aidp/core";
import type { StaffSessionView } from "@aidp/shared";
import type { Prisma, PrismaClient, SessionEvent } from "@prisma/client";
import type { Role } from "../../auth/principal.js";
import { AppError, forbidden, notFound } from "../../lib/errors.js";

type LoadedSession = Prisma.SessionGetPayload<{
  include: {
    participant: { select: { fields: true } };
    campaign: { select: { id: true; name: true; participationMode: true } };
    template: { select: { key: true } };
  };
}>;

export interface SessionDetail {
  session: StaffSessionView;
  messages: ReturnType<typeof toStored>[] | null;
  transcriptVisible: boolean;
}

/** The staff member asking: what the transcript rule needs to know about them. */
export interface SessionViewer {
  userId: string;
  role: Role;
}

/** The start of the UTC day: what a timestamp is coarsened to when the person is not named (D-142). */
function toDay(d: Date | null): Date | null {
  return d ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) : null;
}

/** Staff view of sessions, gated by the privacy setting (spec 11). */
export class SessionsService {
  constructor(
    private readonly db: PrismaClient,
    private readonly settings: SettingsService,
  ) {}

  private async load(companyId: string, id: string) {
    const s = await this.db.session.findFirst({
      where: { id, companyId },
      include: {
        participant: { select: { fields: true } },
        campaign: { select: { id: true, name: true, participationMode: true } },
        template: { select: { key: true } },
      },
    });
    if (!s) throw notFound("Session");
    return s;
  }

  /**
   * Who may open a raw transcript (`privacy.rawTranscriptsVisibleTo`, spec 11).
   *
   * - `nobody`: no one.
   * - `admins`: administrators and the platform operator. A member is not one of them; this used to
   *   answer "yes" to any staff role, so the setting named a group it did not enforce.
   * - `admins_when_identified_and_opted_in`: the same administrators, and only for an identified
   *   participant who opted in.
   *
   * A member who owns a requirements session (it is theirs: they are the one being interviewed
   * about their own product) reads its transcript under any setting but `nobody`.
   */
  private async mayReadTranscript(companyId: string, who: SessionViewer, s: LoadedSession): Promise<boolean> {
    const setting = await this.settings.get("privacy.rawTranscriptsVisibleTo", [
      { scope: "tenant", scopeId: companyId },
    ]);
    if (setting === "nobody") return false;
    const owns = s.sourceKind !== "campaign" && s.ownerUserId !== null && s.ownerUserId === who.userId;
    if (owns) return true;
    if (who.role !== "admin" && who.role !== "platform_operator") return false;
    if (setting === "admins") return true;
    const fields = (s.participant?.fields ?? {}) as Record<string, string>;
    return s.campaign?.participationMode === "identified" && fields.transcriptOptIn === "true";
  }

  async get(companyId: string, who: SessionViewer, id: string): Promise<SessionDetail> {
    const s = await this.load(companyId, id);
    const transcript = await this.mayReadTranscript(companyId, who, s);
    const messages = transcript
      ? (await this.db.message.findMany({ where: { sessionId: s.id }, orderBy: { seq: "asc" } })).map(
          toStored,
        )
      : null;
    const state = (s.state ?? {}) as Record<string, unknown>;
    // An anonymous participant is given no time to the second here either: it would be read against
    // the day an invitation was opened (D-142). The same rule as the campaign's session list.
    const named =
      s.campaign?.participationMode === "identified" ||
      (s.campaign?.participationMode === "participant_choice" && s.consentedAt !== null);
    const coarse = s.campaign !== null && !named;
    const when = (d: Date | null): Date | null => (coarse ? toDay(d) : d);
    // Built field by field: a row spread into a response is how a link hash and a participant's
    // address reached staff before. The response schema strips anything that is not listed.
    const session: StaffSessionView = {
      id: s.id,
      status: s.status,
      sourceKind: s.sourceKind,
      campaignId: s.campaignId,
      templateId: s.templateId,
      templateKey: s.template.key,
      templateVersion: s.templateVersion,
      path: s.path,
      modePreference: s.modePreference,
      consentVersion: s.consentVersion,
      consentedAt: when(s.consentedAt),
      startedAt: when(s.startedAt),
      endedAt: when(s.endedAt),
      createdAt: when(s.createdAt) ?? s.createdAt,
      updatedAt: when(s.updatedAt) ?? s.updatedAt,
      campaign: s.campaign
        ? { id: s.campaign.id, name: s.campaign.name, participationMode: s.campaign.participationMode }
        : null,
      // The rolling summary is the transcript, condensed; it is hidden with it.
      summary: transcript ? s.summary : "",
      state: transcript ? state : { coverage: state.coverage },
      messages,
      transcriptVisible: transcript,
      flagged: s.flagged,
      flaggedAt: when(s.flaggedAt),
      flagAckedAt: when(s.flagAckedAt),
      // Model prose about a person: only with the transcript it was written from.
      flagReason: transcript ? s.flagReason : null,
    };
    // `messages` and `transcriptVisible` travel inside the record as well as beside it, so a client
    // that unwraps `session` keeps them.
    return { session, messages, transcriptVisible: transcript };
  }

  /**
   * A person has looked at a flagged interview (D-173). Idempotent: acknowledging again keeps the
   * first time and person. The note, when given, is kept as an `admin_note` event on the session.
   */
  async acknowledgeFlag(
    companyId: string,
    who: SessionViewer,
    id: string,
    note?: string,
  ): Promise<{ flagAckedAt: Date }> {
    const s = await this.load(companyId, id);
    if (!s.flagged) throw new AppError("conflict", "This interview is not flagged");
    const at = s.flagAckedAt ?? new Date();
    if (s.flagAckedAt === null) {
      await this.db.session.updateMany({
        where: { id: s.id, companyId, flagAckedAt: null },
        data: { flagAckedAt: at, flagAckedBy: who.userId },
      });
    }
    if (note?.trim())
      await new PrismaSessionStore(this.db).appendEvent(s.id, "admin_note", {
        note: note.trim().slice(0, 1000),
        by: who.userId,
      });
    return { flagAckedAt: at };
  }

  async events(companyId: string, who: SessionViewer, id: string): Promise<{ events: SessionEvent[] }> {
    const s = await this.load(companyId, id);
    if (!(await this.mayReadTranscript(companyId, who, s)))
      throw forbidden("Transcript access is disabled by the privacy settings");
    return {
      events: await this.db.sessionEvent.findMany({ where: { sessionId: s.id }, orderBy: { seq: "asc" } }),
    };
  }
}
