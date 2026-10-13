import type { Prisma, PrismaClient, Session } from "@prisma/client";

/**
 * What the turn runner and the live voice session read and write on a session. Kept apart from
 * the transports so neither holds a database client: both are handed this.
 *
 * The turn lock is a timestamp on the session row. `turnLockedAt` is the token: a renewal or a
 * release only matches while the row still carries the value this turn wrote, so a turn whose
 * lock was taken over cannot clear the new owner's.
 */
export class TurnStore {
  constructor(private readonly db: PrismaClient) {}

  /**
   * The session a turn is about to run on.
   *
   * The one lookup keyed by session id alone: the caller holds a participant token that names the
   * session, so the id is already authenticated, and the row's own `companyId` is what every
   * later call in the turn is scoped with.
   */
  load(sessionId: string): Promise<Session> {
    return this.db.session.findUniqueOrThrow({ where: { id: sessionId } });
  }

  /** Takes the lock if it is free or its holder stopped renewing it. True when this turn now holds it. */
  async acquireLock(companyId: string, sessionId: string, at: Date, ttlMs: number): Promise<boolean> {
    const locked = await this.db.session.updateMany({
      where: {
        id: sessionId,
        companyId,
        OR: [{ turnLockedAt: null }, { turnLockedAt: { lt: new Date(at.getTime() - ttlMs) } }],
      },
      data: { turnLockedAt: at },
    });
    return locked.count > 0;
  }

  /** Moves the lock forward. False when someone else holds the session now. */
  async renewLock(companyId: string, sessionId: string, token: Date, next: Date): Promise<boolean> {
    const renewed = await this.db.session.updateMany({
      where: { id: sessionId, companyId, turnLockedAt: token },
      data: { turnLockedAt: next },
    });
    return renewed.count > 0;
  }

  async releaseLock(companyId: string, sessionId: string, token: Date): Promise<void> {
    await this.db.session.updateMany({
      where: { id: sessionId, companyId, turnLockedAt: token },
      data: { turnLockedAt: null },
    });
  }

  async campaignMaxTurns(companyId: string, campaignId: string): Promise<number> {
    const campaign = await this.db.campaign.findFirstOrThrow({
      where: { id: campaignId, companyId },
      select: { maxTurns: true },
    });
    return campaign.maxTurns;
  }

  async activate(companyId: string, sessionId: string, startedAt: Date): Promise<void> {
    await this.db.session.updateMany({
      where: { id: sessionId, companyId },
      data: { status: "active", startedAt },
    });
  }

  async complete(companyId: string, sessionId: string): Promise<void> {
    await this.db.session.updateMany({
      where: { id: sessionId, companyId },
      data: { status: "completed", endedAt: new Date() },
    });
  }

  async pause(companyId: string, sessionId: string): Promise<void> {
    await this.db.session.updateMany({ where: { id: sessionId, companyId }, data: { status: "paused" } });
  }

  // ---- Live voice (FR-30a) ----

  /** The session's status, or null when it no longer exists. */
  async status(companyId: string, sessionId: string): Promise<string | null> {
    const s = await this.db.session.findFirst({
      where: { id: sessionId, companyId },
      select: { status: true },
    });
    return s?.status ?? null;
  }

  /** The language the interview's template is written in. */
  async templateLanguage(companyId: string, sessionId: string): Promise<string | undefined> {
    const s = await this.db.session.findFirst({
      where: { id: sessionId, companyId },
      select: { template: { select: { language: true } } },
    });
    return s?.template.language;
  }

  /** The most recent interviewer message, for "say that again". */
  lastInterviewerMessage(
    companyId: string,
    sessionId: string,
  ): Promise<{ content: string; widget: unknown } | null> {
    return this.db.message.findFirst({
      where: { sessionId, role: "assistant", session: { companyId } },
      orderBy: { seq: "desc" },
      select: { content: true, widget: true },
    });
  }

  /** Whether a transcription route exists for this tenant or the platform, as the resolver reads them. */
  async hasTranscriptionRoute(companyId: string): Promise<boolean> {
    const row = await this.db.route.findFirst({
      where: { purpose: "transcription", OR: [{ companyId }, { companyId: null }] },
      select: { id: true },
    });
    return row !== null;
  }

  /** The per-session voice signals, written once at the end. Best effort: a lost row loses a metric. */
  async recordVoiceMetrics(
    companyId: string,
    sessionId: string,
    payload: Prisma.InputJsonObject,
  ): Promise<void> {
    try {
      // SessionEvent carries no company of its own, so ownership is checked on the session first.
      const owned = await this.db.session.findFirst({
        where: { id: sessionId, companyId },
        select: { id: true },
      });
      if (!owned) return;
      await this.db.sessionEvent.create({
        data: { sessionId, seq: Date.now() % 2_147_483_647, type: "voice.live", payload },
      });
    } catch {
      // Best effort by design.
    }
  }
}
