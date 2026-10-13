import { tenantBatch } from "@aidp/db";
import { toListResponse, type ListEnvelope } from "@aidp/shared";
import type { Prisma, PrismaClient, User } from "@prisma/client";
import { z } from "zod";
import { emailTaken, isUniqueViolation, notFound } from "../../lib/errors.js";
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
    const user = await this.db.user.update({ where: { id: existing.id }, data: defined(patch) });
    await this.audit.record(companyId, {
      actorId,
      action: "user.update",
      targetType: "user",
      targetId: user.id,
      diff: patch,
    });
    return user;
  }
}
