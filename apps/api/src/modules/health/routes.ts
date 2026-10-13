import { storageKind } from "@aidp/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { guard } from "../../auth/access.js";
import type { AppContext } from "../../context.js";
import { noLimit } from "../../lib/rate-limit.js";

/** Public and never rate limited: a load balancer polls these constantly and must never see 429. */
export async function healthRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get(
    "/health/live",
    { ...guard.public(noLimit), schema: { response: { 200: z.object({ ok: z.literal(true) }) } } },
    async () => ({ ok: true as const }),
  );
  /**
   * `storage` is reported because getting it wrong is silent and expensive. With no UPLOAD_DIR the
   * store falls back to memory, every upload works in testing, and every recording disappears on
   * the next deploy with nothing in the logs. A deployment can assert on this line.
   */
  const Ready = z.object({
    ok: z.boolean(),
    database: z.boolean(),
    storage: z.enum(["filesystem", "memory", "other"]),
  });
  app.get(
    "/health/ready",
    { ...guard.public(noLimit), schema: { response: { 200: Ready, 503: Ready } } },
    async (_req, reply) => {
      let database = false;
      try {
        await ctx.db.$queryRaw`SELECT 1`;
        database = true;
      } catch (err) {
        ctx.log.error({ err }, "readiness: database unreachable");
      }
      return reply
        .status(database ? 200 : 503)
        .send({ ok: database, database, storage: storageKind(ctx.storage) });
    },
  );
}
