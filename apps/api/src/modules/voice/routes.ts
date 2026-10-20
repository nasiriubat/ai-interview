import { z } from "zod";
import type { App } from "../../app.js";
import { guard } from "../../auth/access.js";
import { staff } from "../../auth/plugin.js";
import type { RouteContext } from "../../context.js";
import { forbidden } from "../../lib/errors.js";
import { expensiveLimit } from "../../lib/rate-limit.js";

/** An OpenAI key is a few hundred characters at most; the bound only stops garbage. */
const OpenAIKeyBody = z.object({ apiKey: z.string().trim().min(20).max(512) });
const LiveBody = z.object({ enabled: z.boolean() });

/**
 * Live voice setup for a tenant admin (FR-30a, D-77; contract 19, "Live voice").
 *
 * Always the caller's own tenant: `req.companyId` is the admin's company, or the tenant a platform
 * operator named with `X-Company-Id`. No route takes a tenant id from the body or the path.
 */
export async function voiceAdminRoutes(app: App, ctx: RouteContext): Promise<void> {
  const voice = ctx.services.voiceSetup;

  app.get("/admin/voice/readiness", { ...guard.admin() }, async (req) => voice.readiness(req.companyId));

  app.post(
    "/admin/voice/openai",
    { ...guard.admin(expensiveLimit(ctx.config)), schema: { body: OpenAIKeyBody } },
    async (req) => {
      const result = await voice.connectOpenAI(req.companyId, req.body.apiKey);
      // What changed, never the key: the provider service already encrypted it.
      await ctx.services.audit.record(req.companyId, {
        actorId: staff(req).userId,
        action: "voice.openai_connect",
        targetType: "provider",
        targetId: result.providerId,
        diff: { providerCreated: result.providerCreated, routed: result.routed, apiKey: "(set)" },
      });
      return result.readiness;
    },
  );

  app.put("/admin/voice/live", { ...guard.admin(), schema: { body: LiveBody } }, async (req) => {
    // `features.realtimeVoice` is operator-only (D-476): the same rule the settings write applies.
    if (staff(req).role !== "platform_operator")
      throw forbidden("Only the platform operator can turn live voice on or off");
    const actor = staff(req).userId;
    const readiness = await voice.setLive(req.companyId, req.body.enabled, actor);
    await ctx.services.audit.record(req.companyId, {
      actorId: actor,
      action: "voice.live_toggle",
      targetType: "settings:tenant",
      targetId: req.companyId,
      diff: { "features.realtimeVoice": req.body.enabled },
    });
    return readiness;
  });
}
