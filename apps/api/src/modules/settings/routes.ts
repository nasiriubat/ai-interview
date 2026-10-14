import { SmtpFormSchema } from "@aidp/shared";
import { z } from "zod";
import type { App } from "../../app.js";
import { guard } from "../../auth/access.js";
import { staff } from "../../auth/plugin.js";
import type { RouteContext } from "../../context.js";
import {
  EmailTestBody,
  SettingsHistoryQuery,
  SettingsScopeQuery,
  TargetScopeQuery,
  type SettingsCaller,
} from "./service.js";

export async function settingsRoutes(app: App, ctx: RouteContext): Promise<void> {
  const settings = ctx.services.settingsAdmin;

  /** The caller as the service needs to see them; `companyId` is the tenant the request acts on. */
  const callerOf = (req: Parameters<typeof staff>[0] & { companyId: string }): SettingsCaller => {
    const p = staff(req);
    return {
      companyId: req.companyId,
      userId: p.userId,
      email: p.email,
      operator: p.role === "platform_operator",
    };
  };

  app.get("/settings", { ...guard.admin(), schema: { querystring: SettingsScopeQuery } }, async (req) =>
    settings.read(callerOf(req), req.query),
  );

  app.put(
    "/settings",
    {
      ...guard.admin(),
      schema: {
        querystring: SettingsScopeQuery,
        // `smtp` is the structured mail relay; it is composed into email.smtpUrl server side.
        body: z.object({ values: z.record(z.string(), z.unknown()), smtp: SmtpFormSchema.optional() }),
      },
    },
    async (req) => settings.write(callerOf(req), req.query, req.body.values, req.body.smtp),
  );

  /** Who changed which keys, when (D-182). Keys only: the audit log never holds a value. */
  app.get(
    "/settings/history",
    { ...guard.admin(), schema: { querystring: SettingsHistoryQuery } },
    async (req) => settings.history(callerOf(req), req.query),
  );

  /** Names for the scope pickers, so nobody types an id by hand (contract 19). */
  app.get("/settings/scopes", { ...guard.admin(), schema: { querystring: TargetScopeQuery } }, async (req) =>
    settings.targets(callerOf(req), req.query.scope),
  );

  /** Sends one message to the caller with the configuration in effect, and says which scope won. */
  app.post(
    "/settings/email/test",
    // Each call opens a connection to a host an admin typed, so it gets a short budget.
    { ...guard.admin({ config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }) },
    async (req) => {
      // The body is optional, so it is parsed here rather than by the route schema.
      const body = EmailTestBody.parse(req.body ?? {});
      return settings.emailTest(callerOf(req), body);
    },
  );
}
