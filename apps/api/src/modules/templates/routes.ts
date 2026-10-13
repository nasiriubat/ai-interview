import { InterviewTemplateSchema, PathSchema } from "@aidp/shared";
import { z } from "zod";
import type { App } from "../../app.js";
import { guard } from "../../auth/access.js";
import { staff } from "../../auth/plugin.js";
import type { AppContext } from "../../context.js";
import { audit } from "../../lib/audit.js";
import { expensiveLimit } from "../../lib/rate-limit.js";
import { fromRow, TemplateService } from "./service.js";

const Id = z.object({ id: z.string() });
const TemplateBody = InterviewTemplateSchema.omit({ version: true });

export async function templateRoutes(app: App, ctx: AppContext): Promise<void> {
  const svc = new TemplateService(ctx.db);
  /** Flat record: the template fields plus id, owner, status and timestamps (contract 16). */
  const view = (t: Awaited<ReturnType<TemplateService["get"]>>) => ({
    ...fromRow(t),
    id: t.id,
    companyId: t.companyId,
    status: t.status,
    createdAt: t.createdAt,
    updatedAt: t.createdAt,
  });

  app.get("/templates", { ...guard.staff() }, async (req) => ({
    templates: (await svc.list(req.companyId)).map(view),
  }));
  app.get("/templates/:id", { ...guard.staff(), schema: { params: Id } }, async (req) =>
    view(await svc.get(req.companyId, req.params.id)),
  );

  app.post(
    "/templates",
    {
      ...guard.admin(),
      schema: { body: z.union([z.object({ copyFromId: z.string() }), TemplateBody]) },
    },
    async (req, reply) => {
      const actor = staff(req).userId;
      const t =
        "copyFromId" in req.body
          ? await svc.copy(req.companyId, req.body.copyFromId, actor)
          : await svc.create(req.companyId, req.body, actor);
      await audit(ctx.db, {
        companyId: req.companyId,
        actorId: actor,
        action: "template.create",
        targetType: "template",
        targetId: t.id,
        diff: { key: t.key },
      });
      return reply.status(201).send(view(t));
    },
  );

  app.put("/templates/:id", { ...guard.admin(), schema: { params: Id, body: TemplateBody } }, async (req) => {
    const actor = staff(req).userId;
    const t = await svc.update(req.companyId, req.params.id, req.body, actor);
    await audit(ctx.db, {
      companyId: req.companyId,
      actorId: actor,
      action: "template.update",
      targetType: "template",
      targetId: t.id,
      diff: { version: t.version },
    });
    return view(t);
  });

  for (const status of ["published", "archived"] as const) {
    app.post(
      `/templates/:id/${status === "published" ? "publish" : "archive"}`,
      { ...guard.admin(), schema: { params: Id } },
      async (req) => {
        const t = await svc.setStatus(req.companyId, req.params.id, status);
        await audit(ctx.db, {
          companyId: req.companyId,
          actorId: staff(req).userId,
          action: `template.${status}`,
          targetType: "template",
          targetId: t.id,
        });
        return view(t);
      },
    );
  }

  /** A throwaway session on the template, opened as a participant by the calling admin (contract 18). */
  app.post(
    "/templates/:id/preview",
    {
      ...guard.admin(expensiveLimit(ctx.config)),
      schema: { params: Id, body: z.object({ path: PathSchema.optional() }).default({}) },
    },
    async (req) => {
      const actor = staff(req).userId;
      await svc.get(req.companyId, req.params.id);
      const preview = await ctx.requirements.preview(req.companyId, req.params.id, actor, req.body.path);
      await audit(ctx.db, {
        companyId: req.companyId,
        actorId: actor,
        action: "template.preview",
        targetType: "template",
        targetId: req.params.id,
        diff: { sessionId: preview.sessionId },
      });
      return preview;
    },
  );

  app.get("/templates/:id/diff-shipped", { ...guard.staff(), schema: { params: Id } }, async (req) =>
    svc.diffShipped(req.companyId, req.params.id),
  );
}
