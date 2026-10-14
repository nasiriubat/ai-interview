import { createHash } from "node:crypto";
import { defaultConsentText, participantWelcome, type SessionInvitation } from "@aidp/shared";
import { newToken } from "../crypto.js";
import type { RequirementsContext } from "./context.js";
import { InviteNotOpenError, RequirementsNotFoundError, SessionNotOpenError } from "./errors.js";
import { INVITE_DAYS, publicInvitation, storedInvitations, type StoredInvitation } from "./helpers.js";
import type { InviteView, RequirementsServiceDeps, SessionRow, Viewer } from "./types.js";

/** External invitations into a session: send, revoke, and the public arrival on the link. */
export class RequirementsInvitations {
  constructor(private readonly cx: RequirementsContext) {}

  private get deps(): RequirementsServiceDeps {
    return this.cx.deps;
  }

  async invite(
    companyId: string,
    id: string,
    email: string,
    userId: string,
    viewer: Viewer,
  ): Promise<SessionInvitation> {
    const { db, crypto } = this.deps;
    const row = await this.cx.load(companyId, id, viewer);
    if (row.status === "deleted" || row.status === "completed") throw new SessionNotOpenError(row.status);
    const to = email.trim().toLowerCase();
    const token = newToken(24);
    const tokenHash = crypto.hashToken(token);
    // One participant token per session: a new invitation replaces the previous link.
    if (row.participantId) {
      const existing = await db.participant.findUnique({ where: { id: row.participantId } });
      await db.participant.update({
        where: { id: row.participantId },
        data: { tokenHash, fields: { ...((existing?.fields ?? {}) as Record<string, string>), email: to } },
      });
    } else {
      const participant = await db.participant.create({
        data: { companyId, campaignId: null, fields: { email: to }, tokenHash },
      });
      await db.session.update({ where: { id: row.id }, data: { participantId: participant.id } });
    }
    const now = new Date();
    const invitation: StoredInvitation = {
      id: `inv_${newToken(9)}`,
      email: to,
      status: "sent",
      sentAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + INVITE_DAYS * 86400_000).toISOString(),
      tokenHash,
    };
    const previous = storedInvitations(row.invitations).map((i) =>
      i.status === "revoked" ? i : { ...i, status: "revoked" as const },
    );
    const invitations = [...previous, invitation];
    await db.session.update({
      where: { id: row.id },
      data: { invitations: invitations },
    });
    const productName = await this.deps.settings.get("branding.productName", [
      { scope: "tenant", scopeId: companyId },
    ]);
    const link = `${this.deps.publicWebUrl.replace(/\/$/, "")}/p/r/${token}`;
    await this.deps.email.send({
      to,
      companyId,
      subject: `You are invited to describe "${row.title || "a product idea"}"`,
      text: [
        `You have been invited to answer a few questions about "${row.title || "a product idea"}" in ${productName}.`,
        "",
        `Open this link to start: ${link}`,
        "",
        `The link is personal and stays valid for ${INVITE_DAYS} days.`,
      ].join("\n"),
    });
    await this.cx.appendEvent(row.id, "invitation", {
      kind: "sent",
      invitationId: invitation.id,
      by: userId,
    });
    return publicInvitation(invitation);
  }

  async revokeInvitation(companyId: string, id: string, invId: string, viewer: Viewer): Promise<void> {
    const { db, crypto } = this.deps;
    const row = await this.cx.load(companyId, id, viewer);
    const invitations = storedInvitations(row.invitations);
    const target = invitations.find((i) => i.id === invId);
    if (!target) throw new RequirementsNotFoundError("Invitation");
    const next = invitations.map((i) => (i.id === invId ? { ...i, status: "revoked" as const } : i));
    await db.session.update({
      where: { id: row.id },
      data: { invitations: next },
    });
    // Rotate the participant token so the emailed link stops working immediately.
    if (row.participantId) {
      const participant = await db.participant.findUnique({ where: { id: row.participantId } });
      if (participant?.tokenHash === target.tokenHash)
        await db.participant.update({
          where: { id: participant.id },
          data: { tokenHash: crypto.hashToken(newToken(24)) },
        });
    }
    await this.cx.appendEvent(row.id, "invitation", { kind: "revoked", invitationId: invId });
  }

  /** Public arrival on an invitation link. */
  async resolveInvite(token: string): Promise<InviteView & { sessionId: string; invitationId: string }> {
    const { session, invitation } = await this.findInvitation(token);
    const resolved = await this.deps.settings.resolveDetailed(
      ["branding.productName", "campaign.consentText"],
      [{ scope: "tenant", scopeId: session.companyId }],
    );
    const values = { "branding.productName": resolved["branding.productName"]?.value };
    // As on a campaign link (D-185): nobody wrote a consent, so the default speaks the interview's
    // language; before D-462 a Finnish requirements interview got the English default.
    const consentText =
      resolved["campaign.consentText"]?.scope != null
        ? (resolved["campaign.consentText"].value as string)
        : defaultConsentText(session.template.language);
    const status: InviteView["status"] =
      invitation.status === "revoked"
        ? "revoked"
        : new Date(invitation.expiresAt).getTime() < Date.now()
          ? "expired"
          : session.status === "completed" || session.status === "deleted"
            ? "completed"
            : "open";
    return {
      sessionId: session.id,
      invitationId: invitation.id,
      session: {
        title: session.title,
        productName: values["branding.productName"] as string,
        // Requirements interviews have no campaign, so the default for the kind and language is
        // what the owner reads (D-461).
        welcome: participantWelcome(null, session.template),
        consentText,
        consentVersion: `v${createHash("sha256").update(consentText).digest("hex").slice(0, 12)}`,
        pathSelection: session.template.pathSelection,
        language: session.template.language,
      },
      status,
    };
  }

  /** The invitation token is the participant token: opening marks the invitation and hands it back. */
  async openInvite(token: string): Promise<{ participantToken: string; sessionId: string; resume: boolean }> {
    const view = await this.resolveInvite(token);
    if (view.status !== "open") throw new InviteNotOpenError(view.status);
    const { session, invitation } = await this.findInvitation(token);
    const participant = session.participantId
      ? await this.deps.db.participant.findUnique({ where: { id: session.participantId } })
      : null;
    if (participant?.tokenHash !== invitation.tokenHash) throw new InviteNotOpenError("revoked");
    if (invitation.status !== "opened") {
      const next = storedInvitations(session.invitations).map((i) =>
        i.id === invitation.id ? { ...i, status: "opened" as const, openedAt: new Date().toISOString() } : i,
      );
      await this.deps.db.session.update({
        where: { id: session.id },
        data: { invitations: next },
      });
      await this.cx.appendEvent(session.id, "invitation", { kind: "opened", invitationId: invitation.id });
    }
    const messages = await this.deps.db.message.count({ where: { sessionId: session.id } });
    return {
      participantToken: token,
      sessionId: session.id,
      resume: session.status !== "consented" && messages > 0,
    };
  }

  private async findInvitation(
    token: string,
  ): Promise<{ session: SessionRow; invitation: StoredInvitation }> {
    const tokenHash = this.deps.crypto.hashToken(token);
    const session = await this.deps.db.session.findFirst({
      where: { invitations: { array_contains: [{ tokenHash }] } },
      include: { template: true },
    });
    const invitation = session
      ? storedInvitations(session.invitations).find((i) => i.tokenHash === tokenHash)
      : undefined;
    if (!session || !invitation) throw new RequirementsNotFoundError("Invitation");
    return { session, invitation };
  }
}
