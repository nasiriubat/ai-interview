import { createHash } from "node:crypto";
import {
  deleteSessionData,
  emailDomain,
  newNumericCode,
  newToken,
  normalizeEmail,
  type Crypto,
  type EmailPort,
  type SettingsService,
  type TenantGate,
} from "@aidp/core";
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

/** A counted abuse signal. Carries ids only, never an address (D-82). */
export type AbuseEvent = "abuse.code_request_capped" | "abuse.code_confirm_locked";

const HOUR_MS = 60 * 60_000;

/** The public participant flow: link resolution, uniqueness, session binding (FR-04, FR-10, FR-11, 06). */
export class ParticipantService {
  constructor(
    private readonly db: PrismaClient,
    private readonly crypto: Crypto,
    private readonly settings: SettingsService,
    private readonly email: EmailPort,
    private readonly tenants: TenantGate,
    private readonly onAbuse: (event: AbuseEvent, meta: { campaignId: string }) => void = () => undefined,
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
    const values = await this.settings.resolveMany(["branding.productName", "campaign.consentText"], chain);
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
        consentText: values["campaign.consentText"] as string,
        consentVersion: `v${createHash("sha256")
          .update(values["campaign.consentText"] as string)
          .digest("hex")
          .slice(0, 12)}`,
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
    const emailHash = this.crypto.hashEmail(email);
    // Per-address cap (D-82): the shared per-IP bucket cannot stop one person mail-bombing a
    // victim through this endpoint from many addresses, so the address itself is counted. The
    // count is the EmailCode rows of the last hour, which persist across restarts and replicas.
    // A refused request still answers "ok": the response must not say whether an address was
    // already asked for, and the attacker learns nothing by hitting the cap.
    const { requests } = await this.codeLimits(campaign.companyId);
    const since = new Date(Date.now() - HOUR_MS);
    await this.db.emailCode.deleteMany({
      where: { campaignId: campaign.id, emailHash, createdAt: { lt: since } },
    });
    const recent = await this.db.emailCode.count({ where: { campaignId: campaign.id, emailHash } });
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
    const emailHash = this.crypto.hashEmail(email);
    // Guessing is bounded per address, not only per code: the six-digit space is small, and a
    // fresh code resets a per-code counter.
    const { failures } = await this.codeLimits(campaign.companyId);
    const since = new Date(Date.now() - HOUR_MS);
    const spent = await this.db.emailCode.aggregate({
      where: { campaignId: campaign.id, emailHash, createdAt: { gte: since } },
      _sum: { attempts: true },
    });
    if ((spent._sum.attempts ?? 0) >= failures) {
      this.onAbuse("abuse.code_confirm_locked", { campaignId: campaign.id });
      throw new AppError("forbidden", "Code expired or invalid");
    }
    const row = await this.db.emailCode.findFirst({
      where: { campaignId: campaign.id, emailHash },
      orderBy: { createdAt: "desc" },
    });
    if (!row || row.expiresAt.getTime() < Date.now() || row.attempts >= 5)
      throw new AppError("forbidden", "Code expired or invalid");
    if (!this.crypto.verifyTokenHash(code, row.codeHash)) {
      await this.db.emailCode.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
      throw new AppError("forbidden", "Code expired or invalid");
    }
    await this.db.emailCode.delete({ where: { id: row.id } });
    return this.bindByEmailHash(
      campaign,
      emailHash,
      campaign.participationMode === "anonymous" ? null : normalizeEmail(email),
    );
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
      const bound = await this.bindByEmailHash(campaign, inv.emailHash, inv.email);
      await this.db.invitation.update({
        where: { id: inv.id },
        data: { status: "bound", openedAt: inv.openedAt ?? new Date(), sessionId: bound.sessionId },
      });
      return bound;
    }
    if (campaign.verification !== "open")
      throw new AppError("forbidden", "This interview requires verification");
    // Open links accept duplicates by design: every open creates a new anonymous participant.
    return this.createParticipantAndSession(campaign, null, null);
  }

  private async bindByEmailHash(
    campaign: Campaign,
    emailHash: string,
    email: string | null,
  ): Promise<{ participantToken: string; sessionId: string; resume: boolean }> {
    const existing = await this.db.campaignEmailHash.findUnique({
      where: { campaignId_emailHash: { campaignId: campaign.id, emailHash } },
    });
    if (existing) {
      // One response per person: find the participant bound to this hash and re-issue its token.
      const participant = await this.db.participant.findFirst({
        where: { campaignId: campaign.id, fields: { path: ["_emailHash"], equals: emailHash } },
        include: { sessions: { take: 1 } },
      });
      const session = participant?.sessions[0];
      if (participant && session) {
        if (session.status === "deleted")
          throw new AppError("conflict", "Your answers were deleted; this link cannot be reused");
        const token = newToken(24);
        await this.db.participant.update({
          where: { id: participant.id },
          data: { tokenHash: this.crypto.hashToken(token) },
        });
        return { participantToken: token, sessionId: session.id, resume: session.status !== "created" };
      }
    }
    await this.db.campaignEmailHash.create({ data: { companyId: campaign.companyId, campaignId: campaign.id, emailHash } });
    return this.createParticipantAndSession(campaign, emailHash, email);
  }

  private async createParticipantAndSession(
    campaign: Campaign,
    emailHash: string | null,
    email: string | null,
  ): Promise<{ participantToken: string; sessionId: string; resume: boolean }> {
    const token = newToken(24);
    const fields: Record<string, string> = {};
    if (emailHash) fields._emailHash = emailHash; // uniqueness pointer; never shown
    if (email && campaign.participationMode !== "anonymous") fields.email = email;
    const participant = await this.db.participant.create({
      data: {
        companyId: campaign.companyId,
        campaignId: campaign.id,
        fields,
        tokenHash: this.crypto.hashToken(token),
      },
    });
    const session = await this.db.session.create({
      data: {
        companyId: campaign.companyId,
        templateId: campaign.templateId,
        campaignId: campaign.id,
        participantId: participant.id,
        sourceKind: "campaign",
        status: "created",
        templateVersion: 1,
      },
    });
    return { participantToken: token, sessionId: session.id, resume: false };
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
        ? {
            ...(existing._emailHash ? { _emailHash: existing._emailHash } : {}),
            ...pick(provided, ["role", "department"]),
          }
        : { ...existing, ...provided };
      await this.db.participant.update({ where: { id: session.participant.id }, data: { fields } });
    }
    await this.db.session.update({
      where: { id: sessionId },
      data: { status: "consented", consentVersion: input.consentVersion, consentedAt: new Date() },
    });
  }

  async setPath(sessionId: string, path: "technical" | "nontechnical"): Promise<void> {
    await this.db.session.update({ where: { id: sessionId }, data: { path } });
  }

  async setMode(sessionId: string, mode: "chat" | "options" | "voice"): Promise<void> {
    await this.db.session.update({ where: { id: sessionId }, data: { modePreference: mode } });
  }

  async pause(sessionId: string): Promise<void> {
    await this.db.session.updateMany({
      where: { id: sessionId, status: "active" },
      data: { status: "paused" },
    });
  }

  /** "I'm done": the next turn asks the closing question. */
  async requestCompletion(sessionId: string): Promise<void> {
    const s = await this.db.session.findUniqueOrThrow({ where: { id: sessionId } });
    const state = { ...(s.state as Record<string, unknown>), turnCount: Number.MAX_SAFE_INTEGER >> 1 };
    await this.db.session.update({ where: { id: sessionId }, data: { state } });
  }

  /** "Delete my data" (FR-13): one definition of deletion, shared with the retention sweep. */
  async deleteData(sessionId: string): Promise<void> {
    await deleteSessionData(this.db, sessionId, { markEnded: true });
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

function pick(o: Record<string, string>, keys: string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(o).filter(([k]) => keys.includes(k)));
}
