import { AttachmentRejected, type AttachmentView } from "@aidp/core";
import { PLATFORM_MAX_UPLOAD_MB } from "@aidp/shared";
import type { MultipartFile } from "@fastify/multipart";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import type { App } from "../../app.js";
import { guard } from "../../auth/access.js";
import { participant } from "../../auth/plugin.js";
import type { RouteContext } from "../../context.js";
import { AppError, notFound } from "../../lib/errors.js";

/**
 * Uploading, listing, playing back and deleting a session's attachments (FR-30, FR-31, FR-32).
 *
 * Separate from routes.ts because these are the only participant routes that speak multipart and
 * stream bytes rather than JSON, and mixing them in would make both harder to read.
 *
 * The upload is deliberately not the same request as the turn. A recording or a document is
 * attached first and referenced afterwards, so a failed upload costs the participant a retry of
 * the upload rather than a retry of their answer, and a large file does not sit inside the turn's
 * rate limit.
 */

const AttachmentParams = z.object({ attachmentId: z.string().min(1) });

export async function participantAttachmentRoutes(app: App, ctx: RouteContext): Promise<void> {
  const authed = guard.participant();

  /**
   * Uploads one file. The response is the attachment row, not the ingested result: reading it is
   * a job, and the participant is told `status: "pending"` so the interface can say so.
   */
  app.post(
    "/p/session/attachments",
    {
      ...guard.participant({ config: { rateLimit: { max: 20, timeWindow: "5 minutes" } } }),
      schema: { hide: true },
    },
    async (req) => {
      const p = participant(req);
      // The tenant's limit is resolved before a byte of the body is read, and handed to the
      // multipart parser, which stops the stream there. A file over it is never buffered whole,
      // so the cap protects memory as well as storage (S6, D-87).
      const maxMb = await ctx.settings.get("files.maxSizeMb", [{ scope: "tenant", scopeId: p.companyId }]);
      const file = await readOneFile(req, Math.min(maxMb, PLATFORM_MAX_UPLOAD_MB) * 1024 * 1024);
      const durationMs = durationFrom(file);

      try {
        const created = await ctx.attachments.create({
          companyId: p.companyId,
          sessionId: p.sessionId,
          filename: file.filename,
          mime: file.mimetype,
          bytes: await file.toBuffer(),
          ...(durationMs === undefined ? {} : { durationMs }),
        });

        // Audio is transcribed on the turn path, so only documents and images need reading here.
        if (created.kind !== "audio") {
          await ctx.jobs.publish(
            "attachment.ingest",
            { attachmentId: created.id, companyId: p.companyId },
            { singletonKey: `ingest:${created.id}` },
          );
        }
        return { attachment: created };
      } catch (err) {
        throw toHttp(err);
      }
    },
  );

  app.get("/p/session/attachments", { ...authed, schema: { hide: true } }, async (req) => {
    const p = participant(req);
    const attachments: AttachmentView[] = await ctx.attachments.list(p.companyId, p.sessionId);
    return { attachments };
  });

  /**
   * Streams the bytes back, for playing a recording or re-reading an attachment.
   *
   * `Content-Disposition: attachment` on everything, and `X-Content-Type-Options: nosniff`, because
   * these bytes are whatever a participant uploaded. Serving them inline on the API's own origin
   * would let an uploaded HTML or SVG file run script there. The player fetches through the web
   * app's proxy and plays a blob, which does not need inline disposition.
   */
  app.get(
    "/p/session/attachments/:attachmentId",
    { ...authed, schema: { hide: true, params: AttachmentParams } },
    async (req, reply) => {
      const p = participant(req);
      const found = await ctx.attachments.open(p.companyId, p.sessionId, req.params.attachmentId);
      if (!found) throw notFound("Attachment");
      return reply
        .header("content-type", found.mime)
        .header("x-content-type-options", "nosniff")
        .header("content-disposition", `attachment; filename="${encodeURIComponent(found.filename)}"`)
        .header("cache-control", "private, no-store")
        .send(found.stream);
    },
  );

  app.delete(
    "/p/session/attachments/:attachmentId",
    { ...authed, schema: { hide: true, params: AttachmentParams } },
    async (req) => {
      const p = participant(req);
      const removed = await ctx.attachments.remove(p.companyId, p.sessionId, req.params.attachmentId);
      if (!removed) throw notFound("Attachment");
      return { ok: true as const };
    },
  );
}

/**
 * Takes exactly one file from a multipart body.
 *
 * Fastify's multipart parser streams parts, and a part that is never consumed leaves the request
 * hanging. Requiring a single file and refusing the rest keeps that simple, and matches the
 * interface: one upload, one attachment, one thing to retry when it fails.
 */
async function readOneFile(req: FastifyRequest, maxBytes: number): Promise<MultipartFile> {
  if (!req.isMultipart()) throw new AppError("validation", "Expected a multipart upload");
  const file = await req.file({ limits: { fileSize: maxBytes, files: 1 } });
  if (!file) throw new AppError("validation", "No file in the upload");
  return file;
}

/**
 * The recording's length, measured in the browser.
 *
 * Trusted only as a display value. Browsers do not put a duration in a `MediaRecorder` blob's
 * container, so the alternative is decoding the audio server-side to find out, which is a lot of
 * work to improve a number shown beside a play button. It is never used for billing: the
 * transcription provider reports the duration it actually processed.
 */
function durationFrom(file: MultipartFile): number | undefined {
  const raw = file.fields.durationMs;
  const value = raw && !Array.isArray(raw) && "value" in raw ? raw.value : undefined;
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 && parsed < 86_400_000 ? parsed : undefined;
}

/** A rejection the participant caused becomes a 4xx they can act on; anything else is ours. */
function toHttp(err: unknown): unknown {
  if (err instanceof AttachmentRejected) {
    const code = err.reason === "size" ? "too_large" : err.reason === "session" ? "not_found" : "validation";
    return new AppError(code, err.message);
  }
  if (typeof err === "object" && err !== null && "code" in err) {
    // @fastify/multipart's own limit, hit before ours when the hard ceiling is exceeded.
    if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
      return new AppError("too_large", "That file is too large");
    }
  }
  return err;
}
