import { toStored } from "@aidp/core";
import { StaffSessionResponseSchema, type StaffSessionView } from "@aidp/shared";
import { z } from "zod";
import type { App } from "../../app.js";
import { guard } from "../../auth/access.js";
import { staff } from "../../auth/plugin.js";
import type { AppContext } from "../../context.js";
import { forbidden, notFound } from "../../lib/errors.js";

const Id = z.object({ id: z.string() });

/** The start of the UTC day: what a timestamp is coarsened to when the person is not named (D-142). */
function toDay(d: Date | null): Date | null {
  return d ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) : null;
}

/** Staff view of sessions, gated by the privacy setting (spec 11). */
export async function sessionRoutes(app: App, ctx: AppContext): Promise<void> {
  const load = async (companyId: string, id: string) => {
    const s = await ctx.db.session.findFirst({
      where: { id, companyId },
      include: {
        participant: { select: { fields: true } },
        campaign: { select: { id: true, name: true, participationMode: true } },
        template: { select: { key: true } },
      },
    });
    if (!s) throw notFound("Session");
    return s;
  };

  /**
   * Who may open a raw transcript (`privacy.rawTranscriptsVisibleTo`, spec 11).
   *
   * - `nobody`: no one.
   * - `admins`: administrators and the platform operator. A member is not one of them; this branch
   *   used to answer "yes" to any staff role, so the setting named a group it did not enforce.
   * - `admins_when_identified_and_opted_in`: the same administrators, and only for an identified
   *   participant who opted in.
   *
   * A member who owns a requirements session (it is theirs: they are the one being interviewed
   * about their own product) reads its transcript under any setting but `nobody`.
   */
  const mayReadTranscript = async (
    req: Parameters<typeof staff>[0],
    s: {
      ownerUserId: string | null;
      sourceKind: string;
      participant: { fields: unknown } | null;
      campaign: { participationMode: string } | null;
    },
  ): Promise<boolean> => {
    const who = staff(req);
    const setting = await ctx.settings.get("privacy.rawTranscriptsVisibleTo", [
      { scope: "tenant", scopeId: req.companyId },
    ]);
    if (setting === "nobody") return false;
    const owns = s.sourceKind !== "campaign" && s.ownerUserId !== null && s.ownerUserId === who.userId;
    if (owns) return true;
    if (who.role !== "admin" && who.role !== "platform_operator") return false;
    if (setting === "admins") return true;
    const fields = (s.participant?.fields ?? {}) as Record<string, string>;
    return s.campaign?.participationMode === "identified" && fields.transcriptOptIn === "true";
  };

  app.get(
    "/sessions/:id",
    { ...guard.staff(), schema: { params: Id, response: { 200: StaffSessionResponseSchema } } },
    async (req) => {
      const s = await load(req.companyId, req.params.id);
      const transcript = await mayReadTranscript(req, s);
      const messages = transcript
        ? (await ctx.db.message.findMany({ where: { sessionId: s.id }, orderBy: { seq: "asc" } })).map(
            toStored,
          )
        : null;
      const state = (s.state ?? {}) as Record<string, unknown>;
      // An anonymous participant is given no time to the second here either: it would be read against
      // the day an invitation was opened (D-142). The same rule as the campaign's session list.
      const named =
        s.campaign?.participationMode === "identified" ||
        (s.campaign?.participationMode === "participant_choice" && s.consentedAt !== null);
      const coarse = s.campaign !== null && !named;
      const when = (d: Date | null): Date | null => (coarse ? toDay(d) : d);
      // Built field by field: a row spread into a response is how a link hash and a participant's
      // address reached staff before. The response schema strips anything that is not listed.
      const session: StaffSessionView = {
        id: s.id,
        status: s.status,
        sourceKind: s.sourceKind,
        campaignId: s.campaignId,
        templateId: s.templateId,
        templateKey: s.template.key,
        templateVersion: s.templateVersion,
        path: s.path,
        modePreference: s.modePreference,
        consentVersion: s.consentVersion,
        consentedAt: when(s.consentedAt),
        startedAt: when(s.startedAt),
        endedAt: when(s.endedAt),
        createdAt: when(s.createdAt) ?? s.createdAt,
        updatedAt: when(s.updatedAt) ?? s.updatedAt,
        campaign: s.campaign
          ? { id: s.campaign.id, name: s.campaign.name, participationMode: s.campaign.participationMode }
          : null,
        // The rolling summary is the transcript, condensed; it is hidden with it.
        summary: transcript ? s.summary : "",
        state: transcript ? state : { coverage: state.coverage },
        messages,
        transcriptVisible: transcript,
      };
      // `messages` and `transcriptVisible` travel inside the record as well as beside it, so a client
      // that unwraps `session` keeps them.
      return { session, messages, transcriptVisible: transcript };
    },
  );

  app.get("/sessions/:id/events", { ...guard.admin(), schema: { params: Id } }, async (req) => {
    const s = await load(req.companyId, req.params.id);
    if (!(await mayReadTranscript(req, s)))
      throw forbidden("Transcript access is disabled by the privacy settings");
    return {
      events: await ctx.db.sessionEvent.findMany({ where: { sessionId: s.id }, orderBy: { seq: "asc" } }),
    };
  });
}
