import {
  DiagramInvalidError,
  DiagramLimitError,
  DiagramNotFoundError,
  ExportBusyError,
  GitHubError,
  GitHubNotConfiguredError,
  InvalidSectionError,
  PathRequiredError,
  PdfNotAvailableError,
  PdfTooLargeError,
  RequirementsForbiddenError,
  RequirementsNotFoundError,
  SessionNotOpenError,
  SpecVersionInProgressError,
  SpecVersionNotReadyError,
  type Viewer,
} from "@aidp/core";
import { DiagramTypeSchema, FindingOutcomeSchema, PathSchema } from "@aidp/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { App } from "../../app.js";
import { guard } from "../../auth/access.js";
import { staff } from "../../auth/plugin.js";
import type { RouteContext } from "../../context.js";
import { AppError, forbidden, notFound } from "../../lib/errors.js";
import { expensiveLimit } from "../../lib/rate-limit.js";
import { transcribeDraft } from "../participant/voice.js";
import { answerFromBody, parseTurnBody } from "../sessions/turn-body.js";
import { runTurn } from "../sessions/turn-runner.js";
import { RequirementsListQuery, requirementsListArgs } from "./service.js";

const Id = z.object({ id: z.string() });

const VersionParams = z.object({ id: z.string(), v: z.coerce.number().int().positive() });

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
      if (e instanceof DiagramInvalidError) throw new AppError("validation", e.message, { issues: e.issues });
      if (e instanceof DiagramNotFoundError) throw notFound("Diagram");
      if (e instanceof DiagramLimitError) throw new AppError("validation", e.message);
      if (e instanceof ExportBusyError) throw new AppError("rate_limited", e.message);
      if (e instanceof PdfTooLargeError)
        throw new AppError("too_large", `${e.message}; export it as Markdown instead`);
      if (e instanceof PdfNotAvailableError) throw new AppError("internal", e.message);
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
      await ctx.services.audit.record(req.companyId, {
        actorId: staff(req).userId,
        action: "requirements.path",
        targetType: "session",
        targetId: req.params.id,
        diff: { path: req.body.path },
      });
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
      const body = parseTurnBody(req.body);
      const answer = answerFromBody(body);
      const companyId = req.companyId;
      const sessionId = req.params.id;
      await runTurn(ctx, sessionId, answer, reply, {
        afterTurn: async (state) => [
          { event: "spec", data: { spec: await svc.liveSpec(companyId, sessionId, state) } },
        ],
      });
    },
  );

  /**
   * Dictation for the owner's answer box (D-483): the recording comes back as an editable draft;
   * nothing is sent and the audio is not kept. Held to the owner's access to the session, and to the
   * recorded-voice switch of the session's template and tenant.
   */
  app.post(
    "/requirements/:id/transcribe",
    {
      ...guard.staff({ config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }),
      schema: { params: Id, hide: true },
    },
    async (req) => {
      // Access only: a path is needed for a turn, not for words in the box.
      await wrap(() => svc.assertAccess(req.companyId, req.params.id, viewerOf(req)));
      return transcribeDraft(ctx, { companyId: req.companyId, sessionId: req.params.id }, req);
    },
  );

  app.post("/requirements/:id/complete", { ...guard.staff(), schema: { params: Id } }, async (req) => {
    await wrap(() => svc.requestCompletion(req.companyId, req.params.id, viewerOf(req)));
    await ctx.services.audit.record(req.companyId, {
      actorId: staff(req).userId,
      action: "requirements.complete",
      targetType: "session",
      targetId: req.params.id,
    });
    return { ok: true as const };
  });

  app.post("/requirements/:id/reopen", { ...guard.staff(), schema: { params: Id } }, async (req) => {
    await wrap(() => svc.reopen(req.companyId, req.params.id, viewerOf(req)));
    await ctx.services.audit.record(req.companyId, {
      actorId: staff(req).userId,
      action: "requirements.reopen",
      targetType: "session",
      targetId: req.params.id,
    });
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

  /** One file out of a finished version, with the warnings a PDF carries in a header (D-211). */
  const sendExport = async (
    req: FastifyRequest,
    reply: FastifyReply,
    id: string,
    v: number,
    format: "md" | "json" | "bundle" | "pdf",
  ) => {
    const file = await wrap(() => svc.exportVersion(req.companyId, id, v, format, viewerOf(req)));
    await ctx.services.audit.record(req.companyId, {
      actorId: staff(req).userId,
      action: "requirements.export",
      targetType: "session",
      targetId: id,
      diff: {
        format,
        version: v,
        ...(file.pages !== undefined ? { pages: file.pages } : {}),
        ...(file.warnings?.length ? { warnings: file.warnings } : {}),
      },
    });
    if (file.warnings?.length) reply.header("x-export-warnings", file.warnings.join(","));
    if (file.pages !== undefined) reply.header("x-export-pages", String(file.pages));
    return reply
      .header("content-type", file.contentType)
      .header("content-disposition", `attachment; filename="${file.filename}"`)
      .header("cache-control", "private, no-store")
      .send(file.body);
  };

  app.get(
    "/requirements/:id/versions/:v/export",
    {
      ...guard.staff(expensiveLimit(ctx.config)),
      schema: {
        params: VersionParams,
        querystring: z.object({ format: z.enum(["md", "json", "bundle", "pdf"]) }),
      },
    },
    async (req, reply) => sendExport(req, reply, req.params.id, req.params.v, req.query.format),
  );

  app.get(
    "/requirements/:id/versions/:v/export.pdf",
    { ...guard.staff(expensiveLimit(ctx.config)), schema: { params: VersionParams } },
    async (req, reply) => sendExport(req, reply, req.params.id, req.params.v, "pdf"),
  );

  // ---------- Diagrams (FR-23) ----------

  const DiagramBody = z.object({
    mermaid: z.string().min(1).max(40_000),
    // The caption and the alt text: a diagram without one is not finished.
    description: z.string().trim().min(1).max(500),
    title: z.string().trim().min(1).max(120).optional(),
    type: DiagramTypeSchema.optional(),
  });
  const DiagramKey = z.object({ id: z.string(), key: z.string().min(1).max(64) });

  const auditDiagram = async (
    req: FastifyRequest,
    id: string,
    action: string,
    diff: Record<string, unknown>,
  ): Promise<void> => {
    await ctx.services.audit.record(req.companyId, {
      actorId: staff(req).userId,
      action,
      targetType: "session",
      targetId: id,
      diff,
    });
  };

  app.put(
    "/requirements/:id/spec/diagrams/:key",
    { ...guard.staff(expensiveLimit(ctx.config)), schema: { params: DiagramKey, body: DiagramBody } },
    async (req) => {
      const result = await wrap(() =>
        svc.saveDiagram(
          req.companyId,
          req.params.id,
          req.params.key,
          req.body,
          staff(req).userId,
          viewerOf(req),
        ),
      );
      await auditDiagram(req, req.params.id, "requirements.diagram_edit", {
        key: result.key,
        chars: req.body.mermaid.length,
        verified: result.verified,
      });
      return { spec: result.spec, key: result.key, verified: result.verified };
    },
  );

  app.post(
    "/requirements/:id/spec/diagrams",
    { ...guard.staff(expensiveLimit(ctx.config)), schema: { params: Id, body: DiagramBody } },
    async (req, reply) => {
      const result = await wrap(() =>
        svc.saveDiagram(req.companyId, req.params.id, null, req.body, staff(req).userId, viewerOf(req)),
      );
      await auditDiagram(req, req.params.id, "requirements.diagram_add", {
        key: result.key,
        chars: req.body.mermaid.length,
        verified: result.verified,
      });
      return reply.status(201).send({ spec: result.spec, key: result.key, verified: result.verified });
    },
  );

  app.delete(
    "/requirements/:id/spec/diagrams/:key",
    { ...guard.staff(), schema: { params: DiagramKey } },
    async (req) => {
      const spec = await wrap(() =>
        svc.resetDiagram(req.companyId, req.params.id, req.params.key, viewerOf(req)),
      );
      await auditDiagram(req, req.params.id, "requirements.diagram_reset", { key: req.params.key });
      return { spec };
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
