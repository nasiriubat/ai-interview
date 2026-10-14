import { MAX_PROMPT_CHARS } from "@aidp/ai";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import type { App } from "../../app.js";
import { guard } from "../../auth/access.js";
import { staff } from "../../auth/plugin.js";
import type { RouteContext } from "../../context.js";
import { STATS_WINDOW_DAYS } from "./service.js";

const Key = z.object({ key: z.string().min(1).max(60) });
const KeyVersion = Key.extend({ v: z.coerce.number().int().min(1) });
const Body = z.object({
  body: z
    .string()
    .min(1)
    .max(MAX_PROMPT_CHARS + 1000),
});
const NewVersion = Body.extend({
  note: z.string().trim().max(500).optional(),
  parentVersion: z.number().int().min(1).optional(),
});
const Activate = z.object({ canaryShare: z.number().gt(0).max(1) });
const DiffQuery = z.object({
  from: z.string().min(1).max(12).default("shipped"),
  to: z.string().min(1).max(12),
});

/**
 * Prompt administration (blueprint feature 5, D-230 to D-235). Admin only: a prompt decides what
 * the model is told about every participant. Audit rows carry keys, versions and shares, never
 * the prompt bodies.
 */
export async function promptRoutes(app: App, ctx: RouteContext): Promise<void> {
  const svc = ctx.services.prompts;
  const record = (req: FastifyRequest, action: string, key: string, diff: Record<string, unknown>) =>
    ctx.services.audit.record(req.companyId, {
      actorId: staff(req).userId,
      action,
      targetType: "prompt",
      targetId: key,
      diff,
    });

  app.get("/prompts", { ...guard.admin() }, async (req) => ({
    prompts: await svc.list(req.companyId),
    windowDays: STATS_WINDOW_DAYS,
  }));

  app.get("/prompts/:key", { ...guard.admin(), schema: { params: Key } }, async (req) =>
    svc.get(req.companyId, req.params.key),
  );

  app.get(
    "/prompts/:key/diff",
    { ...guard.admin(), schema: { params: Key, querystring: DiffQuery } },
    async (req) => svc.diff(req.companyId, req.params.key, req.query.from, req.query.to),
  );

  /** Validates and renders a body without storing it, for the editor's live checker. */
  app.post("/prompts/:key/check", { ...guard.admin(), schema: { params: Key, body: Body } }, async (req) =>
    svc.check(req.params.key, req.body.body),
  );

  app.post(
    "/prompts/:key/versions",
    { ...guard.admin(), schema: { params: Key, body: NewVersion } },
    async (req, reply) => {
      const v = await svc.create(req.companyId, req.params.key, req.body, staff(req).userId);
      await record(req, "prompt.create", req.params.key, {
        version: v.version,
        parentVersion: v.parentVersion,
        chars: req.body.body.length,
      });
      return reply.status(201).send(v);
    },
  );

  app.post(
    "/prompts/:key/versions/:v/activate",
    { ...guard.admin(), schema: { params: KeyVersion, body: Activate } },
    async (req) => {
      const out = await svc.activate(req.companyId, req.params.key, req.params.v, req.body.canaryShare);
      await record(req, out.share >= 1 ? "prompt.activate" : "prompt.canary", req.params.key, {
        version: out.version.version,
        share: out.share,
        replaced: out.replaced,
      });
      return out;
    },
  );

  app.delete("/prompts/:key/canary", { ...guard.admin(), schema: { params: Key } }, async (req) => {
    const out = await svc.stopCanary(req.companyId, req.params.key);
    await record(req, "prompt.canary_stop", req.params.key, out);
    return out;
  });

  app.post("/prompts/:key/rollback", { ...guard.admin(), schema: { params: Key } }, async (req) => {
    const out = await svc.rollback(req.companyId, req.params.key);
    await record(req, "prompt.rollback", req.params.key, out);
    return out;
  });

  app.post("/prompts/:key/reset", { ...guard.admin(), schema: { params: Key } }, async (req) => {
    const out = await svc.reset(req.companyId, req.params.key);
    await record(req, "prompt.reset", req.params.key, out);
    return out;
  });
}
