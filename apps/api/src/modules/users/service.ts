import { tenantBatch, tenantTransaction } from "@aidp/db";
import { toListResponse, type ListEnvelope } from "@aidp/shared";
import type { Prisma, PrismaClient, User } from "@prisma/client";
import { z } from "zod";
import { AppError, emailTaken, isUniqueViolation, notFound } from "../../lib/errors.js";
import { defined } from "../../lib/objects.js";
import { contains, listOrder, listQuery, listSpec, searchTerm } from "../../lib/pagination.js";
import type { AuditService } from "../audit/service.js";

/** `/users` (D-79): `q` matches email or name. */
export const UserList = listSpec({
  sort: { createdAt: "asc", email: "asc", name: "asc", role: "asc" },
  defaultSort: "createdAt",
  nullable: ["name"],
  filters: { role: z.enum(["admin", "member", "platform_operator"]).optional() },
});

export const UserListQuery = listQuery(UserList);
export type UserListQuery = z.output<typeof UserListQuery>;

export interface UserCreate {
  email: string;
  name?: string | undefined;
  role: "admin" | "member";
}

export interface UserPatch {
  name?: string | undefined;
  role?: "admin" | "member" | undefined;
  /** true withdraws access immediately; false restores it (existing tokens stay revoked). */
  disabled?: boolean | undefined;
}

/** Staff of one tenant: listing, inviting, changing a role. Every action is audited. */
export class UsersService {
  constructor(
    private readonly db: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  /** The signed-in user and their company, for `GET /me`. */
  async me(
    companyId: string,
    userId: string,
  ): Promise<{
    user: { id: string; email: string; name: string | null; role: string; companyId: string };
    company: { id: string; name: string; status: string };
  }> {
    const user = await this.db.user.findFirstOrThrow({
      where: { id: userId, companyId },
      include: { company: true },
    });
    return {
      user: { id: user.id, email: user.email, name: user.name, role: user.role, companyId: user.companyId },
      company: { id: user.company.id, name: user.company.name, status: user.company.status },
    };
  }

  async list(companyId: string, query: UserListQuery): Promise<ListEnvelope<"users", User>> {
    const q = searchTerm(query.q);
    const where: Prisma.UserWhereInput = {
      companyId,
      ...(query.role ? { role: query.role } : {}),
      ...(q ? { OR: [{ email: contains(q) }, { name: contains(q) }] } : {}),
    };
    const [users, total] = await tenantBatch(this.db, [
      this.db.user.findMany({
        where,
        orderBy: listOrder<Prisma.UserOrderByWithRelationInput, typeof query.sort>(UserList, query),
        take: query.limit,
        skip: query.offset,
      }),
      this.db.user.count({ where }),
    ]);
    return toListResponse("users", users, total, query);
  }

  async create(companyId: string, actorId: string, input: UserCreate): Promise<User> {
    let user: User;
    try {
      user = await this.db.user.create({
        data: {
          companyId,
          email: input.email.toLowerCase(),
          name: input.name ?? null,
          role: input.role,
        },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Audited without the address: it belongs to someone in another tenant.
      await this.audit.record(companyId, {
        actorId,
        action: "user.create_refused",
        targetType: "user",
        targetId: "",
        diff: { reason: "email_taken" },
      });
      throw emailTaken();
    }
    await this.audit.record(companyId, {
      actorId,
      action: "user.create",
      targetType: "user",
      targetId: user.id,
      diff: { role: user.role },
    });
    return user;
  }

  async update(companyId: string, actorId: string, id: string, patch: UserPatch): Promise<User> {
    const existing = await this.db.user.findFirst({ where: { id, companyId } });
    if (!existing) throw notFound("User");
    const { disabled, ...rest } = patch;

    const losesAdmin =
      (rest.role !== undefined && rest.role !== existing.role && isAdminRole(existing.role)) ||
      (disabled === true && existing.disabledAt === null);
    if (losesAdmin && isAdminRole(existing.role)) {
      await this.assertNotSelf(actorId, existing.id, "change your own role or disable yourself");
      await this.assertNotLastAdmin(companyId, existing);
    }
    if (rest.role !== undefined && existing.role === "platform_operator") {
      throw new AppError("forbidden", "The platform operator's role cannot be changed here");
    }
    if (disabled === true && existing.disabledAt === null) {
      await this.assertNotSelf(actorId, existing.id, "disable yourself");
    }

    // Rounded up to a whole second because a JWT's `iat` has second resolution: a token issued
    // in the same second as the decision must lose, so the person signs in again afterwards.
    const now = new Date();
    const watermark = new Date(Math.ceil(now.getTime() / 1000) * 1000);
    const access =
      disabled === undefined
        ? {}
        : disabled
          ? existing.disabledAt === null
            ? { disabledAt: now, tokensValidAfter: watermark }
            : {}
          : { disabledAt: null, tokensValidAfter: watermark };
    const user = await this.db.user.update({
      where: { id: existing.id },
      data: { ...defined(rest), ...access },
    });
    await this.audit.record(companyId, {
      actorId,
      action: "user.update",
      targetType: "user",
      targetId: user.id,
      diff: { ...rest },
    });
    if (disabled !== undefined && (disabled ? existing.disabledAt === null : existing.disabledAt !== null)) {
      await this.audit.record(companyId, {
        actorId,
        action: disabled ? "user.disable" : "user.enable",
        targetType: "user",
        targetId: user.id,
        diff: { role: user.role },
      });
    }
    return user;
  }

  /**
   * Removes a staff member. Campaigns and interviews they owned move to the admin doing the
   * deleting, so nothing becomes unreachable (the owner column is required on a campaign); their
   * participant link, if any, is cleared. All of it happens in one transaction with the delete.
   */
  async remove(companyId: string, actorId: string, id: string): Promise<void> {
    const existing = await this.db.user.findFirst({ where: { id, companyId } });
    if (!existing) throw notFound("User");
    await this.assertNotSelf(actorId, existing.id, "delete yourself");
    if (isAdminRole(existing.role)) await this.assertNotLastAdmin(companyId, existing);

    // The heir is the admin doing the deleting. When the platform operator does it from outside
    // the tenant, that user is not in this tenant and must not be written into its rows, so the
    // longest-serving enabled administrator inherits instead.
    const inTenant = await this.db.user.findFirst({
      where: { id: actorId, companyId },
      select: { id: true },
    });
    const heir =
      inTenant?.id ??
      (
        await this.db.user.findFirst({
          where: { companyId, id: { not: existing.id }, role: "admin", disabledAt: null },
          orderBy: { createdAt: "asc" },
          select: { id: true },
        })
      )?.id;
    if (!heir) throw new AppError("conflict", "That is the last administrator; another one is needed first");

    const moved = await tenantTransaction(this.db, async (tx) => {
      const campaigns = await tx.campaign.updateMany({
        where: { companyId, createdById: existing.id },
        data: { createdById: heir },
      });
      const sessions = await tx.session.updateMany({
        where: { companyId, ownerUserId: existing.id },
        data: { ownerUserId: heir },
      });
      await tx.participant.updateMany({
        where: { companyId, userId: existing.id },
        data: { userId: null },
      });
      await tx.user.delete({ where: { id: existing.id } });
      return { campaigns: campaigns.count, sessions: sessions.count };
    });
    await this.audit.record(companyId, {
      actorId,
      action: "user.delete",
      targetType: "user",
      targetId: existing.id,
      // The address is personal data of someone leaving; the role and what moved are enough.
      diff: { role: existing.role, reassigned: moved },
    });
  }

  private async assertNotSelf(actorId: string, targetId: string, what: string): Promise<void> {
    if (actorId === targetId) throw new AppError("conflict", `You cannot ${what}`);
  }

  /** The tenant must keep at least one enabled admin (the operator tenant: one operator). */
  private async assertNotLastAdmin(companyId: string, target: User): Promise<void> {
    const others = await this.db.user.count({
      where: {
        companyId,
        id: { not: target.id },
        role: { in: ["admin", "platform_operator"] },
        disabledAt: null,
      },
    });
    if (others === 0) {
      throw new AppError("conflict", "That is the last administrator; another one is needed first");
    }
  }
}

function isAdminRole(role: string): boolean {
  return role === "admin" || role === "platform_operator";
}
