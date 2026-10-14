import { z } from "zod";
import type { App } from "../../app.js";
import { guard } from "../../auth/access.js";
import { staff } from "../../auth/plugin.js";
import type { RouteContext } from "../../context.js";
import { AppError, notFound } from "../../lib/errors.js";
import { LOGO_MAX_BYTES } from "./image.js";

const Branding = z.object({
  productName: z.string(),
  hasLogo: z.boolean(),
  logoVersion: z.string().nullable(),
});

const LogoQuery = z.object({ v: z.string().max(64).optional() });

/**
 * The platform's name and logo (D-430 to D-434).
 *
 * The two reads are public: the landing page, the sign-in page and the browser tab need them
 * before anyone has signed in. They carry nothing but the platform's own name and image, and are
 * limited per address like everything else, with a budget wide enough that a page view never
 * meets it (the web server caches the name for a minute and a browser keeps the image).
 *
 * The writes belong to the platform operator: the logo is part of the platform scope, which only
 * the operator edits (D-182), and each one leaves an audit row.
 */
export async function brandingRoutes(app: App, ctx: RouteContext): Promise<void> {
  const branding = ctx.services.branding;

  app.get(
    "/public/branding",
    {
      ...guard.public({ config: { rateLimit: { max: 300, timeWindow: "1 minute" } } }),
      schema: { response: { 200: Branding } },
    },
    async (_req, reply) => {
      const body = await branding.publicBranding();
      // Short, because a rename or a new logo should show within a minute without a purge.
      return reply.header("cache-control", "public, max-age=60").send(body);
    },
  );

  /**
   * The logo's bytes. With `?v=` equal to the current version the answer is cacheable for a year,
   * because that URL can only ever mean these bytes; anything else gets a minute. The type is the
   * one sniffed at upload, `nosniff` holds the browser to it, and the sandbox policy means that
   * nothing in the file could run even if it were opened as a document.
   */
  app.get(
    "/public/branding/logo",
    {
      ...guard.public({ config: { rateLimit: { max: 300, timeWindow: "1 minute" } } }),
      schema: { hide: true, querystring: LogoQuery },
    },
    async (req, reply) => {
      const logo = await branding.logo();
      if (!logo) {
        reply.header("cache-control", "no-store");
        throw notFound("Logo");
      }
      const etag = `"${logo.version}"`;
      const pinned = req.query.v === logo.version;
      reply
        .header("content-type", logo.contentType)
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", "default-src 'none'; sandbox")
        .header("cross-origin-resource-policy", "same-site")
        .header("content-disposition", "inline")
        .header("etag", etag)
        .header("cache-control", pinned ? "public, max-age=31536000, immutable" : "public, max-age=60");
      if (req.headers["if-none-match"] === etag) return reply.status(304).send();
      return reply.send(logo.bytes);
    },
  );

  app.put(
    "/operator/branding/logo",
    {
      ...guard.operator({ config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }),
      schema: { hide: true },
    },
    async (req) => {
      if (!req.isMultipart()) throw new AppError("validation", "Expected a multipart upload");
      // One byte over the limit is enough to know it is too large, and nothing more is read.
      const file = await req.file({ limits: { fileSize: LOGO_MAX_BYTES + 1, files: 1 } });
      if (!file) throw new AppError("validation", "No file in the upload");
      let bytes: Buffer;
      try {
        bytes = await file.toBuffer();
      } catch (err) {
        if ((err as { code?: unknown }).code === "FST_REQ_FILE_TOO_LARGE") {
          throw new AppError(
            "too_large",
            `The logo must be ${String(LOGO_MAX_BYTES / 1024)} KB or smaller.`,
            {
              problem: "too_large",
            },
          );
        }
        throw err;
      }
      const p = staff(req);
      return branding.setLogo({ userId: p.userId, companyId: p.companyId }, bytes);
    },
  );

  app.delete(
    "/operator/branding/logo",
    { ...guard.operator(), schema: { response: { 200: Branding } } },
    async (req) => {
      const p = staff(req);
      return branding.removeLogo({ userId: p.userId, companyId: p.companyId });
    },
  );
}
