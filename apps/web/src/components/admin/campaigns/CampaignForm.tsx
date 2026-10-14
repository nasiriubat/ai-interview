"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { z } from "zod";
import { ComboboxField, NumberField, SelectField, TextField } from "@/components/admin/forms";
import { useDirtyGuard } from "@/components/common/DirtyGuard";
import { Form, FormSection } from "@/components/form/Form";
import { useForm } from "@/components/form/useForm";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import type { TemplateListItem } from "@/lib/api/schemas";
import type { CampaignCreateInput } from "@/lib/api/staff";

const s = t.admin.campaigns;
const PARTICIPATION = ["identified", "anonymous", "participant_choice"] as const;
const VERIFICATION = ["invitation", "email_code", "open"] as const;

/** An empty number field; typed so the form values are `number | ""`, not `string`. */
const NONE: number | "" = "";

const schema = z.object({
  templateId: z.string().min(1),
  name: z.string().trim().min(1),
  participationMode: z.string(),
  verification: z.string(),
  domains: z.string(),
  maxTurns: z.union([z.literal(""), z.number().int().min(5).max(500)]),
  threshold: z.union([z.literal(""), z.number().int().min(1)]),
  expiresAt: z.string(),
});

/** Creates a campaign (D-362): the template and name are required, every other field starts from the settings. */
export function CampaignForm({
  templates,
  defaultVerification,
}: {
  templates: TemplateListItem[];
  /** The organization's `campaign.verification`, so "Use default" can say what it is. */
  defaultVerification?: string | undefined;
}): React.JSX.Element {
  const router = useRouter();
  const guard = useDirtyGuard();
  const form = useForm({
    id: "campaign-form",
    initial: {
      templateId: templates[0]?.id ?? "",
      name: "",
      participationMode: "",
      verification: "",
      domains: "",
      maxTurns: NONE,
      threshold: NONE,
      expiresAt: "",
    },
    schema,
    labels: {
      templateId: s.template,
      name: s.name,
      participationMode: s.participationMode,
      verification: s.verification,
      domains: s.allowedDomains,
      maxTurns: s.maxTurns,
      threshold: s.completionThreshold,
      expiresAt: s.expiresAt,
    },
    savedText: s.createdToast,
    onSubmit: async (v) => {
      const input: CampaignCreateInput = {
        templateId: v.templateId,
        name: v.name.trim(),
        ...(v.participationMode ? { participationMode: v.participationMode } : {}),
        ...(v.verification ? { verification: v.verification } : {}),
        ...(v.domains.trim()
          ? {
              allowedEmailDomains: v.domains
                .split(",")
                .map((d) => d.trim())
                .filter(Boolean),
            }
          : {}),
        ...(v.maxTurns !== "" ? { maxTurns: v.maxTurns } : {}),
        ...(v.threshold !== "" ? { completionThreshold: v.threshold } : {}),
        ...(v.expiresAt ? { expiresAt: new Date(v.expiresAt).toISOString() } : {}),
      };
      const created = await staffClient.campaigns.create(input);
      guard.setDirty("campaign-form", false);
      router.push(`/admin/campaigns/${created.id}`);
      router.refresh();
    },
  });

  // "Use default" said nothing about what the default is (simulation 2026-10-15): name it.
  const chosen = templates.find((tpl) => tpl.id === form.values.templateId);
  const privacy = t.admin.templates.fields.privacy as Record<string, string>;
  const modeDefault = chosen?.privacyMode ? privacy[chosen.privacyMode] : undefined;
  const verificationNames = s.verificationOptions as Record<string, string>;
  const verificationDefault = defaultVerification ? verificationNames[defaultVerification] : undefined;

  return (
    <Form form={form} className="max-w-3xl" saveLabel={s.createButton} alwaysEnabled>
      <FormSection id="basics" title={s.createTitle}>
        <ComboboxField
          {...form.field("templateId")}
          label={s.template}
          required
          options={templates.map((tpl) => ({
            value: tpl.id,
            label: `${tpl.name} (v${tpl.version})`,
            detail: tpl.key,
          }))}
          labels={{
            placeholder: t.admin.combobox.select,
            search: t.admin.combobox.search,
            empty: t.admin.combobox.empty,
          }}
        />
        <TextField {...form.field("name")} label={s.name} required />
      </FormSection>
      <FormSection id="access" title={s.accessTitle}>
        <div className="grid gap-4 md:grid-cols-2">
          <SelectField
            {...form.field("participationMode")}
            label={s.participationMode}
            hint={s.participationHint}
            placeholder={modeDefault ? s.useTemplateDefault(modeDefault) : s.useDefault}
            options={PARTICIPATION.map((v) => ({ value: v, label: t.admin.templates.fields.privacy[v] }))}
          />
          <SelectField
            {...form.field("verification")}
            label={s.verification}
            hint={s.verificationHint}
            placeholder={verificationDefault ? s.useDefaultNamed(verificationDefault) : s.useDefault}
            options={VERIFICATION.map((v) => ({ value: v, label: s.verificationOptions[v] }))}
          />
        </div>
        <TextField
          {...form.field("domains")}
          label={s.allowedDomains}
          hint={s.domainsHint}
          placeholder="company.com, subsidiary.com"
        />
      </FormSection>
      <FormSection id="limits" title={s.limitsTitle}>
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
      </FormSection>
    </Form>
  );
}
