"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { Flash, useAction } from "@/components/admin/Flash";
import { NumberField, SubmitStatus, TextAreaField, TextField, ValidatedForm } from "@/components/admin/forms";
import { Panel } from "@/components/admin/Panel";
import { useDirty, useDirtyGuard } from "@/components/common/DirtyGuard";
import { Button } from "@/components/ui/button";
import { Inset } from "@/components/ui/inset";
import { t } from "@/i18n";
import type { FormIssue } from "@/lib/admin/validation";
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

/**
 * Edit a running or draft campaign (D-237): its name, limits and consent text. Who can answer and
 * whether people are identified are shown but not editable: the API fixes them at creation,
 * because participants and invitations may already depend on them.
 */
export function CampaignEditForm({
  campaign,
  consent,
}: {
  campaign: Campaign;
  consent: ConsentView;
}): React.JSX.Element {
  const s = t.admin.campaigns;
  const router = useRouter();
  const action = useAction();
  const guard = useDirtyGuard();
  const initial = {
    name: campaign.name,
    domains: (campaign.allowedEmailDomains ?? []).join(", "),
    maxTurns: campaign.maxTurns ?? ("" as number | ""),
    threshold: campaign.completionThreshold ?? ("" as number | ""),
    expiresAt: toLocalInput(campaign.expiresAt),
    consent: consent.own ?? "",
  };
  const [name, setName] = React.useState(initial.name);
  const [domains, setDomains] = React.useState(initial.domains);
  const [maxTurns, setMaxTurns] = React.useState<number | "">(initial.maxTurns);
  const [threshold, setThreshold] = React.useState<number | "">(initial.threshold);
  const [expiresAt, setExpiresAt] = React.useState(initial.expiresAt);
  const [consentText, setConsentText] = React.useState(initial.consent);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [issues, setIssues] = React.useState<FormIssue[]>([]);
  const [attempt, setAttempt] = React.useState(0);

  const dirty =
    name !== initial.name ||
    domains !== initial.domains ||
    maxTurns !== initial.maxTurns ||
    threshold !== initial.threshold ||
    expiresAt !== initial.expiresAt ||
    consentText !== initial.consent;
  useDirty(`campaign-edit-${campaign.id}`, dirty);

  const submit = (): void => {
    const errs: Record<string, string> = {};
    const found: FormIssue[] = [];
    if (!name.trim()) {
      errs.name = t.admin.form.required;
      found.push({ id: "name", label: s.name, message: t.admin.form.required });
    }
    if (maxTurns !== "" && (maxTurns < 5 || maxTurns > 500)) {
      const message = maxTurns < 5 ? t.admin.form.atLeast(5) : t.admin.form.atMost(500);
      errs.maxTurns = message;
      found.push({ id: "maxTurns", label: s.maxTurns, message });
    }
    if (threshold !== "" && threshold < 1) {
      errs.threshold = t.admin.form.atLeast(1);
      found.push({ id: "threshold", label: s.completionThreshold, message: t.admin.form.atLeast(1) });
    }
    setErrors(errs);
    setIssues(found);
    if (found.length > 0) {
      setAttempt((n) => n + 1);
      return;
    }
    void action.run(async () => {
      await staffClient.campaigns.update(campaign.id, {
        name: name.trim(),
        allowedEmailDomains: domains
          .split(",")
          .map((d) => d.trim())
          .filter(Boolean),
        ...(maxTurns !== "" ? { maxTurns } : {}),
        ...(threshold !== "" ? { completionThreshold: threshold } : {}),
        ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
      });
      if (consentText !== initial.consent) {
        // Empty clears the campaign's own text, so the default applies again.
        await staffClient.settings.put(
          { scope: "campaign", scopeId: campaign.id },
          { "campaign.consentText": consentText.trim() === "" ? null : consentText },
        );
      }
      // What was just saved is no longer unsaved, so leaving does not ask again.
      guard.setDirty(`campaign-edit-${campaign.id}`, false);
      router.push(`/admin/campaigns/${campaign.id}`);
      router.refresh();
    }, s.savedToast);
  };

  const fixed: [string, string][] = [
    [
      s.participationMode,
      campaign.participationMode ? label("privacyMode", campaign.participationMode) : t.admin.common.dash,
    ],
    [
      s.verification,
      campaign.verification ? s.verificationOptions[campaign.verification] : t.admin.common.dash,
    ],
  ];

  return (
    <ValidatedForm className="grid max-w-3xl gap-6" onSubmit={submit} issues={issues} attempt={attempt}>
      <Flash flash={action.flash} />
      <Panel title={s.editTitle} description={s.editBody}>
        <div className="grid gap-4 px-5 py-4">
          <TextField id="name" label={s.name} value={name} error={errors.name} required onChange={setName} />
          <TextField
            id="domains"
            label={s.allowedDomains}
            value={domains}
            placeholder="company.com, subsidiary.com"
            onChange={setDomains}
          />
          <div className="grid gap-4 md:grid-cols-3">
            <NumberField
              id="maxTurns"
              label={s.maxTurns}
              value={maxTurns}
              min={5}
              max={500}
              error={errors.maxTurns}
              onChange={setMaxTurns}
            />
            <NumberField
              id="threshold"
              label={s.completionThreshold}
              value={threshold}
              min={1}
              error={errors.threshold}
              onChange={setThreshold}
            />
            <TextField
              id="expiresAt"
              label={s.expiresAt}
              type="datetime-local"
              value={expiresAt}
              hint={s.expiresHint}
              onChange={setExpiresAt}
            />
          </div>
          <Inset>
            <p className="text-foreground text-sm font-medium">{s.editFixedTitle}</p>
            <dl className="mt-2 grid gap-1 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-4">
              {fixed.map(([k, v]) => (
                <React.Fragment key={k}>
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd>{v}</dd>
                </React.Fragment>
              ))}
            </dl>
          </Inset>
        </div>
      </Panel>

      <Panel title={s.consentTitle} description={s.consentHint}>
        <div className="grid gap-4 px-5 py-4">
          <TextAreaField
            id="consentText"
            label={s.consentLabel}
            value={consentText}
            rows={7}
            onChange={setConsentText}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={consentText === ""}
              onClick={() => {
                setConsentText("");
              }}
            >
              {s.consentUseDefault}
            </Button>
          </div>
          <Inset>
            <p className="text-foreground text-sm font-medium">
              {consent.organizationText
                ? s.consentOrganizationTitle
                : s.consentDefaultTitle(consent.language)}
            </p>
            <p className="mt-1 text-sm whitespace-pre-line">
              {consent.organizationText ?? consent.defaultText}
            </p>
            <p className="text-muted-foreground mt-2 text-xs">
              {consent.organizationText ? s.consentInherited : s.consentDefaultHint}
            </p>
          </Inset>
        </div>
      </Panel>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" loading={action.busy}>
          {action.busy ? t.app.saving : s.saveChanges}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            guard.confirmLeave(() => {
              router.back();
            });
          }}
        >
          {t.app.cancel}
        </Button>
        <SubmitStatus count={issues.length} />
      </div>
    </ValidatedForm>
  );
}
