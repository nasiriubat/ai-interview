import { createHash } from "node:crypto";
import {
  emailDomain,
  newToken,
  normalizeEmail,
  type Crypto,
  type EmailPort,
  type SettingsService,
  type TenantCeilings,
} from "@aidp/core";
import { containsInsensitive, escapeLike, tenantBatch, tenantTransaction } from "@aidp/db";
import { toListResponse, type ListEnvelope } from "@aidp/shared";
import type { Campaign, Invitation, Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { AppError, notFound } from "../../lib/errors.js";
import { defined } from "../../lib/objects.js";
import { listOrder, listQuery, listSpec, searchTerm } from "../../lib/pagination.js";
import { csvFileName, toCsv } from "./csv.js";

/** The export stops here rather than building a file nobody can open (50 pages of 200). */
export const SESSIONS_CSV_MAX_ROWS = 10_000;

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
    /** `true` lists the interviews the engine flagged for hostility or distress (D-173). */
    flagged: z.enum(["true", "false"]).optional(),
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
  /** Flagged by the engine; the reason is only on the session detail, behind the transcript rule. */
  flagged: boolean;
  flagAckedAt: Date | null;
  costCents: number;
  participantName: string | null;
  participantEmail: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
  lastActivityAt: Date;
}

/**
 * What an anonymous campaign's session list may say about time and order (D-142). A timestamp to
 * the second, or an order that follows creation, can be read against the day an invitation was
 * opened or the order addresses were invited, which would put a name to a session. So times are a
 * day wide and the order is a stable one that follows no clock.
 */
function toDay(d: Date): Date;
function toDay(d: Date | null): Date | null;
function toDay(d: Date | null): Date | null {
  return d ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) : null;
}
const stableKey = (campaignId: string, id: string): string =>
  createHash("sha256").update(`${campaignId}:${id}`).digest("hex");

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
    /** Refuses a new campaign past `ceiling.maxActiveCampaigns` (D-188). Absent in tools that never create one. */
    private readonly ceilings?: TenantCeilings,
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
      ...(query.flagged ? { flagged: query.flagged === "true" } : {}),
      ...(q === undefined ? {} : { OR: [{ id: q }, ...identity] }),
    };
    // An anonymous campaign is paged in a stable order that follows no clock (see `stableKey`):
    // the matching ids are ordered here, and the page's rows are read afterwards.
    const pageIds =
      mode === "anonymous"
        ? (await this.db.session.findMany({ where, select: { id: true } }))
            .map((s) => s.id)
            .sort((x, y) => stableKey(campaign.id, x).localeCompare(stableKey(campaign.id, y)))
            .slice(query.offset, query.offset + query.limit)
        : null;
    const [sessionRows, total] = await tenantBatch(this.db, [
      this.db.session.findMany({
        where: pageIds ? { ...where, id: { in: pageIds } } : where,
        orderBy: listOrder<Prisma.SessionOrderByWithRelationInput, typeof query.sort>(
          CampaignSessionList,
          query,
        ),
        ...(pageIds ? {} : { take: query.limit, skip: query.offset }),
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
          flagged: true,
          flagAckedAt: true,
          participant: { select: { fields: true } },
        },
      }),
      this.db.session.count({ where }),
    ]);
    const sessions = pageIds
      ? [...sessionRows].sort((a, b) => pageIds.indexOf(a.id) - pageIds.indexOf(b.id))
      : sessionRows;
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
        flagged: s.flagged,
        flagAckedAt: s.flagAckedAt,
        costCents: costOf.get(s.id) ?? 0,
        ...visibleIdentity(mode, s.consentedAt !== null, s.participant?.fields),
        // A person who is not named on this screen is not given a time to the second either.
        ...(identified(mode, s.consentedAt !== null)
          ? {
              startedAt: s.startedAt,
              endedAt: s.endedAt,
              createdAt: s.createdAt,
              lastActivityAt: s.updatedAt,
            }
          : {
              startedAt: toDay(s.startedAt),
              endedAt: toDay(s.endedAt),
              createdAt: toDay(s.createdAt),
              lastActivityAt: toDay(s.updatedAt),
            }),
      };
    });
    return toListResponse("sessions", rows, total, query);
  }

  /**
   * Every session of a campaign as CSV, for an administrator (D-236). It is the list the staff
   * screen shows, so it follows the same identity rule: a participant who is not named there has
   * no name, no email and no session id here either, and their times are a day wide. Anonymous
   * rows are numbered instead, in the stable order that follows no clock.
   */
  async sessionsCsv(
    companyId: string,
    campaignId: string,
  ): Promise<{ filename: string; body: string; rows: number }> {
    const campaign = await this.get(companyId, campaignId);
    const all: CampaignSessionRow[] = [];
    for (let offset = 0; offset < SESSIONS_CSV_MAX_ROWS; offset += 200) {
      const page = await this.sessionsPage(companyId, campaignId, {
        limit: 200,
        offset,
        sort: "createdAt",
        dir: "desc",
      });
      all.push(...page.sessions);
      if (page.sessions.length < 200) break;
    }
    const header = [
      "row",
      "session_id",
      "participant_name",
      "participant_email",
      "status",
      "mode",
      "turns",
      "areas_covered",
      "flagged",
      "cost_cents",
      "started_at",
      "ended_at",
      "last_activity_at",
    ];
    const body = toCsv(
      header,
      all.map((s, i) => {
        const named =
          campaign.participationMode === "identified" ||
          s.participantName !== null ||
          s.participantEmail !== null;
        const when = (d: Date | null): string =>
          d === null ? "" : named ? d.toISOString() : d.toISOString().slice(0, 10);
        return [
          i + 1,
          named ? s.id : "",
          s.participantName,
          s.participantEmail,
          s.status,
          s.mode,
          s.turns,
          s.areasCovered,
          s.flagged,
          s.costCents.toFixed(2),
          when(s.startedAt),
          when(s.endedAt),
          when(s.lastActivityAt),
        ];
      }),
    );
    return { filename: csvFileName(campaign.name, "sessions"), body, rows: all.length };
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
    await this.ceilings?.assertRoom(companyId, "maxActiveCampaigns");
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
      data: {
        scope: "campaign",
        scopeId: campaign.id,
        key: "_linkToken",
        value: this.crypto.encrypt(token, "campaign.linkToken"),
      },
    });
    // Tells the tenant (and the operator) at 80 and 100 percent, once, without delaying the answer.
    await this.ceilings?.afterChange(companyId);
    return { campaign, link: this.linkFor(token) };
  }

  async link(companyId: string, campaignId: string): Promise<string> {
    await this.get(companyId, campaignId);
    const row = await this.db.setting.findUnique({
      where: { scope_scopeId_key: { scope: "campaign", scopeId: campaignId, key: "_linkToken" } },
    });
    if (!row || typeof row.value !== "string") throw notFound("Campaign link");
    return this.linkFor(this.crypto.decrypt(row.value, "campaign.linkToken"));
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
    const updated = await this.db.campaign.update({ where: { id: c.id }, data: { status } });
    if (status === "closed" && c.participationMode === "anonymous") await this.retireLegacyHashes(c.id);
    return updated;
  }

  /**
   * What a closed anonymous campaign no longer needs, and what must not outlive it (D-142).
   *
   * Rows written before the per-campaign salt carry the platform-wide hash of an address, which
   * matches the same person in every other campaign and tenant. They cannot be re-salted without
   * the address, so they are upgraded when the person returns, and whatever is still in the old
   * shape when the campaign closes is removed here: the legacy hash rows, pending codes, any
   * pointer still on a participant row, and the invitation's link to a session. The one cost is
   * that a campaign reopened afterwards cannot recognise a respondent whose row was removed.
   */
  private async retireLegacyHashes(campaignId: string): Promise<void> {
    await tenantTransaction(this.db, async (tx) => {
      await tx.campaignEmailHash.deleteMany({
        where: { campaignId, NOT: { emailHash: { startsWith: "h2:" } } },
      });
      await tx.emailCode.deleteMany({ where: { campaignId } });
      await tx.$executeRaw`
        UPDATE "Participant" SET "fields" = "fields" - '_emailHash'
         WHERE "campaignId" = ${campaignId} AND "fields" ? '_emailHash'`;
      await tx.$executeRaw`
        UPDATE "Invitation"
           SET "sessionId" = NULL,
               "openedAt" = date_trunc('day', "openedAt"),
               "emailHash" = CASE
                 WHEN "emailHash" LIKE 'h2:%' OR "emailHash" LIKE 'closed:%' OR "emailHash" LIKE 'deleted:%'
                   THEN "emailHash"
                 ELSE 'closed:' || md5(random()::text || "id") END
         WHERE "campaignId" = ${campaignId}`;
    });
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
      // Salted by campaign (D-142); an invitation written before that carries the platform-wide
      // value, so it is looked for as well and the address is not invited twice.
      const [emailHash = ""] = this.crypto.campaignEmailHashCandidates(email, campaignId);
      const exists = await this.db.invitation.findFirst({
        where: {
          campaignId,
          // Under every key in the ring, so an address invited before a key rotation is not
          // invited twice (D-164).
          emailHash: {
            in: [
              ...this.crypto.campaignEmailHashCandidates(email, campaignId),
              ...this.crypto.hashEmailCandidates(email),
            ],
          },
        },
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
      data: {
        tokenHash: this.crypto.hashToken(token),
        sentAt: new Date(),
        status: "sent",
        // The dashboard's "reminders sent" (spec 07) counts these, not audit rows, which are kept
        // for less time than a campaign runs.
        reminderCount: { increment: 1 },
        lastRemindedAt: new Date(),
      },
    });
    await this.sendInvitation(campaign, inv.email, token, null, true);
  }

  async revoke(companyId: string, campaignId: string, invitationId: string): Promise<void> {
    await this.get(companyId, campaignId);
    // An id that is not this campaign's is a 404, not an "ok" with an audit row: a request that
    // changed nothing must not say it did (and must not file a record of revoking someone else's).
    const inv = await this.db.invitation.findFirst({
      where: { id: invitationId, campaignId },
      select: { id: true },
    });
    if (!inv) throw notFound("Invitation");
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
    // The campaign's own link, with the invitation token as a query. This used `/p/i`, a link token
    // that resolves to no campaign, so no personal link in an invitation email could be opened.
    const link = `${await this.link(campaign.companyId, campaign.id)}?invitation=${token}`;
    await this.email.send({
      to: email,
      companyId: campaign.companyId,
      subject: `${reminder ? "Reminder: " : ""}${campaign.name}`,
      text: `${from ? `${from} invited you` : "You are invited"} to a short interview about how your work is done.\n\nOpen your personal link: ${link}\n\nIt takes about 20 minutes, can be paused, and you can delete your answers at any time.\n\n${productName}`,
    });
  }
}
