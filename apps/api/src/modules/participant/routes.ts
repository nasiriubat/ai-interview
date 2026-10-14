import { InviteNotOpenError, RequirementsNotFoundError } from "@aidp/core";
import { ModeSwitchReasonSchema } from "@aidp/shared";
import { z } from "zod";
import type { App } from "../../app.js";
import { guard } from "../../auth/access.js";
import { participant } from "../../auth/plugin.js";
import type { RouteContext } from "../../context.js";
import { AppError, notFound } from "../../lib/errors.js";
import { addressBucket } from "../../lib/rate-limit.js";
import { answerFromBody, parseTurnBody } from "../sessions/turn-body.js";
import { runTurn } from "../sessions/turn-runner.js";

const Link = z.object({ linkToken: z.string().min(8) });

export async function participantRoutes(app: App, ctx: RouteContext): Promise<void> {
  const svc = ctx.services.participant;
  // Per client address (RATE_LIMIT_PUBLIC_MAX, 120, D-310). What a link may cost is bounded by the
  // campaign and tenant caps (D-261), not by this bucket.
  const publicLimit = guard.public({
    config: { rateLimit: { max: ctx.config.RATE_LIMIT_PUBLIC_MAX, timeWindow: "1 minute" } },
  });

  app.get("/p/:linkToken", { ...publicLimit, schema: { params: Link } }, async (req) => {
    const { view } = await svc.resolveLink(req.params.linkToken);
    const campaign = {
      name: view.name,
      productName: view.productName,
      welcome: view.welcome,
      expectedMinutes: view.expectedMinutes,
      participationMode: view.participationMode,
      verification: view.verification,
      consentText: view.consentText,
      consentVersion: view.consentVersion,
      participantFields: view.participantFields,
      pathSelection: view.pathSelection,
    };
    return { campaign, status: view.status };
  });

  app.post(
    "/p/:linkToken/verify/request",
    {
      ...guard.public({ config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } }),
      schema: { params: Link, body: z.object({ email: z.email() }) },
    },
    async (req) => {
      await svc.requestCode(req.params.linkToken, req.body.email, addressBucket(req.ip));
      return { ok: true as const };
    },
  );

  app.post(
    "/p/:linkToken/verify/confirm",
    {
      ...guard.public({ config: { rateLimit: { max: 10, timeWindow: "10 minutes" } } }),
      schema: { params: Link, body: z.object({ email: z.email(), code: z.string().regex(/^\d{6}$/) }) },
    },
    async (req) => svc.confirmCode(req.params.linkToken, req.body.email, req.body.code),
  );

  app.post(
    "/p/:linkToken/open",
    {
      ...publicLimit,
      schema: { params: Link, body: z.object({ invitationToken: z.string().optional() }).default({}) },
    },
    async (req) => svc.open(req.params.linkToken, req.body.invitationToken),
  );

  // External invitations into a requirements session (contract 18). The token is the participant token.
  const InviteToken = z.object({ token: z.string().min(8) });
  const inviteErrors = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      const value = await fn();
      return value;
    } catch (e) {
      if (e instanceof RequirementsNotFoundError) throw notFound("Invitation");
      if (e instanceof InviteNotOpenError) throw new AppError("forbidden", e.message);
      throw e;
    }
  };
  app.get("/p/r/:token", { ...publicLimit, schema: { params: InviteToken } }, async (req) => {
    const view = await inviteErrors(() => ctx.requirements.resolveInvite(req.params.token));
    return { session: view.session, status: view.status };
  });
  app.post("/p/r/:token/open", { ...publicLimit, schema: { params: InviteToken } }, async (req) =>
    inviteErrors(() => ctx.requirements.openInvite(req.params.token)),
  );

  const authed = guard.participant();

  app.get("/p/session", authed, async (req) => {
    const p = participant(req);
    return ctx.services.participantSession.view(p.companyId, p.sessionId);
  });

  app.post(
    "/p/session/consent",
    {
      ...authed,
      schema: {
        body: z.object({
          consentVersion: z.string().min(1),
          participantFields: z.record(z.string(), z.string()).optional(),
          participationChoice: z.enum(["identified", "anonymous"]).optional(),
        }),
      },
    },
    async (req) => {
      await svc.consent(participant(req).sessionId, req.body);
      return { ok: true as const };
    },
  );

  app.post(
    "/p/session/path",
    { ...authed, schema: { body: z.object({ path: z.enum(["technical", "nontechnical"]) }) } },
    async (req) => {
      await svc.setPath(participant(req).sessionId, req.body.path);
      return { ok: true as const };
    },
  );

  app.post(
    "/p/session/mode",
    {
      ...authed,
      schema: {
        body: z.object({
          mode: z.enum(["chat", "options", "voice"]),
          reason: ModeSwitchReasonSchema.default("participant"),
        }),
      },
    },
    async (req) => {
      await svc.setMode(participant(req).sessionId, req.body.mode, req.body.reason);
      return { ok: true as const };
    },
  );

  app.post(
    "/p/session/turns",
    {
      ...guard.participant({ config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }),
    },
    async (req, reply) => {
      const p = participant(req);
      // The first turn has no body at all, so the body is validated here rather than by the route schema.
      const body = parseTurnBody(req.body);
      await runTurn(ctx, p.sessionId, answerFromBody(body), reply);
    },
  );

  app.post("/p/session/pause", authed, async (req) => {
    await svc.pause(participant(req).sessionId);
    return { ok: true as const };
  });

  // Deprecated: "I'm done" is a `finish` control on the turn request now. Kept for one release so a
  // client installed before that keeps working.
  app.post("/p/session/complete", authed, async (req, reply) => {
    reply.header("Deprecation", "true");
    await svc.requestCompletion(participant(req).sessionId);
    return { ok: true as const };
  });

  app.delete("/p/session", authed, async (req) => {
    const p = participant(req);
    const notice = await svc.deleteData(p.sessionId);
    await ctx.jobs.publish("privacy.delete-session", { sessionId: p.sessionId, companyId: p.companyId });
    // After the erase has finished, and never a reason to fail it: a participant whose data is gone
    // must not be told it failed because a mail could not be queued. `emailSent` is what the
    // screen's wording rests on, so it is true only when the confirmation really is queued.
    let emailSent = false;
    if (notice) {
      try {
        await ctx.jobs.publish("privacy.confirm-deletion", notice, {
          singletonKey: `deletion-notice:${p.sessionId}`,
        });
        emailSent = true;
      } catch (err) {
        ctx.log.warn({ err, sessionId: p.sessionId }, "could not queue the deletion confirmation");
      }
    }
    return { ok: true as const, emailSent };
  });

  app.get("/p/session/summary", authed, async (req) => svc.summary(participant(req).sessionId));

  app.put(
    "/p/session/summary",
    { ...authed, schema: { body: z.object({ summary: z.string().max(5000) }) } },
    async (req) => {
      await svc.setSummary(participant(req).sessionId, req.body.summary);
      return { ok: true as const };
    },
  );
}
