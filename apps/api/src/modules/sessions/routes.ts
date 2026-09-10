import { toStored } from "@aidp/core";
import { z } from "zod";
import type { App } from "../../app.js";
import { requireStaff } from "../../auth/plugin.js";
import type { AppContext } from "../../context.js";
import { forbidden, notFound } from "../../lib/errors.js";

const Id = z.object({ id: z.string() });

/** Staff view of sessions, gated by the privacy setting (spec 11). */
export async function sessionRoutes(app: App, ctx: AppContext): Promise<void> {
  const load = async (companyId: string, id: string) => {
    const s = await ctx.db.session.findFirst({
      where: { id, companyId },
      include: { participant: true, campaign: true },
    });
    if (!s) throw notFound("Session");
    return s;
  };

  const mayReadTranscript = async (
    companyId: string,
    s: { participant: { fields: unknown } | null; campaign: { participationMode: string } | null },
  ): Promise<boolean> => {
    const setting = await ctx.settings.get("privacy.rawTranscriptsVisibleTo", [
      { scope: "tenant", scopeId: companyId },
    ]);
    if (setting === "nobody") return false;
    if (setting === "admins") return true;
    const fields = (s.participant?.fields ?? {}) as Record<string, string>;
    return s.campaign?.participationMode === "identified" && fields["transcriptOptIn"] === "true";
  };

  app.get("/sessions/:id", { preHandler: requireStaff(), schema: { params: Id } }, async (req) => {
    const s = await load(req.companyId, req.params.id);
    const transcript = await mayReadTranscript(req.companyId, s);
    const messages = transcript
      ? (await ctx.db.message.findMany({ where: { sessionId: s.id }, orderBy: { seq: "asc" } })).map(toStored)
      : null;
    const { participant: _p, ...session } = s;
    return {
      session: {
        ...session,
        state: transcript ? session.state : { coverage: (session.state as { coverage?: unknown }).coverage },
      },
      messages,
      transcriptVisible: transcript,
    };
  });

  app.get(
    "/sessions/:id/events",
    { preHandler: requireStaff("admin"), schema: { params: Id } },
    async (req) => {
      const s = await load(req.companyId, req.params.id);
      if (!(await mayReadTranscript(req.companyId, s)))
        throw forbidden("Transcript access is disabled by the privacy settings");
      return {
        events: await ctx.db.sessionEvent.findMany({ where: { sessionId: s.id }, orderBy: { seq: "asc" } }),
      };
    },
  );
}
