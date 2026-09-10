import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../context.js";

export async function healthRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get("/health/live", { schema: { response: { 200: z.object({ ok: z.literal(true) }) } } }, async () => ({
    ok: true as const,
  }));
  const Ready = z.object({ ok: z.boolean(), database: z.boolean() });
  app.get("/health/ready", { schema: { response: { 200: Ready, 503: Ready } } }, async (_req, reply) => {
    let database = false;
    try {
      await ctx.db.$queryRaw`SELECT 1`;
      database = true;
    } catch (err) {
      ctx.log.error({ err }, "readiness: database unreachable");
    }
    return reply.status(database ? 200 : 503).send({ ok: database, database });
  });
}
