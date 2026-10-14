import { listEnvelope } from "@aidp/shared";
import { z } from "zod";
import type { App } from "../../app.js";
import { guard } from "../../auth/access.js";
import { staff } from "../../auth/plugin.js";
import type { RouteContext } from "../../context.js";
import { UserListQuery } from "./service.js";

const UserOut = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  role: z.string(),
  companyId: z.string(),
  createdAt: z.date(),
  disabledAt: z.date().nullable(),
});

export async function userRoutes(app: App, ctx: RouteContext): Promise<void> {
  const users = ctx.services.users;

  // A suspended tenant's staff still get an answer here, so the UI can say why they are locked out.
  app.get("/me", { ...guard.staff({ config: { allowSuspended: true } }) }, async (req) => {
    const p = staff(req);
    return users.me(p.companyId, p.userId);
  });

  app.get(
    "/users",
    {
      ...guard.admin(),
      schema: {
        querystring: UserListQuery,
        response: { 200: listEnvelope("users", UserOut) },
      },
    },
    async (req) => users.list(req.companyId, req.query),
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
      const user = await users.create(req.companyId, staff(req).userId, req.body);
      return reply.status(201).send({ user });
    },
  );

  app.patch(
    "/users/:id",
    {
      ...guard.admin(),
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({
          name: z.string().optional(),
          role: z.enum(["admin", "member"]).optional(),
          disabled: z.boolean().optional(),
        }),
      },
    },
    async (req) => ({ user: await users.update(req.companyId, staff(req).userId, req.params.id, req.body) }),
  );

  app.delete(
    "/users/:id",
    { ...guard.admin(), schema: { params: z.object({ id: z.string() }) } },
    async (req) => {
      await users.remove(req.companyId, staff(req).userId, req.params.id);
      return { ok: true as const };
    },
  );
}
