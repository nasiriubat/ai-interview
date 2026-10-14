import type { App } from "../../app.js";
import { guard } from "../../auth/access.js";
import { staff } from "../../auth/plugin.js";
import type { RouteContext } from "../../context.js";

/**
 * The getting-started checklist (D-189). Derived from what the tenant has, so nothing needs
 * migrating and it cannot drift. Only the dismissal is stored, as the tenant setting
 * `ui.onboardingDismissed`.
 */
export async function onboardingRoutes(app: App, ctx: RouteContext): Promise<void> {
  const onboarding = ctx.services.onboarding;

  app.get("/onboarding", { ...guard.admin() }, async (req) => onboarding.state(req.companyId));

  app.post("/onboarding/dismiss", { ...guard.admin() }, async (req) => {
    const actor = staff(req).userId;
    await onboarding.dismiss(req.companyId, actor);
    await ctx.services.audit.record(req.companyId, {
      actorId: actor,
      action: "onboarding.dismiss",
      targetType: "company",
      targetId: req.companyId,
    });
    return onboarding.state(req.companyId);
  });
}
