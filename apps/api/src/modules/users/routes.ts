import { tenantBatch } from "@aidp/db";
import { z } from "zod";
import type { App } from "../../app.js";
import { guard } from "../../auth/access.js";
import { staff } from "../../auth/plugin.js";
import type { AppContext } from "../../context.js";
import { audit } from "../../lib/audit.js";
import { emailTaken, isUniqueViolation, notFound } from "../../lib/errors.js";
import { defined } from "../../lib/objects.js";
import { PageQuery } from "../../lib/pagination.js";

const UserOut = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  role: z.string(),
  companyId: z.string(),
  createdAt: z.date(),
});

export async function userRoutes(app: App, ctx: AppContext): Promise<void> {
  // A suspended tenant's staff still get an answer here, so the UI can say why they are locked out.
  app.get("/me", { ...guard.staff({ config: { allowSuspended: true } }) }, async (req) => {
    const p = staff(req);
    const user = await ctx.db.user.findUniqueOrThrow({ where: { id: p.userId }, include: { company: true } });
    return {
      user: { id: user.id, email: user.email, name: user.name, role: user.role, companyId: user.companyId },
      company: { id: user.company.id, name: user.company.name, status: user.company.status },
    };
  });

  app.get(
    "/users",
    {
      ...guard.admin(),
      schema: {
        querystring: PageQuery,
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
      const where = { companyId: req.companyId };
      const [users, total] = await tenantBatch(ctx.db, [
        ctx.db.user.findMany({
          where,
          orderBy: { createdAt: "asc" },
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
      // 20 an hour per admin: a refused address reveals that it is registered somewhere (D-84).
      ...guard.admin({ config: { rateLimit: { max: 20, timeWindow: "1 hour" } } }),
      schema: {
        body: z.object({ email: z.email(), name: z.string().optional(), role: z.enum(["admin", "member"]) }),
      },
    },
    async (req, reply) => {
      let user;
      try {
        user = await ctx.db.user.create({
          data: {
            companyId: req.companyId,
            email: req.body.email.toLowerCase(),
            name: req.body.name ?? null,
            role: req.body.role,
          },
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // Audited without the address: it belongs to someone in another tenant.
        await audit(ctx.db, {
          companyId: req.companyId,
          actorId: staff(req).userId,
          action: "user.create_refused",
          targetType: "user",
          targetId: "",
          diff: { reason: "email_taken" },
        });
        throw emailTaken();
      }
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
      ...guard.admin(),
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
