"use client";

import type { Path } from "@aidp/shared";
import { useRouter } from "next/navigation";
import * as React from "react";
import { Flash, useAction } from "@/components/admin/Flash";
import {
  ComboboxField,
  SelectField,
  SubmitStatus,
  TextAreaField,
  TextField,
  ValidatedForm,
} from "@/components/admin/forms";
import { useDirty, useDirtyGuard } from "@/components/common/DirtyGuard";
import { PathChoice } from "@/components/participant/PathChoice";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/LocaleProvider";
import { type FormIssue } from "@/lib/admin/validation";
import { staffClient } from "@/lib/api/browser";
import type { TemplateListItem } from "@/lib/api/schemas";
import type { RequirementsCreateInput } from "@/lib/api/staff";

const LANGUAGES = ["en", "fi"] as const;

/** The "new requirements session" form: title, starting prompt, path, template and language. */
export function RequirementsForm({ templates }: { templates: TemplateListItem[] }): React.JSX.Element {
  const s = t.admin.requirements.create;
  const router = useRouter();
  const locale = useLocale();
  const action = useAction();
  const [title, setTitle] = React.useState("");
  const [prompt, setPrompt] = React.useState("");
  const [path, setPath] = React.useState<Path | undefined>(undefined);
  const [templateId, setTemplateId] = React.useState<string>(templates[0]?.id ?? "");
  const [language, setLanguage] = React.useState<(typeof LANGUAGES)[number]>(locale);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [issues, setIssues] = React.useState<FormIssue[]>([]);
  const [attempt, setAttempt] = React.useState(0);
  const guard = useDirtyGuard();
  useDirty("requirements-form", title !== "" || prompt !== "" || path !== undefined);

  const submit = (): void => {
    const errs: Record<string, string> = {};
    const found: FormIssue[] = [];
    if (!title.trim()) {
      errs.title = t.admin.form.required;
      found.push({ id: "title", label: s.titleField, message: t.admin.form.required });
    }
    if (!path) {
      errs.path = t.admin.form.required;
      found.push({ id: "path", label: s.pathField, message: t.admin.form.required });
    }
    setErrors(errs);
    setIssues(found);
    if (found.length > 0 || !path) {
      setAttempt((n) => n + 1);
      return;
    }
    const input: RequirementsCreateInput = {
      title: title.trim(),
      path,
      language,
      ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
      ...(templateId ? { templateId } : {}),
    };
    void action.run(async () => {
      const created = await staffClient.requirements.create(input);
      router.push(`/admin/requirements/${created.id}`);
      router.refresh();
    });
  };

  return (
    <ValidatedForm className="grid max-w-2xl gap-5" onSubmit={submit} issues={issues} attempt={attempt}>
      <Flash flash={action.flash} />
      <TextField
        id="title"
        label={s.titleField}
        value={title}
        error={errors.title}
        required
        onChange={setTitle}
      />
      <TextAreaField
        id="prompt"
        label={s.promptField}
        hint={s.promptHint}
        value={prompt}
        rows={4}
        onChange={setPrompt}
      />
      <fieldset
        id="path"
        tabIndex={-1}
        data-invalid={errors.path ? "true" : undefined}
        aria-describedby={errors.path ? "path-error" : undefined}
        className="grid gap-2"
      >
        <legend className="mb-1 text-sm font-medium">
          {s.pathField}
          <span aria-hidden="true" className="text-destructive">
            *
          </span>
        </legend>
        <PathChoice value={path} onChoose={setPath} compact />
        {errors.path ? (
          <p id="path-error" className="text-destructive text-xs">
            {errors.path}
          </p>
        ) : null}
      </fieldset>
      <div className="grid gap-4 md:grid-cols-2">
        {templates.length > 0 ? (
          <ComboboxField
            id="templateId"
            label={s.templateField}
            hint={s.templateHint}
            value={templateId}
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
        ) : (
          <p className="text-muted-foreground self-end text-xs">{s.noTemplates}</p>
        )}
        <SelectField
          id="language"
          label={s.languageField}
          value={language}
          required
          options={LANGUAGES.map((l) => ({ value: l, label: t.app.languageNames[l] }))}
          onChange={setLanguage}
        />
      </div>
      <div className="flex gap-2">
        <Button type="submit" loading={action.busy}>
          {action.busy ? s.starting : s.submit}
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
