import { InviteNotOpenError, RequirementsNotFoundError, toStored } from "@aidp/core";
import { WidgetResponseSchema } from "@aidp/shared";
import { z } from "zod";
import type { App } from "../../app.js";
import { participant, requireParticipant } from "../../auth/plugin.js";
import type { AppContext } from "../../context.js";
import { AppError, notFound } from "../../lib/errors.js";
import { runTurn } from "../sessions/turn-runner.js";
import { ParticipantService } from "./service.js";

const Link = z.object({ linkToken: z.string().min(8) });
const publicLimit = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };
const TurnBody = z.object({
  content: z.string().max(8000).default(""),
  modality: z.enum(["text", "widget", "voice"]).default("text"),
  widgetResponse: WidgetResponseSchema.optional(),
});

export async function participantRoutes(app: App, ctx: AppContext): Promise<void> {
  const svc = new ParticipantService(ctx.db, ctx.crypto, ctx.settings, ctx.email);

  app.get("/p/:linkToken", { ...publicLimit, schema: { params: Link } }, async (req) => {
    const { view } = await svc.resolveLink(req.params.linkToken);
    const campaign = {
      name: view.name,
      productName: view.productName,
      purpose: view.purpose,
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
      config: { rateLimit: { max: 5, timeWindow: "10 minutes" } },
      schema: { params: Link, body: z.object({ email: z.email() }) },
    },
    async (req) => {
      await svc.requestCode(req.params.linkToken, req.body.email);
      return { ok: true as const };
    },
  );

  app.post(
    "/p/:linkToken/verify/confirm",
    {
      config: { rateLimit: { max: 10, timeWindow: "10 minutes" } },
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

  const authed = { preHandler: requireParticipant };

  app.get("/p/session", authed, async (req) => {
    const p = participant(req);
    const session = await ctx.db.session.findUniqueOrThrow({
      where: { id: p.sessionId },
      include: { participant: true, template: true },
    });
    const messages =
      session.status === "deleted"
        ? []
        : await ctx.db.message.findMany({ where: { sessionId: session.id }, orderBy: { seq: "asc" } });
    const state = session.state as { coverage?: Record<string, { status: string }> };
    const areas = (session.template.coverageAreas as { key: string; name: string }[]).map((a) => ({
      key: a.key,
      name: a.name,
      status: state.coverage?.[a.key]?.status ?? "untouched",
    }));
    return {
      session: {
        ...svc.sessionView(session, session.participant),
        progress: { areas },
        messages: messages.map(toStored),
      },
    };
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
    { ...authed, schema: { body: z.object({ mode: z.enum(["chat", "options", "voice"]) }) } },
    async (req) => {
      await svc.setMode(participant(req).sessionId, req.body.mode);
      return { ok: true as const };
    },
  );

  app.post(
    "/p/session/turns",
    {
      ...authed,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const p = participant(req);
      // The first turn has no body at all, so the body is validated here rather than by the route schema.
      const body = TurnBody.parse(req.body ?? {});
      const answer =
        body.content.trim() || body.widgetResponse
          ? {
              content: body.content,
              modality: body.modality,
              ...(body.widgetResponse ? { widgetResponse: body.widgetResponse } : {}),
            }
          : undefined;
      await runTurn(ctx, p.sessionId, answer, reply);
    },
  );

  app.post("/p/session/pause", authed, async (req) => {
    await svc.pause(participant(req).sessionId);
    return { ok: true as const };
  });

  app.post("/p/session/complete", authed, async (req) => {
    await svc.requestCompletion(participant(req).sessionId);
    return { ok: true as const };
  });

  app.delete("/p/session", authed, async (req) => {
    const p = participant(req);
    await svc.deleteData(p.sessionId);
    await ctx.jobs.publish("privacy.delete-session", { sessionId: p.sessionId, companyId: p.companyId });
    return { ok: true as const };
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
