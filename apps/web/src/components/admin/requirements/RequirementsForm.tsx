"use client";

import type { Path } from "@aidp/shared";
import { FileTextIcon, XIcon } from "lucide-react";
import Link from "next/link";
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
import { IconButton } from "@/components/admin/IconButton";
import { useDirty, useDirtyGuard } from "@/components/common/DirtyGuard";
import { PathChoice } from "@/components/participant/PathChoice";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/LocaleProvider";
import { type FormIssue } from "@/lib/admin/validation";
import { staffClient } from "@/lib/api/browser";
import type { TemplateListItem } from "@/lib/api/schemas";
import type { RequirementsCreateInput } from "@/lib/api/staff";
import {
  acceptFor,
  DEFAULT_ALLOWED_TYPES,
  DEFAULT_MAX_SIZE_MB,
  formatBytes,
  isAllowedAttachment,
  isTooLarge,
} from "@/lib/attachments";

const LANGUAGES = ["en", "fi"] as const;

/** The "new requirements session" form: title, starting prompt, path, template and language. */
export function RequirementsForm({ templates }: { templates: TemplateListItem[] }): React.JSX.Element {
  const s = t.admin.requirements.create;
  const router = useRouter();
  const locale = useLocale();
  const action = useAction();
  const [title, setTitle] = React.useState("");
  const [prompt, setPrompt] = React.useState("");
  // Documents to start from (D-490): attached right after the interview is created, then read
  // before its first question. Checked here against the shipped limits; the server has the final say.
  const [documents, setDocuments] = React.useState<File[]>([]);
  const [documentError, setDocumentError] = React.useState<string | null>(null);
  // An interview that was created but some of whose documents were refused: the owner is told,
  // and goes on to it rather than creating a second one by submitting again.
  const [createdId, setCreatedId] = React.useState<string | null>(null);
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
      const refused: string[] = [];
      for (const file of documents) {
        try {
          await staffClient.requirements.attachments.upload(created.id, file);
        } catch {
          refused.push(file.name);
        }
      }
      if (refused.length > 0) {
        setCreatedId(created.id);
        throw new Error(s.documentsRefused(refused.join(", ")));
      }
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
      <div className="grid gap-1.5">
        <Label htmlFor="documents">{s.documentsField}</Label>
        <p id="documents-hint" className="text-muted-foreground text-[13px] leading-snug">
          {s.documentsHint}
        </p>
        <input
          id="documents"
          type="file"
          multiple
          accept={acceptFor(DEFAULT_ALLOWED_TYPES)}
          aria-describedby="documents-hint"
          className="file:bg-muted file:text-foreground text-muted-foreground text-sm file:mr-3 file:rounded-md file:border-0 file:px-3 file:py-1.5 file:text-sm file:font-medium"
          onChange={(e) => {
            const picked = [...(e.target.files ?? [])];
            e.target.value = "";
            const ok = picked.filter(
              (f) => isAllowedAttachment(f, DEFAULT_ALLOWED_TYPES) && !isTooLarge(f, DEFAULT_MAX_SIZE_MB),
            );
            setDocumentError(ok.length < picked.length ? s.documentsRejected(DEFAULT_MAX_SIZE_MB) : null);
            setDocuments((prev) => [...prev, ...ok].slice(0, 10));
          }}
        />
        {documentError ? <p className="text-destructive text-[13px]">{documentError}</p> : null}
        {documents.length > 0 ? (
          <ul className="grid gap-1">
            {documents.map((f, i) => (
              <li
                key={`${f.name}-${String(i)}`}
                className="bg-muted/60 flex items-center gap-2 rounded-md px-3 py-1.5 text-sm"
              >
                <FileTextIcon className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                  {formatBytes(f.size)}
                </span>
                <IconButton
                  label={s.documentsRemove(f.name)}
                  icon={<XIcon />}
                  onClick={() => {
                    setDocuments((prev) => prev.filter((_, j) => j !== i));
                  }}
                />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
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
      {createdId ? (
        <Button asChild variant="outline" className="justify-self-start">
          <Link href={`/admin/requirements/${createdId}`}>{s.documentsContinue}</Link>
        </Button>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" loading={action.busy} disabled={createdId !== null}>
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
