import { toStored, type SettingsService } from "@aidp/core";
import type { Prisma, PrismaClient, SessionEvent } from "@prisma/client";
import { forbidden, notFound } from "../../lib/errors.js";

type LoadedSession = Prisma.SessionGetPayload<{ include: { participant: true; campaign: true } }>;

export interface SessionDetail {
  /** The row, without the participant (identity is never part of this view) and with `state` cut to coverage unless the transcript is visible. */
  session: Omit<LoadedSession, "participant" | "state"> & { participant: undefined; state: unknown };
  messages: ReturnType<typeof toStored>[] | null;
  transcriptVisible: boolean;
}

/**
 * Staff view of one session, gated by the privacy setting (spec 11). The transcript is what the
 * setting controls: `nobody` hides it from everyone, `admins` shows it to staff, and
 * `opted_in` shows it only where the participant is identified and ticked the box.
 */
export class SessionsService {
  constructor(
    private readonly db: PrismaClient,
    private readonly settings: SettingsService,
  ) {}

  private async load(companyId: string, id: string) {
    const s = await this.db.session.findFirst({
      where: { id, companyId },
      include: { participant: true, campaign: true },
    });
    if (!s) throw notFound("Session");
    return s;
  }

  private async mayReadTranscript(companyId: string, s: LoadedSession): Promise<boolean> {
    const setting = await this.settings.get("privacy.rawTranscriptsVisibleTo", [
      { scope: "tenant", scopeId: companyId },
    ]);
    if (setting === "nobody") return false;
    if (setting === "admins") return true;
    const fields = (s.participant?.fields ?? {}) as Record<string, string>;
    return s.campaign?.participationMode === "identified" && fields.transcriptOptIn === "true";
  }

  async get(companyId: string, id: string): Promise<SessionDetail> {
    const s = await this.load(companyId, id);
    const transcript = await this.mayReadTranscript(companyId, s);
    const messages = transcript
      ? (await this.db.message.findMany({ where: { sessionId: s.id }, orderBy: { seq: "asc" } })).map(
          toStored,
        )
      : null;
    const session = { ...s, participant: undefined };
    return {
      session: {
        ...session,
        state: transcript ? session.state : { coverage: (session.state as { coverage?: unknown }).coverage },
      },
      messages,
      transcriptVisible: transcript,
    };
  }

  async events(companyId: string, id: string): Promise<{ events: SessionEvent[] }> {
    const s = await this.load(companyId, id);
    if (!(await this.mayReadTranscript(companyId, s)))
      throw forbidden("Transcript access is disabled by the privacy settings");
    return {
      events: await this.db.sessionEvent.findMany({ where: { sessionId: s.id }, orderBy: { seq: "asc" } }),
    };
  }
}
