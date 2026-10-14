import type { PrismaClient } from "@prisma/client";
import type { SettingsService } from "../settings/service.js";

/**
 * Where a tenant is on the way to its first interview (D-189).
 *
 * The state is derived from what exists, never stored: a checklist that is a column can say
 * "campaign created" about a tenant that deleted it, and cannot be wrong when it is a count. The
 * one thing that is stored is the admin's decision to stop seeing the card
 * (`ui.onboardingDismissed`).
 */
export const ONBOARDING_STEPS = ["provider", "template", "campaign", "invite"] as const;
export type OnboardingStepKey = (typeof ONBOARDING_STEPS)[number];

export interface OnboardingStep {
  key: OnboardingStepKey;
  done: boolean;
  /** For `provider`: whose model answers interviews, so the card can say "the platform's default". */
  source?: "tenant" | "platform";
}

export interface OnboardingState {
  steps: OnboardingStep[];
  done: number;
  total: number;
  complete: boolean;
  dismissed: boolean;
  /** The first step not done, in the order a person would do them; null when all are. */
  next: OnboardingStepKey | null;
}

export class TenantOnboarding {
  constructor(private readonly deps: { db: PrismaClient; settings: SettingsService }) {}

  async state(companyId: string): Promise<OnboardingState> {
    const { db, settings } = this.deps;
    const [ownRoute, platformRoute, ownTemplates, campaigns, invitationsSent, linkSessions, dismissed] =
      await Promise.all([
        db.route.count({
          where: { companyId, purpose: "interview_turn", provider: { enabled: true } },
        }),
        db.route.count({
          where: { companyId: null, purpose: "interview_turn", provider: { enabled: true } },
        }),
        db.interviewTemplate.count({ where: { companyId } }),
        db.campaign.count({ where: { companyId } }),
        db.invitation.count({ where: { companyId, sentAt: { not: null } } }),
        db.session.count({ where: { companyId, campaignId: { not: null } } }),
        settings.get("ui.onboardingDismissed", [{ scope: "tenant", scopeId: companyId }]),
      ]);
    const provider: OnboardingStep = {
      key: "provider",
      done: ownRoute > 0 || platformRoute > 0,
      ...(ownRoute > 0
        ? { source: "tenant" as const }
        : platformRoute > 0
          ? { source: "platform" as const }
          : {}),
    };
    const steps: OnboardingStep[] = [
      provider,
      // Choosing a template is copying one or launching from one; a campaign proves the choice.
      { key: "template", done: ownTemplates > 0 || campaigns > 0 },
      { key: "campaign", done: campaigns > 0 },
      // A personal invitation was sent, or someone opened the share link and started.
      { key: "invite", done: invitationsSent > 0 || linkSessions > 0 },
    ];
    const done = steps.filter((s) => s.done).length;
    return {
      steps,
      done,
      total: steps.length,
      complete: done === steps.length,
      dismissed,
      next: steps.find((s) => !s.done)?.key ?? null,
    };
  }

  async dismiss(companyId: string, userId: string): Promise<void> {
    await this.deps.settings.set(
      { scope: "tenant", scopeId: companyId },
      { "ui.onboardingDismissed": true },
      userId,
    );
  }
}
