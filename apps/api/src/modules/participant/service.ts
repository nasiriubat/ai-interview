import { createHash } from "node:crypto";
import {
  deleteSessionData,
  emailDomain,
  newNumericCode,
  newToken,
  normalizeEmail,
  voiceAllowedForSession,
  PrismaSessionStore,
  requestFinish,
  type Crypto,
  type EmailPort,
  type SettingsService,
  type TenantCeilings,
  type TenantGate,
  type VoiceMode,
} from "@aidp/core";
import { tenantTransaction } from "@aidp/db";
import { defaultConsentText, type ModeSwitchReason } from "@aidp/shared";
import type { Campaign, InterviewTemplate, Participant, PrismaClient, Session } from "@prisma/client";
import { AppError, notFound } from "../../lib/errors.js";

export interface LinkView {
  consentVersion: string;
  campaignId: string;
  companyId: string;
  name: string;
  productName: string;
  purpose: string;
  expectedMinutes: number;
  participationMode: string;
  verification: string;
  consentText: string;
  participantFields: unknown;
  pathSelection: string;
  status: "open" | "closed" | "expired";
}

/** What the confirmation job is given; the address is encrypted and nothing else identifies the person. */
export interface DeletionNotice {
  companyId: string;
  sessionId: string;
  toEnc: string;
  campaignName: string;
  language: string;
  deletedAt: string;
}

/** A counted abuse signal. Carries ids only, never an address (D-82). */
export type AbuseEvent = "abuse.code_request_capped" | "abuse.code_confirm_locked";

const HOUR_MS = 60 * 60_000;

/**
 * The version a participant consents to: a hash of the exact words shown. Changing the words
 * (an edited text, or a new shipped default) gives a new version, and a session keeps the
 * version it consented under, so nobody is recorded as having agreed to words they never saw
 * (D-185). Nothing re-validates an old version against the current text.
 */
export function consentVersionOf(text: string): string {
  return `v${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;
}

/** The public participant flow: link resolution, uniqueness, session binding (FR-04, FR-10, FR-11, 06). */
export class ParticipantService {
  constructor(
    private readonly db: PrismaClient,
    private readonly crypto: Crypto,
    private readonly settings: SettingsService,
    private readonly email: EmailPort,
    private readonly tenants: TenantGate,
    private readonly onAbuse: (event: AbuseEvent, meta: { campaignId: string }) => void = () => undefined,
    /** Refuses a new interview past `ceiling.maxSessionsPerMonth` (D-188). */
    private readonly ceilings?: TenantCeilings,
  ) {}

  async resolveLink(
    linkToken: string,
  ): Promise<{ campaign: Campaign & { template: InterviewTemplate }; view: LinkView }> {
    const campaign = await this.db.campaign.findUnique({
      where: { linkTokenHash: this.crypto.hashToken(linkToken) },
      include: { template: true },
    });
    if (!campaign) throw notFound("Interview link");
    const chain = [
      { scope: "campaign" as const, scopeId: campaign.id },
      { scope: "tenant" as const, scopeId: campaign.companyId },
    ];
    const resolved = await this.settings.resolveDetailed(
      ["branding.productName", "campaign.consentText"],
      chain,
    );
    // Nobody wrote a consent text at any level: the default speaks the interview's language
    // (D-185). A text someone saved is shown exactly as saved, whatever its language.
    const explicitConsent = resolved["campaign.consentText"]?.scope != null;
    const consentText = explicitConsent
      ? (resolved["campaign.consentText"]?.value as string)
      : defaultConsentText(campaign.template.language);
    const values = { "branding.productName": resolved["branding.productName"]?.value };
    const expired = campaign.expiresAt ? campaign.expiresAt.getTime() < Date.now() : false;
    // A suspended tenant's link answers exactly as a closed campaign does, so nothing about the
    // link reveals that the organization is suspended (S8).
    const suspended = !(await this.tenants.isActive(campaign.companyId));
    return {
      campaign,
      view: {
        campaignId: campaign.id,
        companyId: campaign.companyId,
        name: campaign.name,
        productName: values["branding.productName"] as string,
        purpose: campaign.template.objective,
        expectedMinutes: Math.max(10, Math.round(campaign.maxTurns / 3)),
        participationMode: campaign.participationMode,
        verification: campaign.verification,
        consentText,
        consentVersion: consentVersionOf(consentText),
        participantFields: campaign.template.participantFields,
        pathSelection: campaign.template.pathSelection,
        status: expired ? "expired" : campaign.status === "open" && !suspended ? "open" : "closed",
      },
    };
  }

  /** Email-code verification, step 1. Always succeeds from the caller's point of view. */
  async requestCode(linkToken: string, email: string): Promise<void> {
    const { campaign, view } = await this.resolveLink(linkToken);
    if (view.status !== "open" || campaign.verification !== "email_code") return;
    const allowed = campaign.allowedEmailDomains as string[];
    if (allowed.length && !allowed.includes(emailDomain(email))) return;
    // A code row carries the campaign-salted hash. One written by a build that predates the salt
    // (D-142) is matched by the legacy value below, so a code requested just before an upgrade
    // still confirms.
    const { hash: emailHash, legacy } = this.hashes(campaign.id, email);
    // Per-address cap (D-82): the shared per-IP bucket cannot stop one person mail-bombing a
    // victim through this endpoint from many addresses, so the address itself is counted. The
    // count is the EmailCode rows of the last hour, which persist across restarts and replicas.
    // A refused request still answers "ok": the response must not say whether an address was
    // already asked for, and the attacker learns nothing by hitting the cap.
    const { requests } = await this.codeLimits(campaign.companyId);
    const since = new Date(Date.now() - HOUR_MS);
    const mine = { campaignId: campaign.id, emailHash: { in: [emailHash, legacy] } };
    await this.db.emailCode.deleteMany({ where: { ...mine, createdAt: { lt: since } } });
    const recent = await this.db.emailCode.count({ where: mine });
    if (recent >= requests) {
      this.onAbuse("abuse.code_request_capped", { campaignId: campaign.id });
      return;
    }
    const code = newNumericCode();
    await this.db.emailCode.create({
      data: {
        companyId: campaign.companyId,
        campaignId: campaign.id,
        emailHash,
        codeHash: this.crypto.hashToken(code),
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });
    await this.email.send({
      to: normalizeEmail(email),
      companyId: campaign.companyId,
      subject: `Your code: ${code}`,
      text: `Your verification code for "${campaign.name}" is ${code}. It expires in 10 minutes.`,
    });
  }

  /** Email-code verification, step 2: binds or resumes the one session for this email. */
  async confirmCode(
    linkToken: string,
    email: string,
    code: string,
  ): Promise<{ participantToken: string; sessionId: string; resume: boolean }> {
    const { campaign, view } = await this.resolveLink(linkToken);
    if (view.status !== "open") throw new AppError("conflict", "This interview is not open");
    const { hash: emailHash, legacy } = this.hashes(campaign.id, email);
    const mine = { campaignId: campaign.id, emailHash: { in: [emailHash, legacy] } };
    // Guessing is bounded per address, not only per code: the six-digit space is small, and a
    // fresh code resets a per-code counter.
    const { failures } = await this.codeLimits(campaign.companyId);
    const since = new Date(Date.now() - HOUR_MS);
    const spent = await this.db.emailCode.aggregate({
      where: { ...mine, createdAt: { gte: since } },
      _sum: { attempts: true },
    });
    if ((spent._sum.attempts ?? 0) >= failures) {
      this.onAbuse("abuse.code_confirm_locked", { campaignId: campaign.id });
      throw new AppError("forbidden", "Code expired or invalid");
    }
    const row = await this.db.emailCode.findFirst({ where: mine, orderBy: { createdAt: "desc" } });
    if (!row || row.expiresAt.getTime() < Date.now() || row.attempts >= 5)
      throw new AppError("forbidden", "Code expired or invalid");
    if (!this.crypto.verifyTokenHash(code, row.codeHash)) {
      await this.db.emailCode.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
      throw new AppError("forbidden", "Code expired or invalid");
    }
    await this.db.emailCode.delete({ where: { id: row.id } });
    return this.bind(campaign, {
      hash: emailHash,
      legacyHashes: [legacy],
      // Typing the address again is what opens the pointer to the earlier session.
      resumeKey: this.crypto.resumeKeyForEmail(email, campaign.id),
      email: campaign.participationMode === "anonymous" ? null : normalizeEmail(email),
    });
  }

  /** The campaign-salted hash of an address, and the platform-wide one older rows carry. */
  private hashes(campaignId: string, email: string): { hash: string; legacy: string } {
    return { hash: this.crypto.campaignEmailHash(email, campaignId), legacy: this.crypto.hashEmail(email) };
  }

  private async codeLimits(companyId: string): Promise<{ requests: number; failures: number }> {
    const v = await this.settings.resolveMany(
      ["privacy.codeRequestsPerHour", "privacy.codeFailuresPerHour"],
      [{ scope: "tenant", scopeId: companyId }],
    );
    return {
      requests: v["privacy.codeRequestsPerHour"] as number,
      failures: v["privacy.codeFailuresPerHour"] as number,
    };
  }

  /** Personal invitation link, or an open link without verification. */
  async open(
    linkToken: string,
    invitationToken: string | undefined,
  ): Promise<{ participantToken: string; sessionId: string; resume: boolean }> {
    const { campaign, view } = await this.resolveLink(linkToken);
    if (view.status !== "open") throw new AppError("conflict", "This interview is not open");
    if (invitationToken) {
      const inv = await this.db.invitation.findUnique({
        where: { tokenHash: this.crypto.hashToken(invitationToken) },
      });
      if (inv?.campaignId !== campaign.id || inv.status === "revoked" || inv.expiresAt.getTime() < Date.now())
        throw new AppError("forbidden", "Invitation is invalid or expired");
      const bound = await this.bind(campaign, {
        hash: inv.emailHash,
        legacyHashes: [],
        // The invitation token is the secret that only this person holds; the database keeps its
        // hash, so the pointer to their session cannot be opened from the database alone.
        resumeKey: this.crypto.resumeKeyForToken(invitationToken, campaign.id),
        email: inv.email,
        // A bound invitation whose answers cannot be found again must not start a second interview.
        alreadyUsed: inv.status === "bound",
      });
      // An anonymous campaign keeps no link from the invitation to the session and only the day it
      // was opened, so the admin's list of who has responded cannot be read against the sessions'
      // timestamps (D-142). A participant who may still choose anonymity keeps the link until they
      // do (see `consent`).
      const anonymous = campaign.participationMode === "anonymous";
      await this.db.invitation.update({
        where: { id: inv.id },
        data: {
          status: "bound",
          openedAt: anonymous ? startOfUtcDay(inv.openedAt ?? new Date()) : (inv.openedAt ?? new Date()),
          sessionId: anonymous ? null : bound.sessionId,
        },
      });
      return bound;
    }
    if (campaign.verification !== "open")
      throw new AppError("forbidden", "This interview requires verification");
    // Open links accept duplicates by design: every open creates a new anonymous participant.
    const created = await this.createParticipantAndSession(this.db, campaign, null);
    return { participantToken: created.participantToken, sessionId: created.sessionId, resume: false };
  }

  /**
   * Binds a verified person to their one response in a campaign, or finds the response they
   * already have.
   *
   * Anonymous mode is the case that shapes this. The spec says the campaign stores "only a salted
   * hash ... never on the session", so nothing on the participant row may hold the hash or point
   * at it, and the hash row may not hold a session id. The way back is therefore sealed: the hash
   * row carries the participant id encrypted under a key only the returning person can produce
   * (their address, or their invitation token). A copy of the database joins nothing.
   */
  private async bind(
    campaign: Campaign,
    who: {
      hash: string;
      legacyHashes: string[];
      resumeKey: Buffer;
      email: string | null;
      alreadyUsed?: boolean;
    },
  ): Promise<{ participantToken: string; sessionId: string; resume: boolean }> {
    const accepted = [who.hash, ...who.legacyHashes];
    const existing = await this.db.campaignEmailHash.findFirst({
      where: { campaignId: campaign.id, emailHash: { in: accepted } },
    });
    if (existing) {
      const found = await this.findResponse(campaign, existing, accepted, who.resumeKey);
      if (found) {
        if (found.session.status === "deleted")
          throw new AppError("conflict", "Your answers were deleted; this link cannot be reused");
        const token = newToken(24);
        await this.db.participant.update({
          where: { id: found.participant.id },
          data: {
            tokenHash: this.crypto.hashToken(token),
            // An anonymous participant row never holds the pointer; one written before D-142 is
            // brought to that shape now that the person is here to seal it.
            ...(campaign.participationMode === "anonymous"
              ? { fields: withoutPointer(found.participant.fields) }
              : {}),
          },
        });
        await this.upgradeRow(campaign, existing, found.participant.id, who);
        return {
          participantToken: token,
          sessionId: found.session.id,
          resume: found.session.status !== "created",
        };
      }
      // The address has been used but its response cannot be reached from here, for instance a
      // personal link used after the address answered through the share link.
      throw new AppError("conflict", "This address has already been used for this interview");
    }
    if (who.alreadyUsed)
      throw new AppError("conflict", "This invitation has already been used for this interview");

    // The hash row first: its primary key is the one-response-per-address guard, so two concurrent
    // verifications cannot both create a response. The row is completed with the sealed pointer in
    // the same transaction.
    try {
      return await this.createResponse(campaign, who);
    } catch (e) {
      if ((e as { code?: unknown } | null)?.code === "P2002")
        throw new AppError("conflict", "This address has already been used for this interview");
      throw e;
    }
  }

  private createResponse(
    campaign: Campaign,
    who: { hash: string; resumeKey: Buffer; email: string | null },
  ): Promise<{ participantToken: string; sessionId: string; resume: boolean }> {
    return tenantTransaction(this.db, async (tx) => {
      const anonymous = campaign.participationMode === "anonymous";
      await tx.campaignEmailHash.create({
        data: {
          companyId: campaign.companyId,
          campaignId: campaign.id,
          emailHash: who.hash,
          // Day resolution in anonymous mode: the minute it was written would pair this row with
          // the session created in the same second.
          ...(anonymous ? { createdAt: startOfUtcDay(new Date()) } : {}),
        },
      });
      const created = await this.createParticipantAndSession(tx, campaign, who.hash, who.email);
      await tx.campaignEmailHash.update({
        where: { campaignId_emailHash: { campaignId: campaign.id, emailHash: who.hash } },
        data: {
          resumeSeal: this.crypto.seal(who.resumeKey, created.participantId),
          ownerTag: this.crypto.participantTag(campaign.id, created.participantId),
        },
      });
      return {
        participantToken: created.participantToken,
        sessionId: created.sessionId,
        resume: false,
      };
    });
  }

  /** The participant and session an address already has, by the seal first and the old pointer second. */
  private async findResponse(
    campaign: Campaign,
    row: { resumeSeal: string | null },
    accepted: string[],
    resumeKey: Buffer,
  ): Promise<{ participant: Participant; session: Session } | null> {
    const sealed = row.resumeSeal ? this.crypto.unseal(resumeKey, row.resumeSeal) : null;
    const participant = sealed
      ? await this.db.participant.findFirst({ where: { id: sealed, campaignId: campaign.id } })
      : // Rows written before D-142: the pointer was the hash itself, on the participant row.
        await this.db.participant.findFirst({
          where: {
            campaignId: campaign.id,
            OR: accepted.map((h) => ({ fields: { path: ["_emailHash"], equals: h } })),
          },
        });
    if (!participant) return null;
    const session = await this.db.session.findFirst({
      where: { participantId: participant.id, campaignId: campaign.id },
    });
    return session ? { participant, session } : null;
  }

  /**
   * Brings a hash row written by an earlier build to the current shape, now that the person has
   * proved who they are: the sealed pointer and owner tag are written, the timestamp is coarsened,
   * and, when the address was typed, the platform-wide hash is replaced by the campaign-salted one.
   * Existing rows cannot be re-salted without the address; a row whose person never returns keeps
   * the old hash until the campaign is closed (see CampaignService.setStatus).
   */
  private async upgradeRow(
    campaign: Campaign,
    row: { emailHash: string; resumeSeal: string | null; ownerTag: string | null; createdAt: Date },
    participantId: string,
    who: { hash: string; resumeKey: Buffer },
  ): Promise<void> {
    const anonymous = campaign.participationMode === "anonymous";
    const rehash = row.emailHash !== who.hash && who.hash.startsWith("h2:");
    const needsSeal = row.resumeSeal === null || row.ownerTag === null;
    const day = startOfUtcDay(row.createdAt);
    const coarsen = anonymous && day.getTime() !== row.createdAt.getTime();
    if (!rehash && !needsSeal && !coarsen) return;
    await this.db.campaignEmailHash.update({
      where: { campaignId_emailHash: { campaignId: campaign.id, emailHash: row.emailHash } },
      data: {
        ...(rehash ? { emailHash: who.hash } : {}),
        ...(needsSeal
          ? {
              resumeSeal: this.crypto.seal(who.resumeKey, participantId),
              ownerTag: this.crypto.participantTag(campaign.id, participantId),
            }
          : {}),
        ...(coarsen ? { createdAt: day } : {}),
      },
    });
    if (rehash) {
      // The invitation for the same address, and the identified pointer, follow the new value.
      await this.db.invitation.updateMany({
        where: { campaignId: campaign.id, emailHash: row.emailHash },
        data: { emailHash: who.hash },
      });
      if (!anonymous) {
        const p = await this.db.participant.findUnique({ where: { id: participantId } });
        const fields = (p?.fields ?? {}) as Record<string, unknown>;
        if (p && fields._emailHash !== undefined)
          await this.db.participant.update({
            where: { id: p.id },
            data: { fields: { ...fields, _emailHash: who.hash } },
          });
      }
    }
  }

  private async createParticipantAndSession(
    db: Pick<PrismaClient, "participant" | "session" | "interviewTemplate">,
    campaign: Campaign,
    emailHash: string | null,
    email: string | null = null,
  ): Promise<{ participantToken: string; sessionId: string; participantId: string }> {
    // Before anything is written: a refused interview leaves no participant row behind.
    await this.ceilings?.assertRoom(campaign.companyId, "maxSessionsPerMonth");
    const token = newToken(24);
    const fields: Record<string, string> = {};
    // Only a campaign that is not anonymous keeps a pointer on the participant row: its email is
    // stored there anyway, and deletion uses the pointer. Anonymous responses are found through the
    // sealed pointer instead, and removed through the owner tag (D-142).
    if (emailHash && campaign.participationMode !== "anonymous") fields._emailHash = emailHash;
    if (email && campaign.participationMode !== "anonymous") fields.email = email;
    const participant = await db.participant.create({
      data: {
        companyId: campaign.companyId,
        campaignId: campaign.id,
        fields,
        tokenHash: this.crypto.hashToken(token),
      },
    });
    // The version of the row the campaign pins (FR-62), not a constant.
    const pinned = await db.interviewTemplate.findUniqueOrThrow({
      where: { id: campaign.templateId },
      select: { version: true },
    });
    const session = await db.session.create({
      data: {
        companyId: campaign.companyId,
        templateId: campaign.templateId,
        campaignId: campaign.id,
        participantId: participant.id,
        sourceKind: "campaign",
        status: "created",
        templateVersion: pinned.version,
      },
    });
    await this.ceilings?.afterChange(campaign.companyId);
    return { participantToken: token, sessionId: session.id, participantId: participant.id };
  }

  async consent(
    sessionId: string,
    input: {
      consentVersion: string;
      participantFields?: Record<string, string> | undefined;
      participationChoice?: "identified" | "anonymous" | undefined;
    },
  ): Promise<void> {
    const session = await this.db.session.findUniqueOrThrow({
      where: { id: sessionId },
      include: { participant: true, campaign: true },
    });
    if (session.status !== "created") return;
    const anonymous =
      session.campaign?.participationMode === "anonymous" ||
      (session.campaign?.participationMode === "participant_choice" &&
        input.participationChoice !== "identified");
    if (session.participant) {
      const existing = (session.participant.fields ?? {}) as Record<string, string>;
      const provided = input.participantFields ?? {};
      const fields = anonymous
        ? // No pointer to the address hash and no address: the sealed pointer on the campaign's
          // hash row is how an anonymous response is found again (D-142).
          pick(provided, ["role", "department"])
        : { ...existing, ...provided };
      await this.db.participant.update({ where: { id: session.participant.id }, data: { fields } });
    }
    if (anonymous) {
      // A participant who chose anonymity after the link was bound: the invitation stops naming
      // their session and keeps only the day it was opened.
      const invitation = await this.db.invitation.findUnique({ where: { sessionId } });
      if (invitation)
        await this.db.invitation.update({
          where: { id: invitation.id },
          data: {
            sessionId: null,
            openedAt: invitation.openedAt ? startOfUtcDay(invitation.openedAt) : null,
          },
        });
    }
    await this.db.session.update({
      where: { id: sessionId },
      data: { status: "consented", consentVersion: input.consentVersion, consentedAt: new Date() },
    });
  }

  /** Whether this interview may use voice of this kind: the tenant's flag ANDed with the template's (D-186). */
  voiceAllowed(companyId: string, sessionId: string, mode: VoiceMode): Promise<boolean> {
    return voiceAllowedForSession(this.db, this.settings, { companyId, sessionId, mode });
  }

  async setPath(sessionId: string, path: "technical" | "nontechnical"): Promise<void> {
    await this.db.session.update({ where: { id: sessionId }, data: { path } });
  }

  /**
   * Records the answer-mode preference and, when it actually changed, a `mode_switch` event so the
   * transcript can show where the participant moved from typing to speaking (D-171). `reason` says
   * whether the participant chose it or the client fell back.
   */
  async setMode(
    sessionId: string,
    mode: "chat" | "options" | "voice",
    reason: ModeSwitchReason = "participant",
  ): Promise<void> {
    const before = await this.db.session.findUniqueOrThrow({
      where: { id: sessionId },
      select: { modePreference: true },
    });
    await this.db.session.update({ where: { id: sessionId }, data: { modePreference: mode } });
    if (before.modePreference !== mode)
      await new PrismaSessionStore(this.db).appendEvent(sessionId, "mode_switch", {
        from: before.modePreference,
        to: mode,
        reason,
      });
  }

  async pause(sessionId: string): Promise<void> {
    await this.db.session.updateMany({
      where: { id: sessionId, status: "active" },
      data: { status: "paused" },
    });
  }

  /**
   * "I'm done": the next turn asks the closing question.
   *
   * Legacy path: the web sends a `finish` control with the turn instead (D-170); this endpoint stays
   * for clients installed before it, and now sets the same flag rather than the old turn-count
   * sentinel.
   */
  async requestCompletion(sessionId: string): Promise<void> {
    await requestFinish(this.db, sessionId);
  }

  /**
   * "Delete my data" (FR-13): one definition of deletion, shared with the retention sweep.
   *
   * Answers what the route needs to confirm by email, or null when there is nobody to tell. The
   * address is read before the erase (the participant row goes with it) and leaves this method
   * encrypted, for a job; nothing here stores it. Only an identified participant has one: an
   * anonymous response keeps no address on the participant row at all (D-142).
   */
  async deleteData(sessionId: string): Promise<DeletionNotice | null> {
    const session = await this.db.session.findUnique({
      where: { id: sessionId },
      include: {
        participant: { select: { fields: true } },
        campaign: { select: { name: true, participationMode: true } },
        template: { select: { language: true } },
      },
    });
    const fields = (session?.participant?.fields ?? {}) as Record<string, unknown>;
    const address =
      session?.campaign &&
      session.campaign.participationMode !== "anonymous" &&
      typeof fields.email === "string"
        ? fields.email.trim()
        : "";
    const alreadyDeleted = session?.status === "deleted";
    await deleteSessionData(this.db, sessionId, { markEnded: true, crypto: this.crypto });
    if (!session?.campaign || alreadyDeleted || address === "") return null;
    return {
      companyId: session.companyId,
      sessionId,
      toEnc: this.crypto.encrypt(address),
      campaignName: session.campaign.name,
      language: session.template.language,
      deletedAt: new Date().toISOString(),
    };
  }

  async summary(sessionId: string): Promise<{ summary: string; facts: unknown[] }> {
    const s = await this.db.session.findUniqueOrThrow({ where: { id: sessionId } });
    const st = s.state as { facts?: unknown[]; participantSummary?: string };
    return { summary: st.participantSummary ?? "", facts: st.facts ?? [] };
  }

  async setSummary(sessionId: string, summary: string): Promise<void> {
    const s = await this.db.session.findUniqueOrThrow({ where: { id: sessionId } });
    await this.db.session.update({
      where: { id: sessionId },
      data: { state: { ...(s.state as Record<string, unknown>), participantSummary: summary } },
    });
  }

  sessionView(
    session: Session,
    participant: Participant | null,
  ): {
    id: string;
    status: string;
    path: string | null;
    modePreference: string;
    consented: boolean;
    participant: Record<string, string>;
  } {
    const fields = { ...((participant?.fields ?? {}) as Record<string, string>) };
    delete fields._emailHash;
    return {
      id: session.id,
      status: session.status,
      path: session.path,
      modePreference: session.modePreference,
      consented: session.consentedAt !== null,
      participant: fields,
    };
  }
}

/** The start of the UTC day: what a timestamp is coarsened to on an anonymous campaign. */
function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** A participant's fields without the address-hash pointer. */
function withoutPointer(fields: unknown): Record<string, string> {
  const { _emailHash: _removed, ...rest } = (fields ?? {}) as Record<string, string>;
  return rest;
}

function pick(o: Record<string, string>, keys: string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(o).filter(([k]) => keys.includes(k)));
}
