import { storageKind } from "@aidp/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { guard } from "../../auth/access.js";
import type { RouteContext } from "../../context.js";
import { noLimit } from "../../lib/rate-limit.js";

/**
 * Probes log at `warn`: the container health check calls /health/ready every 15 seconds, and at
 * `info` those two lines per call were more than half of everything an idle API wrote, burying the
 * requests anyone would read logs for. A failing probe still logs, because errors are above `warn`.
 */
const quiet = { logLevel: "warn" as const };

/** Public and never rate limited: a load balancer polls these constantly and must never see 429. */
export async function healthRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  app.get(
    "/health/live",
    {
      ...guard.public({ ...noLimit, ...quiet }),
      schema: { response: { 200: z.object({ ok: z.literal(true) }) } },
    },
    async () => ({ ok: true as const }),
  );
  /**
   * `storage` is reported because getting it wrong is silent and expensive. With no UPLOAD_DIR the
   * store falls back to memory, every upload works in testing, and every recording disappears on
   * the next deploy with nothing in the logs. A deployment can assert on this line.
   *
   * `speech` is the on-server Whisper model (D-75). It is reported and never gates readiness: the
   * first boot downloads it for a minute or two, and an API that is up without it still serves
   * every typed interview. `not_loaded` is also what a deployment routed to a cloud provider shows.
   * The reason for an `error` goes to the log, not here: this endpoint is public, and a failed
   * download's message carries hostnames and paths.
   */
  const Ready = z.object({
    ok: z.boolean(),
    database: z.boolean(),
    storage: z.enum(["filesystem", "memory", "other"]),
    speech: z.object({
      model: z.string().nullable(),
      state: z.enum(["not_loaded", "downloading", "ready", "error"]),
      progress: z.number().optional(),
      queued: z.number().int(),
    }),
  });
  const speech = (): z.infer<typeof Ready>["speech"] => {
    const { error: _error, ...status } = ctx.speech.status();
    return status;
  };
  app.get(
    "/health/ready",
    { ...guard.public({ ...noLimit, ...quiet }), schema: { response: { 200: Ready, 503: Ready } } },
    async (_req, reply) => {
      const probe = await ctx.services.health.checkDatabase();
      const database = probe.ok;
      if (!probe.ok) ctx.log.error({ err: probe.err }, "readiness: database unreachable");
      return reply
        .status(database ? 200 : 503)
        .send({ ok: database, database, storage: storageKind(ctx.storage), speech: speech() });
    },
  );
}
