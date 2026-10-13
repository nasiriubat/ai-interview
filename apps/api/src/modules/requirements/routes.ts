import {
  GitHubError,
  GitHubNotConfiguredError,
  InvalidSectionError,
  PathRequiredError,
  RequirementsForbiddenError,
  RequirementsNotFoundError,
  SessionNotOpenError,
  SpecVersionInProgressError,
  SpecVersionNotReadyError,
  type Viewer,
} from "@aidp/core";
import { FindingOutcomeSchema, PathSchema, WidgetResponseSchema } from "@aidp/shared";
import { z } from "zod";
import type { App } from "../../app.js";
import { guard } from "../../auth/access.js";
import { staff } from "../../auth/plugin.js";
import type { RouteContext } from "../../context.js";
import { AppError, forbidden, notFound } from "../../lib/errors.js";
import { expensiveLimit } from "../../lib/rate-limit.js";
import { runTurn } from "../sessions/turn-runner.js";
import { RequirementsListQuery, requirementsListArgs } from "./service.js";

const Id = z.object({ id: z.string() });

const VersionParams = z.object({ id: z.string(), v: z.coerce.number().int().positive() });
const TurnBody = z.object({
  content: z.string().max(8000).default(""),
  modality: z.enum(["text", "widget", "voice"]).default("text"),
  widgetResponse: WidgetResponseSchema.optional(),
});

/** Requirements sessions, versions and exports, external invitations (contract 18). */
export async function requirementsRoutes(app: App, ctx: RouteContext): Promise<void> {
  const svc = ctx.requirements;
  const viewerOf = (req: Parameters<typeof staff>[0]): Viewer => {
    const p = staff(req);
    return { userId: p.userId, role: p.role };
  };

  /** Service errors to API errors. */
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      const value = await fn();
      return value;
    } catch (e) {
      if (e instanceof RequirementsNotFoundError) throw notFound(e.what);
      if (e instanceof RequirementsForbiddenError) throw forbidden(e.message);
      if (e instanceof SpecVersionInProgressError)
        throw new AppError("conflict", e.message, { versionId: e.versionId });
      if (e instanceof SpecVersionNotReadyError) throw new AppError("conflict", e.message);
      if (e instanceof PathRequiredError) throw new AppError("conflict", e.message);
      if (e instanceof SessionNotOpenError) throw new AppError("conflict", e.message);
      if (e instanceof InvalidSectionError) throw new AppError("validation", e.message);
      if (e instanceof GitHubNotConfiguredError) throw new AppError("conflict", e.message);
      if (e instanceof GitHubError)
        throw new AppError(e.status === 401 || e.status === 403 ? "forbidden" : "provider_error", e.message);
      throw e;
    }
  };

  // ---------- Sessions ----------

  app.get(
    "/requirements",
    { ...guard.staff(), schema: { querystring: RequirementsListQuery } },
    async (req) => {
      const { sessions, total } = await svc.list(
        req.companyId,
        viewerOf(req),
        requirementsListArgs(req.query),
      );
      return { sessions, total, limit: req.query.limit, offset: req.query.offset };
    },
  );

  app.post(
    "/requirements",
    {
      ...guard.staff(),
      schema: {
        body: z.object({
          title: z.string().min(1).max(120),
          prompt: z.string().max(20000).optional(),
          path: PathSchema.optional(),
          templateId: z.string().optional(),
          language: z.string().min(2).max(5).optional(),
        }),
      },
    },
    async (req, reply) => {
      const p = staff(req);
      const session = await wrap(() => svc.create(req.companyId, p.userId, req.body));
      await ctx.services.audit.record(req.companyId, {
        actorId: p.userId,
        action: "requirements.create",
        targetType: "session",
        targetId: session.id,
        diff: { title: session.title, path: session.path, templateId: session.templateId },
      });
      return reply.status(201).send({ session });
    },
  );

  app.get("/requirements/:id", { ...guard.staff(), schema: { params: Id } }, async (req) =>
    wrap(() => svc.get(req.companyId, req.params.id, viewerOf(req))),
  );

  app.post(
    "/requirements/:id/path",
    { ...guard.staff(), schema: { params: Id, body: z.object({ path: PathSchema }) } },
    async (req) => {
      await wrap(() => svc.setPath(req.companyId, req.params.id, req.body.path, viewerOf(req)));
      return { ok: true as const };
    },
  );

  app.post(
    "/requirements/:id/turns",
    {
      ...guard.staff(expensiveLimit(ctx.config)),
      schema: { params: Id },
    },
    async (req, reply) => {
      await wrap(() => svc.assertTurnAllowed(req.companyId, req.params.id, viewerOf(req)));
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
      const companyId = req.companyId;
      const sessionId = req.params.id;
      await runTurn(ctx, sessionId, answer, reply, {
        afterTurn: async (state) => [
          { event: "spec", data: { spec: await svc.liveSpec(companyId, sessionId, state) } },
        ],
      });
    },
  );

  app.post("/requirements/:id/complete", { ...guard.staff(), schema: { params: Id } }, async (req) => {
    await wrap(() => svc.requestCompletion(req.companyId, req.params.id, viewerOf(req)));
    return { ok: true as const };
  });

  app.post("/requirements/:id/reopen", { ...guard.staff(), schema: { params: Id } }, async (req) => {
    await wrap(() => svc.reopen(req.companyId, req.params.id, viewerOf(req)));
    return { ok: true as const };
  });

  app.put(
    "/requirements/:id/sections/:key",
    {
      ...guard.staff(),
      schema: {
        params: z.object({ id: z.string(), key: z.string().min(1).max(64) }),
        body: z.object({ markdown: z.string().max(100000) }),
      },
    },
    async (req) => {
      const p = staff(req);
      const spec = await wrap(() =>
        svc.editSection(
          req.companyId,
          req.params.id,
          req.params.key,
          req.body.markdown,
          p.userId,
          viewerOf(req),
        ),
      );
      await ctx.services.audit.record(req.companyId, {
        actorId: p.userId,
        action: "requirements.section_edit",
        targetType: "session",
        targetId: req.params.id,
        diff: { key: req.params.key, chars: req.body.markdown.trim().length },
      });
      return { spec };
    },
  );

  app.post(
    "/requirements/:id/findings/:findingId",
    {
      ...guard.staff(),
      schema: {
        params: z.object({ id: z.string(), findingId: z.string() }),
        body: z.object({ outcome: FindingOutcomeSchema, note: z.string().max(2000).optional() }),
      },
    },
    async (req) => {
      const p = staff(req);
      const spec = await wrap(() =>
        svc.settleFinding(
          req.companyId,
          req.params.id,
          req.params.findingId,
          req.body.outcome,
          req.body.note,
          p.userId,
          viewerOf(req),
        ),
      );
      await ctx.services.audit.record(req.companyId, {
        actorId: p.userId,
        action: "requirements.finding",
        targetType: "session",
        targetId: req.params.id,
        diff: { findingId: req.params.findingId, outcome: req.body.outcome },
      });
      return { spec };
    },
  );

  // ---------- Versions and exports ----------

  app.post(
    "/requirements/:id/versions",
    {
      ...guard.staff(expensiveLimit(ctx.config)),
      schema: { params: Id, body: z.object({ label: z.string().max(120).optional() }).default({}) },
    },
    async (req, reply) => {
      const p = staff(req);
      const version = await wrap(() =>
        svc.queueVersion(req.companyId, req.params.id, p.userId, req.body.label, viewerOf(req)),
      );
      await ctx.services.audit.record(req.companyId, {
        actorId: p.userId,
        action: "requirements.version",
        targetType: "session",
        targetId: req.params.id,
        diff: {
          versionId: version.id,
          version: version.version,
          ...(version.label ? { label: version.label } : {}),
        },
      });
      return reply.status(202).send({ version });
    },
  );

  app.get("/requirements/:id/versions", { ...guard.staff(), schema: { params: Id } }, async (req) => ({
    versions: await wrap(() => svc.listVersions(req.companyId, req.params.id, viewerOf(req))),
  }));

  app.get(
    "/requirements/:id/versions/:v",
    { ...guard.staff(), schema: { params: VersionParams } },
    async (req) => wrap(() => svc.getVersion(req.companyId, req.params.id, req.params.v, viewerOf(req))),
  );

  app.get(
    "/requirements/:id/versions/:v/diff/:other",
    {
      ...guard.staff(),
      schema: { params: VersionParams.extend({ other: z.coerce.number().int().positive() }) },
    },
    async (req) =>
      wrap(() =>
        svc.diffVersions(req.companyId, req.params.id, req.params.v, req.params.other, viewerOf(req)),
      ),
  );

  app.get(
    "/requirements/:id/versions/:v/export",
    {
      ...guard.staff(),
      schema: { params: VersionParams, querystring: z.object({ format: z.enum(["md", "json", "bundle"]) }) },
    },
    async (req, reply) => {
      const file = await wrap(() =>
        svc.exportVersion(req.companyId, req.params.id, req.params.v, req.query.format, viewerOf(req)),
      );
      return reply
        .header("content-type", file.contentType)
        .header("content-disposition", `attachment; filename="${file.filename}"`)
        .send(file.body);
    },
  );

  app.post(
    "/requirements/:id/versions/:v/github",
    {
      ...guard.staff(),
      schema: {
        params: VersionParams,
        body: z.object({
          repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "owner/name"),
          branch: z.string().max(200).optional(),
          directory: z.string().max(300).optional(),
          token: z.string().min(1),
          message: z.string().max(500).optional(),
        }),
      },
    },
    async (req) => {
      const p = staff(req);
      const { token: _token, ...safe } = req.body;
      const result = await wrap(() =>
        svc.pushToGitHub(req.companyId, req.params.id, req.params.v, req.body, viewerOf(req)),
      );
      await ctx.services.audit.record(req.companyId, {
        actorId: p.userId,
        action: "requirements.github_push",
        targetType: "session",
        targetId: req.params.id,
        diff: {
          repository: safe.repository,
          branch: result.branch,
          files: result.files,
          version: req.params.v,
        },
      });
      return { commitUrl: result.commitUrl, files: result.files };
    },
  );

  // ---------- External invitations ----------

  app.post(
    "/requirements/:id/invitations",
    { ...guard.staff(), schema: { params: Id, body: z.object({ email: z.email() }) } },
    async (req) => {
      const p = staff(req);
      const invitation = await wrap(() =>
        svc.invite(req.companyId, req.params.id, req.body.email, p.userId, viewerOf(req)),
      );
      await ctx.services.audit.record(req.companyId, {
        actorId: p.userId,
        action: "requirements.invite",
        targetType: "session",
        targetId: req.params.id,
        diff: { invitationId: invitation.id, email: invitation.email },
      });
      return { invitation };
    },
  );

  app.post(
    "/requirements/:id/invitations/:invId/revoke",
    { ...guard.staff(), schema: { params: z.object({ id: z.string(), invId: z.string() }) } },
    async (req) => {
      const p = staff(req);
      await wrap(() => svc.revokeInvitation(req.companyId, req.params.id, req.params.invId, viewerOf(req)));
      await ctx.services.audit.record(req.companyId, {
        actorId: p.userId,
        action: "requirements.revoke",
        targetType: "session",
        targetId: req.params.id,
        diff: { invitationId: req.params.invId },
      });
      return { ok: true as const };
    },
  );
}
