"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { Flash, useAction } from "@/components/admin/Flash";
import {
  ComboboxField,
  NumberField,
  SelectField,
  SubmitStatus,
  TextField,
  ValidatedForm,
} from "@/components/admin/forms";
import { useDirty, useDirtyGuard } from "@/components/common/DirtyGuard";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { type FormIssue } from "@/lib/admin/validation";
import { staffClient } from "@/lib/api/browser";
import type { TemplateListItem } from "@/lib/api/schemas";
import type { CampaignCreateInput } from "@/lib/api/staff";

const s = t.admin.campaigns;
const PARTICIPATION = ["identified", "anonymous", "participant_choice"] as const;
const VERIFICATION = ["invitation", "email_code", "open"] as const;

export function CampaignForm({ templates }: { templates: TemplateListItem[] }): React.JSX.Element {
  const router = useRouter();
  const action = useAction();
  const [templateId, setTemplateId] = React.useState<string>(templates[0]?.id ?? "");
  const [name, setName] = React.useState("");
  const [participationMode, setParticipationMode] = React.useState<(typeof PARTICIPATION)[number] | "">("");
  const [verification, setVerification] = React.useState<(typeof VERIFICATION)[number] | "">("");
  const [domains, setDomains] = React.useState("");
  const [maxTurns, setMaxTurns] = React.useState<number | "">("");
  const [threshold, setThreshold] = React.useState<number | "">("");
  const [expiresAt, setExpiresAt] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [issues, setIssues] = React.useState<FormIssue[]>([]);
  const [attempt, setAttempt] = React.useState(0);
  const guard = useDirtyGuard();
  const firstTemplate = templates[0]?.id ?? "";
  useDirty(
    "campaign-form",
    name !== "" ||
      templateId !== firstTemplate ||
      participationMode !== "" ||
      verification !== "" ||
      domains !== "" ||
      maxTurns !== "" ||
      threshold !== "" ||
      expiresAt !== "",
  );

  const submit = (): void => {
    const errs: Record<string, string> = {};
    const found: FormIssue[] = [];
    if (!templateId) {
      errs.templateId = t.admin.form.required;
      found.push({ id: "templateId", label: s.template, message: t.admin.form.required });
    }
    if (!name.trim()) {
      errs.name = t.admin.form.required;
      found.push({ id: "name", label: s.name, message: t.admin.form.required });
    }
    setErrors(errs);
    setIssues(found);
    if (found.length > 0) {
      setAttempt((n) => n + 1);
      return;
    }
    const input: CampaignCreateInput = {
      templateId,
      name: name.trim(),
      ...(participationMode ? { participationMode } : {}),
      ...(verification ? { verification } : {}),
      ...(domains.trim()
        ? {
            allowedEmailDomains: domains
              .split(",")
              .map((d) => d.trim())
              .filter(Boolean),
          }
        : {}),
      ...(maxTurns !== "" ? { maxTurns } : {}),
      ...(threshold !== "" ? { completionThreshold: threshold } : {}),
      ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
    };
    void action.run(async () => {
      const created = await staffClient.campaigns.create(input);
      router.push(`/admin/campaigns/${created.id}`);
      router.refresh();
    });
  };

  return (
    <ValidatedForm className="grid max-w-2xl gap-4" onSubmit={submit} issues={issues} attempt={attempt}>
      <Flash flash={action.flash} />
      <ComboboxField
        id="templateId"
        label={s.template}
        value={templateId}
        error={errors.templateId}
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
        onChange={setTemplateId}
      />
      <TextField id="name" label={s.name} value={name} error={errors.name} required onChange={setName} />
      <div className="grid gap-4 md:grid-cols-2">
        <SelectField
          id="participationMode"
          label={s.participationMode}
          value={participationMode}
          placeholder={s.useDefault}
          options={PARTICIPATION.map((v) => ({ value: v, label: t.admin.templates.fields.privacy[v] }))}
          onChange={setParticipationMode}
        />
        <SelectField
          id="verification"
          label={s.verification}
          value={verification}
          placeholder={s.useDefault}
          options={VERIFICATION.map((v) => ({ value: v, label: s.verificationOptions[v] }))}
          onChange={setVerification}
        />
      </div>
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
          onChange={setMaxTurns}
        />
        <NumberField
          id="threshold"
          label={s.completionThreshold}
          value={threshold}
          min={1}
          onChange={setThreshold}
        />
        <TextField
          id="expiresAt"
          label={s.expiresAt}
          type="datetime-local"
          value={expiresAt}
          onChange={setExpiresAt}
        />
      </div>
      <div className="flex gap-2">
        <Button type="submit" loading={action.busy}>
          {action.busy ? t.app.saving : s.createButton}
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
