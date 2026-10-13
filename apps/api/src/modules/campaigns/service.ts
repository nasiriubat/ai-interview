import {
  emailDomain,
  newToken,
  normalizeEmail,
  type Crypto,
  type EmailPort,
  type SettingsService,
} from "@aidp/core";
import { containsInsensitive, tenantBatch } from "@aidp/db";
import type { Campaign, Invitation, Prisma, PrismaClient } from "@prisma/client";
import { AppError, notFound } from "../../lib/errors.js";
import { defined } from "../../lib/objects.js";

export interface CampaignCreate {
  templateId: string;
  name: string;
  participationMode?: "identified" | "anonymous" | "participant_choice" | undefined;
  verification?: "invitation" | "email_code" | "open" | undefined;
  allowedEmailDomains?: string[] | undefined;
  maxTurns?: number | undefined;
  completionThreshold?: number | undefined;
  expiresAt?: Date | undefined;
}

export interface CampaignPatch {
  name?: string | undefined;
  allowedEmailDomains?: string[] | undefined;
  maxTurns?: number | undefined;
  completionThreshold?: number | undefined;
  expiresAt?: Date | undefined;
}

/** Campaigns, share links, invitations, reminders (FR-10, FR-04, 06). */
export class CampaignService {
  constructor(
    private readonly db: PrismaClient,
    private readonly crypto: Crypto,
    private readonly settings: SettingsService,
    private readonly email: EmailPort,
    private readonly publicWebUrl: string,
  ) {}

  /** One page of campaigns with the row count beside it; `total` counts the filtered set (D-79). */
  async list(
    companyId: string,
    query: {
      limit: number;
      offset: number;
      q?: string | undefined;
      status?: string | undefined;
      orderBy: Prisma.CampaignOrderByWithRelationInput[];
    },
  ): Promise<{ campaigns: Campaign[]; total: number }> {
    const where: Prisma.CampaignWhereInput = {
      companyId,
      ...(query.q ? { name: containsInsensitive(query.q) } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const [campaigns, total] = await tenantBatch(this.db, [
      this.db.campaign.findMany({
        where,
        orderBy: query.orderBy,
        take: query.limit,
        skip: query.offset,
      }),
      this.db.campaign.count({ where }),
    ]);
    return { campaigns, total };
  }

  async get(companyId: string, id: string): Promise<Campaign & { linkToken?: undefined }> {
    const c = await this.db.campaign.findFirst({ where: { id, companyId } });
    if (!c) throw notFound("Campaign");
    return c;
  }

  /** Returns the campaign and its share link. The link token is stored hashed; the plain token is derived and shown to admins. */
  async create(
    companyId: string,
    input: CampaignCreate,
    createdById: string,
  ): Promise<{ campaign: Campaign; link: string }> {
    const template = await this.db.interviewTemplate.findFirst({
      where: { id: input.templateId, OR: [{ companyId }, { companyId: null }], status: "published" },
    });
    if (!template) throw new AppError("validation", "Template not found or not published");
    const chain = [{ scope: "tenant" as const, scopeId: companyId }];
    const defaults = await this.settings.resolveMany(
      [
        "campaign.verification",
        "campaign.allowedEmailDomains",
        "campaign.linkExpiryDays",
        "engine.maxTurns",
        "campaign.completionThreshold",
      ],
      chain,
    );
    const token = newToken(24);
    const campaign = await this.db.campaign.create({
      data: {
        companyId,
        templateId: template.id,
        name: input.name,
        participationMode: input.participationMode ?? template.privacyMode,
        linkTokenHash: this.crypto.hashToken(token),
        verification: input.verification ?? (defaults["campaign.verification"] as string),
        allowedEmailDomains:
          input.allowedEmailDomains ?? (defaults["campaign.allowedEmailDomains"] as string[]),
        maxTurns: input.maxTurns ?? (defaults["engine.maxTurns"] as number),
        completionThreshold:
          input.completionThreshold ?? (defaults["campaign.completionThreshold"] as number),
        expiresAt:
          input.expiresAt ??
          new Date(Date.now() + (defaults["campaign.linkExpiryDays"] as number) * 86400_000),
        createdById,
      },
    });
    // The plain link token is kept encrypted so admins can copy the link later.
    await this.db.setting.create({
      data: { scope: "campaign", scopeId: campaign.id, key: "_linkToken", value: this.crypto.encrypt(token) },
    });
    return { campaign, link: this.linkFor(token) };
  }

  async link(companyId: string, campaignId: string): Promise<string> {
    await this.get(companyId, campaignId);
    const row = await this.db.setting.findUnique({
      where: { scope_scopeId_key: { scope: "campaign", scopeId: campaignId, key: "_linkToken" } },
    });
    if (!row || typeof row.value !== "string") throw notFound("Campaign link");
    return this.linkFor(this.crypto.decrypt(row.value));
  }

  linkFor(token: string): string {
    return `${this.publicWebUrl.replace(/\/$/, "")}/p/${token}`;
  }

  async update(companyId: string, id: string, patch: CampaignPatch): Promise<Campaign> {
    const c = await this.get(companyId, id);
    return this.db.campaign.update({ where: { id: c.id }, data: defined(patch) });
  }

  async setStatus(companyId: string, id: string, status: "open" | "closed"): Promise<Campaign> {
    const c = await this.get(companyId, id);
    return this.db.campaign.update({ where: { id: c.id }, data: { status } });
  }

  async invite(
    companyId: string,
    campaignId: string,
    emails: string[],
    actorName: string | null,
  ): Promise<{ created: number; skipped: string[] }> {
    const campaign = await this.get(companyId, campaignId);
    const allowed = campaign.allowedEmailDomains as string[];
    const skipped: string[] = [];
    let created = 0;
    for (const raw of emails) {
      const email = normalizeEmail(raw);
      if (
        !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ||
        (allowed.length && !allowed.includes(emailDomain(email)))
      ) {
        skipped.push(raw);
        continue;
      }
      const emailHash = this.crypto.hashEmail(email);
      const exists = await this.db.invitation.findUnique({
        where: { campaignId_emailHash: { campaignId, emailHash } },
      });
      if (exists) {
        skipped.push(raw);
        continue;
      }
      const token = newToken(24);
      const inv = await this.db.invitation.create({
        data: {
          companyId,
          campaignId,
          emailHash,
          email: campaign.participationMode === "anonymous" ? null : email,
          tokenHash: this.crypto.hashToken(token),
          expiresAt: campaign.expiresAt ?? new Date(Date.now() + 30 * 86400_000),
        },
      });
      await this.sendInvitation(campaign, email, token, actorName);
      await this.db.invitation.update({
        where: { id: inv.id },
        data: { status: "sent", sentAt: new Date() },
      });
      created++;
    }
    return { created, skipped };
  }

  async remind(companyId: string, campaignId: string, invitationId: string): Promise<void> {
    const campaign = await this.get(companyId, campaignId);
    const inv = await this.db.invitation.findFirst({ where: { id: invitationId, campaignId } });
    if (!inv) throw notFound("Invitation");
    if (inv.status === "bound" || inv.status === "revoked")
      throw new AppError("conflict", "Invitation already used or revoked");
    if (!inv.email)
      throw new AppError(
        "conflict",
        "Anonymous invitations cannot be reminded individually; share the link again",
      );
    const token = newToken(24);
    await this.db.invitation.update({
      where: { id: inv.id },
      data: { tokenHash: this.crypto.hashToken(token), sentAt: new Date(), status: "sent" },
    });
    await this.sendInvitation(campaign, inv.email, token, null, true);
  }

  async revoke(companyId: string, campaignId: string, invitationId: string): Promise<void> {
    await this.get(companyId, campaignId);
    await this.db.invitation.updateMany({
      where: { id: invitationId, campaignId, status: { notIn: ["bound"] } },
      data: { status: "revoked" },
    });
  }

  async invitations(companyId: string, campaignId: string): Promise<Invitation[]> {
    await this.get(companyId, campaignId);
    return this.db.invitation.findMany({ where: { campaignId }, orderBy: { createdAt: "asc" } });
  }

  /**
   * The counters a campaign row shows in the list, for a whole page in two grouped queries
   * rather than two per row. `invited` leaves out revoked invitations, as the detail view does;
   * `started` is every session past `created` that still exists (not `deleted`).
   */
  async listStats(
    companyId: string,
    campaignIds: string[],
  ): Promise<Map<string, { invited: number; started: number; completed: number }>> {
    const out = new Map(campaignIds.map((id) => [id, { invited: 0, started: 0, completed: 0 }]));
    if (campaignIds.length === 0) return out;
    const [invitations, sessions] = await tenantBatch(this.db, [
      this.db.invitation.groupBy({
        by: ["campaignId"],
        where: { campaignId: { in: campaignIds }, campaign: { companyId }, status: { not: "revoked" } },
        _count: { _all: true },
      }),
      this.db.session.groupBy({
        by: ["campaignId", "status"],
        where: { companyId, campaignId: { in: campaignIds } },
        _count: { _all: true },
      }),
    ]);
    for (const i of invitations) {
      const row = out.get(i.campaignId);
      if (row) row.invited = i._count._all;
    }
    for (const s of sessions) {
      const row = s.campaignId ? out.get(s.campaignId) : undefined;
      if (!row) continue;
      if (s.status !== "created" && s.status !== "deleted") row.started += s._count._all;
      if (s.status === "completed") row.completed += s._count._all;
    }
    return out;
  }

  async stats(
    companyId: string,
    campaignId: string,
  ): Promise<{ invited: number; started: number; completed: number; dropOffByArea: Record<string, number> }> {
    await this.get(companyId, campaignId);
    const [invited, sessions] = await Promise.all([
      this.db.invitation.count({ where: { campaignId, status: { not: "revoked" } } }),
      this.db.session.findMany({ where: { campaignId }, select: { status: true, state: true } }),
    ]);
    // One rule for "started", shared with the campaign list's counters: every session past the
    // link except those the participant deleted, whose answers no longer exist to count.
    const counted = sessions.filter((s) => s.status !== "deleted");
    const dropOffByArea: Record<string, number> = {};
    for (const s of counted) {
      if (s.status === "completed") continue;
      const area = (s.state as { lastAreaKey?: string }).lastAreaKey ?? "start";
      dropOffByArea[area] = (dropOffByArea[area] ?? 0) + 1;
    }
    return {
      invited,
      started: counted.filter((s) => s.status !== "created").length,
      completed: counted.filter((s) => s.status === "completed").length,
      dropOffByArea,
    };
  }

  private async sendInvitation(
    campaign: Campaign,
    email: string,
    token: string,
    from: string | null,
    reminder = false,
  ): Promise<void> {
    const productName = await this.settings.get("branding.productName", [
      { scope: "tenant", scopeId: campaign.companyId },
    ]);
    const link = `${this.linkFor("i")}?invitation=${token}`;
    await this.email.send({
      to: email,
      companyId: campaign.companyId,
      subject: `${reminder ? "Reminder: " : ""}${campaign.name}`,
      text: `${from ? `${from} invited you` : "You are invited"} to a short interview about how your work is done.\n\nOpen your personal link: ${link}\n\nIt takes about 20 minutes, can be paused, and you can delete your answers at any time.\n\n${productName}`,
    });
  }
}
