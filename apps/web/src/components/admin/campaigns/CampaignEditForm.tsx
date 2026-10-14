"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { z } from "zod";
import { NumberField, TextAreaField, TextField } from "@/components/admin/forms";
import { useDirtyGuard } from "@/components/common/DirtyGuard";
import { ReadOnlyField } from "@/components/form/controls";
import { FormSection, Form } from "@/components/form/Form";
import { useForm } from "@/components/form/useForm";
import { Button } from "@/components/ui/button";
import { Inset } from "@/components/ui/inset";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import type { Campaign } from "@/lib/api/schemas";
import { label } from "@/lib/i18n/enums";

/** An ISO instant as the value of a `datetime-local` input, in the viewer's time zone. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface ConsentView {
  /** The text set for this campaign alone, or null when it has none. */
  own: string | null;
  /** What participants read when nothing is set: the localized default of the interview language. */
  defaultText: string;
  /** The interview language the default was chosen for. */
  language: string;
  /** Whether the organization sets a text of its own that the campaign would otherwise inherit. */
  organizationText: string | null;
}

/** The campaign's welcome (D-460): its own text, or the default for the template kind and language. */
export interface WelcomeView {
  /** The text set for this campaign, or null when it has none. */
  own: string | null;
  /** What participants read when nothing is set. */
  defaultText: string;
  /** The interview language the default was chosen for. */
  language: string;
}

const NONE: number | "" = "";

const schema = z.object({
  name: z.string().trim().min(1),
  domains: z.string(),
  maxTurns: z.union([z.literal(""), z.number().int().min(5).max(500)]),
  threshold: z.union([z.literal(""), z.number().int().min(1)]),
  expiresAt: z.string(),
  consent: z.string(),
  welcome: z.string().max(2000),
});

/**
 * Edit a running or draft campaign (D-237, D-362, D-460): its name, limits, welcome and consent
 * text, in the form
 * kit (validation on blur and submit, unsaved-changes guard, floating save bar). Who can answer
 * and whether people are identified are shown but not editable: the API fixes them at creation,
 * because participants and invitations may already depend on them.
 */
export function CampaignEditForm({
  campaign,
  consent,
  welcome = { own: null, defaultText: t.participant.arrival.welcomeFallback, language: consent.language },
}: {
  campaign: Campaign;
  consent: ConsentView;
  welcome?: WelcomeView;
}): React.JSX.Element {
  const s = t.admin.campaigns;
  const router = useRouter();
  const guard = useDirtyGuard();
  const formId = `campaign-edit-${campaign.id}`;
  const initial = {
    name: campaign.name,
    domains: (campaign.allowedEmailDomains ?? []).join(", "),
    maxTurns: campaign.maxTurns ?? NONE,
    threshold: campaign.completionThreshold ?? NONE,
    expiresAt: toLocalInput(campaign.expiresAt),
    consent: consent.own ?? "",
    welcome: welcome.own ?? "",
  };
  const form = useForm({
    id: formId,
    initial,
    schema,
    labels: {
      name: s.name,
      domains: s.allowedDomains,
      maxTurns: s.maxTurns,
      threshold: s.completionThreshold,
      expiresAt: s.expiresAt,
      consent: s.consentLabel,
      welcome: s.welcomeLabel,
    },
    savedText: s.savedToast,
    onSubmit: async (v) => {
      await staffClient.campaigns.update(campaign.id, {
        name: v.name.trim(),
        allowedEmailDomains: v.domains
          .split(",")
          .map((d) => d.trim())
          .filter(Boolean),
        ...(v.maxTurns !== "" ? { maxTurns: v.maxTurns } : {}),
        ...(v.threshold !== "" ? { completionThreshold: v.threshold } : {}),
        ...(v.expiresAt ? { expiresAt: new Date(v.expiresAt).toISOString() } : {}),
      });
      // Empty clears the campaign's own text, so the default applies again. One write for both.
      const texts = {
        ...(v.welcome !== initial.welcome
          ? { "campaign.welcomeText": v.welcome.trim() === "" ? null : v.welcome.trim() }
          : {}),
        ...(v.consent !== initial.consent
          ? { "campaign.consentText": v.consent.trim() === "" ? null : v.consent }
          : {}),
      };
      if (Object.keys(texts).length > 0) {
        await staffClient.settings.put({ scope: "campaign", scopeId: campaign.id }, texts);
      }
      // What was just saved is no longer unsaved, so leaving does not ask again.
      guard.setDirty(formId, false);
      router.push(`/admin/campaigns/${campaign.id}`);
      router.refresh();
    },
  });

  return (
    <Form form={form} className="max-w-3xl" saveLabel={s.saveChanges}>
      <FormSection id="basics" title={s.detailsTitle}>
        <p className="text-muted-foreground -mt-2 text-sm">{s.editBody}</p>
        <TextField {...form.field("name")} label={s.name} required />
        <TextField
          {...form.field("domains")}
          label={s.allowedDomains}
          hint={s.domainsHint}
          placeholder="company.com, subsidiary.com"
        />
        <div className="grid gap-4 md:grid-cols-3">
          <NumberField
            {...form.field("maxTurns")}
            label={s.maxTurns}
            hint={s.maxTurnsHint}
            min={5}
            max={500}
          />
          <NumberField
            {...form.field("threshold")}
            label={s.completionThreshold}
            hint={s.thresholdHint}
            min={1}
          />
          <TextField
            {...form.field("expiresAt")}
            label={s.expiresAt}
            type="datetime-local"
            hint={s.expiresHint}
          />
        </div>
        <Inset>
          <p className="text-foreground text-sm font-medium">{s.editFixedTitle}</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <ReadOnlyField
              id="fixed-mode"
              label={s.participationMode}
              value={
                campaign.participationMode
                  ? label("privacyMode", campaign.participationMode)
                  : t.admin.common.dash
              }
            />
            <ReadOnlyField
              id="fixed-verification"
              label={s.verification}
              value={
                campaign.verification ? s.verificationOptions[campaign.verification] : t.admin.common.dash
              }
            />
          </div>
        </Inset>
      </FormSection>

      <FormSection id="welcome" title={s.welcomeTitle}>
        <p className="text-muted-foreground -mt-2 text-sm">{s.welcomeHint}</p>
        <TextAreaField {...form.field("welcome")} label={s.welcomeLabel} rows={4} />
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={form.values.welcome === ""}
            onClick={() => {
              form.set("welcome", "");
            }}
          >
            {s.welcomeUseDefault}
          </Button>
        </div>
        <Inset>
          <p className="text-foreground text-sm font-medium">{s.welcomeDefaultTitle(welcome.language)}</p>
          <p className="mt-1 text-sm whitespace-pre-line">{welcome.defaultText}</p>
          <p className="text-muted-foreground mt-2 text-xs">{s.welcomeDefaultHint}</p>
        </Inset>
      </FormSection>

      <FormSection id="consent" title={s.consentTitle}>
        <p className="text-muted-foreground -mt-2 text-sm">{s.consentHint}</p>
        <TextAreaField {...form.field("consent")} label={s.consentLabel} rows={7} />
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={form.values.consent === ""}
            onClick={() => {
              form.set("consent", "");
            }}
          >
            {s.consentUseDefault}
          </Button>
        </div>
        <Inset>
          <p className="text-foreground text-sm font-medium">
            {consent.organizationText ? s.consentOrganizationTitle : s.consentDefaultTitle(consent.language)}
          </p>
          <p className="mt-1 text-sm whitespace-pre-line">
            {consent.organizationText ?? consent.defaultText}
          </p>
          <p className="text-muted-foreground mt-2 text-xs">
            {consent.organizationText ? s.consentInherited : s.consentDefaultHint}
          </p>
        </Inset>
      </FormSection>
    </Form>
  );
}
