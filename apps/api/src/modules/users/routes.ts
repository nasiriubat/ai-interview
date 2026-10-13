import { tenantBatch } from "@aidp/db";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import type { App } from "../../app.js";
import { requireStaff, staff } from "../../auth/plugin.js";
import type { AppContext } from "../../context.js";
import { audit } from "../../lib/audit.js";
import { notFound } from "../../lib/errors.js";
import { defined } from "../../lib/objects.js";
import { contains, listOrder, listQuery, listSpec, searchTerm } from "../../lib/pagination.js";

/** `/users` (D-79): `q` matches email or name. */
export const UserList = listSpec({
  sort: { createdAt: "asc", email: "asc", name: "asc", role: "asc" },
  defaultSort: "createdAt",
  nullable: ["name"],
  filters: { role: z.enum(["admin", "member", "platform_operator"]).optional() },
});

const UserOut = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  role: z.string(),
  companyId: z.string(),
  createdAt: z.date(),
});

export async function userRoutes(app: App, ctx: AppContext): Promise<void> {
  app.get("/me", { preHandler: requireStaff() }, async (req) => {
    const p = staff(req);
    const user = await ctx.db.user.findUniqueOrThrow({ where: { id: p.userId }, include: { company: true } });
    return {
      user: { id: user.id, email: user.email, name: user.name, role: user.role, companyId: user.companyId },
      company: { id: user.company.id, name: user.company.name },
    };
  });

  app.get(
    "/users",
    {
      preHandler: requireStaff("admin"),
      schema: {
        querystring: listQuery(UserList),
        response: {
          200: z.object({
            users: z.array(UserOut),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
        },
      },
    },
    async (req) => {
      const q = searchTerm(req.query.q);
      const where: Prisma.UserWhereInput = {
        companyId: req.companyId,
        ...(req.query.role ? { role: req.query.role } : {}),
        ...(q ? { OR: [{ email: contains(q) }, { name: contains(q) }] } : {}),
      };
      const [users, total] = await tenantBatch(ctx.db, [
        ctx.db.user.findMany({
          where,
          orderBy: listOrder<Prisma.UserOrderByWithRelationInput, typeof req.query.sort>(UserList, req.query),
          take: req.query.limit,
          skip: req.query.offset,
        }),
        ctx.db.user.count({ where }),
      ]);
      return { users, total, limit: req.query.limit, offset: req.query.offset };
    },
  );

  app.post(
    "/users",
    {
      preHandler: requireStaff("admin"),
      schema: {
        body: z.object({ email: z.email(), name: z.string().optional(), role: z.enum(["admin", "member"]) }),
      },
    },
    async (req, reply) => {
      const user = await ctx.db.user.create({
        data: {
          companyId: req.companyId,
          email: req.body.email.toLowerCase(),
          name: req.body.name ?? null,
          role: req.body.role,
        },
      });
      await audit(ctx.db, {
        companyId: req.companyId,
        actorId: staff(req).userId,
        action: "user.create",
        targetType: "user",
        targetId: user.id,
        diff: { role: user.role },
      });
      return reply.status(201).send({ user });
    },
  );

  app.patch(
    "/users/:id",
    {
      preHandler: requireStaff("admin"),
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({ name: z.string().optional(), role: z.enum(["admin", "member"]).optional() }),
      },
    },
    async (req) => {
      const existing = await ctx.db.user.findFirst({
        where: { id: req.params.id, companyId: req.companyId },
      });
      if (!existing) throw notFound("User");
      const user = await ctx.db.user.update({ where: { id: existing.id }, data: defined(req.body) });
      await audit(ctx.db, {
        companyId: req.companyId,
        actorId: staff(req).userId,
        action: "user.update",
        targetType: "user",
        targetId: user.id,
        diff: req.body,
      });
      return { user };
    },
  );
}
