import { JOBS, RUN_NOW_JOBS, deadLetterKey, type JobName } from "@aidp/core";
import { withSystemTenant } from "@aidp/db";
import { z } from "zod";
import type { App } from "../../app.js";
import { guard } from "../../auth/access.js";
import { staff } from "../../auth/plugin.js";
import type { AppContext } from "../../context.js";
import { audit } from "../../lib/audit.js";
import { AppError, notFound } from "../../lib/errors.js";

const JOB_NAMES = Object.keys(JOBS) as [JobName, ...JobName[]];
const QueueName = z.enum(JOB_NAMES);
const RunNowName = z.enum(RUN_NOW_JOBS as [JobName, ...JobName[]]);

/**
 * Job administration for the platform operator (D-92): what is queued, what is dead-lettered, and
 * the three verbs that make a dead letter a thing someone can act on from a browser instead of a
 * `psql` session. Every verb is audited, on the job's tenant when it has one.
 */
export async function operatorJobRoutes(app: App, ctx: AppContext): Promise<void> {
  const op = guard.operator();

  /** The tenant a job belonged to, if that tenant still exists; otherwise the operator's own company. */
  const auditCompany = async (jobCompanyId: string | null, fallback: string): Promise<string> => {
    if (!jobCompanyId) return fallback;
    const found = await withSystemTenant(async () => {
      return await ctx.db.company.findUnique({ where: { id: jobCompanyId }, select: { id: true } });
    });
    return found?.id ?? fallback;
  };

  app.get("/operator/jobs", op, async () => ({ queues: await ctx.jobAdmin.list() }));

  app.get(
    "/operator/jobs/dead",
    {
      ...op,
      schema: {
        querystring: z.object({
          queue: QueueName,
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
      },
    },
    async (req) => ({
      queue: req.query.queue,
      jobs: await ctx.jobAdmin.deadLetters(req.query.queue, req.query.limit),
    }),
  );

  app.post(
    "/operator/jobs/dead/:queue/:id/retry",
    { ...op, schema: { params: z.object({ queue: QueueName, id: z.string().min(1).max(64) }) } },
    async (req) => {
      const result = await ctx.jobAdmin.retry(req.params.queue, req.params.id);
      if (!result) throw notFound("Dead-lettered job");
      if (result.queuedAs === null)
        throw new AppError(
          "conflict",
          "The job could not be queued again, most likely because an identical job is already waiting. It was left in the dead-letter queue.",
        );
      await ctx.alerts.resolve(deadLetterKey(req.params.queue, result.job.sourceId ?? result.job.id));
      await audit(ctx.db, {
        companyId: await auditCompany(result.job.companyId, req.companyId),
        actorId: staff(req).userId,
        action: "job.retry",
        targetType: "job",
        targetId: result.job.id,
        diff: { queue: req.params.queue, queuedAs: result.queuedAs },
      });
      return { ok: true as const, queuedAs: result.queuedAs };
    },
  );

  app.post(
    "/operator/jobs/dead/:queue/:id/discard",
    { ...op, schema: { params: z.object({ queue: QueueName, id: z.string().min(1).max(64) }) } },
    async (req) => {
      const result = await ctx.jobAdmin.discard(req.params.queue, req.params.id);
      if (!result) throw notFound("Dead-lettered job");
      await ctx.alerts.resolve(deadLetterKey(req.params.queue, result.job.sourceId ?? result.job.id));
      await audit(ctx.db, {
        companyId: await auditCompany(result.job.companyId, req.companyId),
        actorId: staff(req).userId,
        action: "job.discard",
        targetType: "job",
        targetId: result.job.id,
        diff: { queue: req.params.queue },
      });
      return { ok: true as const };
    },
  );

  app.post(
    "/operator/jobs/run/:name",
    { ...op, schema: { params: z.object({ name: RunNowName }) } },
    async (req) => {
      // The payload is empty by construction: only parameterless recurring jobs are runnable here.
      await ctx.jobs.publish(req.params.name, {});
      await audit(ctx.db, {
        companyId: req.companyId,
        actorId: staff(req).userId,
        action: "job.run_now",
        targetType: "job",
        targetId: req.params.name,
      });
      return { ok: true as const, queued: req.params.name };
    },
  );
}
