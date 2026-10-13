import {
  emailDomain,
  newToken,
  normalizeEmail,
  type Crypto,
  type EmailPort,
  type SettingsService,
} from "@aidp/core";
import { containsInsensitive, escapeLike, tenantBatch } from "@aidp/db";
import { toListResponse, type ListEnvelope } from "@aidp/shared";
import type { Campaign, Invitation, Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { AppError, notFound } from "../../lib/errors.js";
import { defined } from "../../lib/objects.js";
import { listOrder, listQuery, listSpec, searchTerm } from "../../lib/pagination.js";

/** `/campaigns` (D-79): `q` matches the name. */
export const CampaignList = listSpec({
  sort: { createdAt: "desc", name: "asc", status: "asc" },
  defaultSort: "createdAt",
  filters: { status: z.enum(["draft", "open", "analyzing", "closed"]).optional() },
});

export const CampaignListQuery = listQuery(CampaignList);
export type CampaignListQuery = z.output<typeof CampaignListQuery>;

/**
 * `/campaigns/:id/sessions` (D-79). `q` matches the session id exactly, and the participant's
 * `name` or `email` field only where that participant is identified: the campaign is
 * `identified`, or it is `participant_choice` and the participant has consented (consent is where
 * they choose). An anonymous participant keeps no email, and even a stray one is never searched,
 * so a search cannot be used to learn which session an anonymous person wrote.
 */
export const CampaignSessionList = listSpec({
  sort: { createdAt: "desc", startedAt: "desc", lastActivity: "desc", status: "asc" },
  defaultSort: "createdAt",
  columns: { lastActivity: "updatedAt" },
  nullable: ["startedAt"],
  filters: {
    status: z.enum(["created", "consented", "active", "paused", "completed", "deleted"]).optional(),
  },
});

export const CampaignSessionListQuery = listQuery(CampaignSessionList);
export type CampaignSessionListQuery = z.output<typeof CampaignSessionListQuery>;

export interface CampaignSessionRow {
  id: string;
  status: string;
  turns: number;
  areasCovered: number;
  mode: string;
  costCents: number;
  participantName: string | null;
  participantEmail: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
  lastActivityAt: Date;
}

/** Whether a session's participant may be named on a staff screen or found by a search. */
function identified(mode: string, consented: boolean): boolean {
  return mode === "identified" || (mode === "participant_choice" && consented);
}

/** The identity a staff list may show, under the same rule the search follows. */
function visibleIdentity(
  mode: string,
  consented: boolean,
  fields: unknown,
): { participantName: string | null; participantEmail: string | null } {
  const f = (fields ?? {}) as Record<string, unknown>;
  const show = identified(mode, consented);
  const str = (v: unknown): string | null => (show && typeof v === "string" && v ? v : null);
  return { participantName: str(f.name), participantEmail: str(f.email) };
}

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
  async list(companyId: string, query: CampaignListQuery): Promise<{ campaigns: Campaign[]; total: number }> {
    const q = searchTerm(query.q);
    const where: Prisma.CampaignWhereInput = {
      companyId,
      ...(q ? { name: containsInsensitive(q) } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const [campaigns, total] = await tenantBatch(this.db, [
      this.db.campaign.findMany({
        where,
        orderBy: listOrder<Prisma.CampaignOrderByWithRelationInput, typeof query.sort>(CampaignList, query),
        take: query.limit,
        skip: query.offset,
      }),
      this.db.campaign.count({ where }),
    ]);
    return { campaigns, total };
  }

  /** One page of a campaign's sessions, with this page's spend and only the identity staff may see. */
  async sessionsPage(
    companyId: string,
    campaignId: string,
    query: CampaignSessionListQuery,
  ): Promise<ListEnvelope<"sessions", CampaignSessionRow>> {
    const campaign = await this.get(companyId, campaignId);
    const mode = campaign.participationMode;
    const q = searchTerm(query.q);
    const fieldMatch = (key: "name" | "email", term: string): Prisma.SessionWhereInput => ({
      participant: { fields: { path: [key], string_contains: escapeLike(term), mode: "insensitive" } },
    });
    // Identity is searchable only where it would be shown (see CampaignSessionList).
    const identity: Prisma.SessionWhereInput[] =
      q === undefined || (mode !== "identified" && mode !== "participant_choice")
        ? []
        : [
            {
              ...(mode === "identified" ? {} : { consentedAt: { not: null } }),
              OR: [fieldMatch("name", q), fieldMatch("email", q)],
            },
          ];
    const where: Prisma.SessionWhereInput = {
      campaignId: campaign.id,
      companyId,
      ...(query.status ? { status: query.status } : {}),
      ...(q === undefined ? {} : { OR: [{ id: q }, ...identity] }),
    };
    const [sessions, total] = await tenantBatch(this.db, [
      this.db.session.findMany({
        where,
        orderBy: listOrder<Prisma.SessionOrderByWithRelationInput, typeof query.sort>(
          CampaignSessionList,
          query,
        ),
        take: query.limit,
        skip: query.offset,
        select: {
          id: true,
          status: true,
          state: true,
          startedAt: true,
          endedAt: true,
          createdAt: true,
          updatedAt: true,
          consentedAt: true,
          modePreference: true,
          participant: { select: { fields: true } },
        },
      }),
      this.db.session.count({ where }),
    ]);
    // Costs for this page only, rather than every session the campaign ever had.
    const costs = sessions.length
      ? await this.db.llmCall.groupBy({
          by: ["sessionId"],
          where: { companyId, sessionId: { in: sessions.map((s) => s.id) } },
          _sum: { costCents: true },
        })
      : [];
    const costOf = new Map(costs.map((c) => [c.sessionId, c._sum.costCents ?? 0]));
    const rows = sessions.map((s) => {
      const st = s.state as { turnCount?: number; coverage?: Record<string, { status: string }> };
      const covered = Object.values(st.coverage ?? {}).filter(
        (c) => c.status === "covered" || c.status === "skipped",
      ).length;
      return {
        id: s.id,
        status: s.status,
        turns: st.turnCount ?? 0,
        areasCovered: covered,
        mode: s.modePreference,
        costCents: costOf.get(s.id) ?? 0,
        ...visibleIdentity(mode, s.consentedAt !== null, s.participant?.fields),
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        createdAt: s.createdAt,
        lastActivityAt: s.updatedAt,
      };
    });
    return toListResponse("sessions", rows, total, query);
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
