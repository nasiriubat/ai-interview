import { z } from "zod";
import type { App } from "../../app.js";
import { guard } from "../../auth/access.js";
import type { RouteContext } from "../../context.js";

const RetentionStatus = z.object({
  retentionMonths: z.number().int(),
  oldestSessionAt: z.string().nullable(),
  expiredSessions: z.number().int(),
  lastSweepAt: z.string().nullable(),
});

/**
 * Privacy posture an admin can check without reading the code (spec 11). The consent text promises
 * the data does not live forever; this says what the window is, how far back the tenant's data goes,
 * how much of it is currently past the window (zero between nightly sweeps) and when the last sweep
 * that removed anything ran.
 */
export async function privacyRoutes(app: App, ctx: RouteContext): Promise<void> {
  app.get(
    "/privacy/retention",
    { ...guard.admin(), schema: { response: { 200: RetentionStatus } } },
    async (req) => ctx.services.privacy.retention(req.companyId),
  );
}
