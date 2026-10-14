"use client";

import { MailCheckIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import {
  EmailPanel,
  emailAddressError,
  initialSmtpDraft,
  smtpDraftBody,
  smtpDraftDirty,
  smtpDraftErrors,
  type SmtpDraft,
} from "./EmailPanel";
import { LogoPanel } from "./LogoPanel";
import { Flash, useAction } from "@/components/admin/Flash";
import { useDirty } from "@/components/common/DirtyGuard";
import { SaveBarView } from "@/components/form/Form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import { displaySettingValue, settingInputKind, weightsValue } from "@/lib/admin/settingInput";
import { staffClient } from "@/lib/api/browser";
import {
  SECRET_UNCHANGED,
  type EmailTest,
  type SettingsCatalogEntry,
  type SmtpView,
} from "@/lib/api/schemas";
import { label as enumLabel, settingText, settingValueLabel } from "@/lib/i18n/enums";
import { cn } from "@/lib/utils";

const s = t.admin.settings;
const k = t.kit.settingsLayout;

export interface CategoryFormProps {
  category: string;
  title: string;
  entries: SettingsCatalogEntry[];
  /** Overrides written at this exact scope. */
  values: Record<string, unknown>;
  /** The value in force here, inherited ones included. */
  effective: Record<string, unknown>;
  secrets: Record<string, boolean>;
  /** Where each effective value came from, when the API says so. */
  sources: Record<string, string>;
  scope: string;
  scopeId: string | undefined;
  /** The platform operator may write the operator-only keys (the ceilings, D-188); nobody else. */
  operator?: boolean;
  /** The mail relay taken apart, for the email category (D-411). Absent: the plain field is shown. */
  smtp?: SmtpView | null | undefined;
}

/**
 * One settings category, submitting on its own. The payload carries only this category's
 * keys: an override that is set here (or was just edited), `null` for a key reset to the
 * inherited value, and the `__unchanged__` sentinel for a secret nobody touched.
 */
export function CategoryForm({
  category,
  title,
  entries,
  values,
  effective,
  secrets,
  sources,
  scope,
  scopeId,
  operator = false,
  smtp,
}: CategoryFormProps): React.JSX.Element {
  const router = useRouter();
  const action = useAction();
  const [edits, setEdits] = React.useState<Record<string, unknown>>({});
  const [resets, setResets] = React.useState<Record<string, true>>({});
  const [secretEdits, setSecretEdits] = React.useState<Record<string, string>>({});
  const [secretCleared, setSecretCleared] = React.useState<Record<string, true>>({});
  // The mail relay is a structured form of its own, not a row (D-410).
  const smtpPanel = category === "email" && Boolean(smtp) && entries.some((e) => e.key === "email.smtpUrl");
  const smtpInitial = React.useMemo(() => initialSmtpDraft(smtp), [smtp]);
  const [smtpDraft, setSmtpDraft] = React.useState<SmtpDraft>(smtpInitial);
  const [showSmtpErrors, setShowSmtpErrors] = React.useState(false);
  // A save refreshes the page's data: the form then shows what the server now holds.
  React.useEffect(() => {
    setSmtpDraft(smtpInitial);
  }, [smtpInitial]);
  const smtpDirty = smtpPanel && smtpDraftDirty(smtpDraft, smtpInitial);
  // Edits, resets and typed secrets are all unsaved work; leaving the category would drop them.
  const dirty =
    Object.keys(edits).length +
      Object.keys(resets).length +
      Object.keys(secretEdits).length +
      Object.keys(secretCleared).length >
      0 || smtpDirty;
  useDirty(`settings-${category}`, dirty);
  const discard = (): void => {
    setSmtpDraft(smtpInitial);
    setShowSmtpErrors(false);
    setEdits({});
    setResets({});
    setSecretEdits({});
    setSecretCleared({});
  };

  const setValue = (key: string, v: unknown): void => {
    setEdits((prev) => ({ ...prev, [key]: v }));
    setResets((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _drop, ...rest } = prev;
      return rest;
    });
  };
  const reset = (key: string): void => {
    setEdits((prev) => {
      const { [key]: _drop, ...rest } = prev;
      return rest;
    });
    setResets((prev) => ({ ...prev, [key]: true }));
  };

  const valueOf = (entry: SettingsCatalogEntry): unknown => {
    if (entry.key in edits) return edits[entry.key];
    if (entry.key in resets) return entry.default;
    if (entry.key in effective) return effective[entry.key];
    if (entry.key in values) return values[entry.key];
    return entry.default;
  };
  const isSetHere = (entry: SettingsCatalogEntry): boolean =>
    entry.key in edits || (entry.key in values && !(entry.key in resets));

  const [onlyChanged, setOnlyChanged] = React.useState(false);
  const differsFromDefault = (entry: SettingsCatalogEntry): boolean =>
    !entry.secret && JSON.stringify(valueOf(entry)) !== JSON.stringify(entry.default);
  const panelKeys = new Set(["email.smtpUrl", "email.from", "email.replyTo"]);
  const listed = smtpPanel ? entries.filter((e) => !panelKeys.has(e.key)) : entries;
  const shown = onlyChanged ? listed.filter((e) => differsFromDefault(e)) : listed;
  const changedCount = entries.filter((e) => differsFromDefault(e)).length;

  const payload = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const entry of entries) {
      const key = entry.key;
      // Sending a key the API will refuse would fail the whole save, so a read-only key is not sent.
      if (entry.operatorOnly && !operator) continue;
      if (smtpPanel && entry.key === "email.smtpUrl") {
        // Cleared when the person stopped using their own server; otherwise the form's body (sent
        // beside `values`) replaces it, and an untouched relay stays as it is.
        out[key] = smtpDraft.inherit ? null : SECRET_UNCHANGED;
        continue;
      }
      if (entry.secret) {
        if (key in secretCleared) out[key] = null;
        else if (key in secretEdits) out[key] = secretEdits[key];
        else out[key] = SECRET_UNCHANGED;
        continue;
      }
      if (key in resets) out[key] = null;
      else if (key in edits) out[key] = edits[key];
      else if (key in values) out[key] = values[key];
    }
    return out;
  };

  const emailString = (key: string): string => {
    const entry = entries.find((e) => e.key === key);
    // An unset sender is shown empty, not as the catalog's placeholder default: mail then goes out
    // from EMAIL_FROM, and showing "no-reply@example.com" said otherwise (simulation 2026-10-15).
    // `effective` carries the catalog default for a key nobody set, so that is what is compared.
    if (entry && !(key in edits) && !(key in values) && (effective[key] ?? entry.default) === entry.default)
      return "";
    const v = entry ? valueOf(entry) : "";
    return typeof v === "string" ? v : "";
  };

  const save = (): void => {
    if (smtpPanel) {
      const errs = smtpDirty && !smtpDraft.inherit ? smtpDraftErrors(smtpDraft) : {};
      const bad =
        Object.keys(errs).length > 0 ||
        emailAddressError(emailString("email.from")) !== undefined ||
        emailAddressError(emailString("email.replyTo")) !== undefined;
      if (bad) {
        setShowSmtpErrors(true);
        return;
      }
    }
    void action.run(async () => {
      const body = smtpPanel && smtpDirty && !smtpDraft.inherit ? smtpDraftBody(smtpDraft) : undefined;
      await staffClient.settings.put({ scope, ...(scopeId ? { scopeId } : {}) }, payload(), body);
      setShowSmtpErrors(false);
      setEdits({});
      setResets({});
      setSecretEdits({});
      setSecretCleared({});
      router.refresh();
    }, s.saved);
  };

  return (
    <form
      className="grid gap-4"
      aria-labelledby={`category-${category}`}
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id={`category-${category}`} className="text-lg font-semibold tracking-tight">
            {title}
          </h2>
          {smtpPanel ? null : <p className="text-muted-foreground text-xs">{k.count(entries.length)}</p>}
        </div>
        {smtpPanel && shown.length === 0 ? null : (
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={onlyChanged} onCheckedChange={setOnlyChanged} />
            {k.onlyChanged}
            <Badge variant="secondary">{changedCount}</Badge>
          </label>
        )}
      </div>
      <Flash flash={action.flash} />
      {/* The site logo is platform-wide and the operator's (D-434): only that scope shows it. */}
      {category === "branding" && scope === "platform" && operator ? <LogoPanel /> : null}
      {smtpPanel ? (
        <EmailPanel
          scope={scope}
          scopeId={scopeId}
          view={smtp}
          draft={smtpDraft}
          initial={smtpInitial}
          onDraft={setSmtpDraft}
          showErrors={showSmtpErrors}
          from={emailString("email.from")}
          replyTo={emailString("email.replyTo")}
          onFrom={(v) => {
            setValue("email.from", v);
          }}
          onReplyTo={(v) => {
            setValue("email.replyTo", v);
          }}
          allowPlain={scope === "platform"}
        />
      ) : null}
      <div
        className={cn(
          "bg-card shadow-card grid gap-0 rounded-lg",
          smtpPanel && shown.length === 0 && "hidden",
        )}
      >
        {shown.length === 0 ? (
          <p className="text-muted-foreground p-5 text-sm" role="status">
            {k.nothingChanged}
          </p>
        ) : null}
        {shown.map((entry) => (
          <SettingRow
            key={entry.key}
            entry={entry}
            changed={differsFromDefault(entry)}
            value={valueOf(entry)}
            setHere={isSetHere(entry)}
            source={sources[entry.key]}
            locked={Boolean(entry.operatorOnly) && !operator}
            secretSet={Boolean(secrets[entry.key]) && !(entry.key in secretCleared)}
            secretValue={secretEdits[entry.key] ?? ""}
            onChange={(v) => {
              setValue(entry.key, v);
            }}
            onReset={() => {
              reset(entry.key);
            }}
            onSecretChange={(v) => {
              setSecretEdits((prev) => ({ ...prev, [entry.key]: v }));
              setSecretCleared((prev) => {
                const { [entry.key]: _drop, ...rest } = prev;
                return rest;
              });
            }}
            onSecretClear={() => {
              setSecretEdits((prev) => {
                const { [entry.key]: _drop, ...rest } = prev;
                return rest;
              });
              setSecretCleared((prev) => ({ ...prev, [entry.key]: true }));
            }}
          />
        ))}
      </div>
      <SaveBarView
        dirty={dirty}
        alwaysEnabled
        submitting={action.busy}
        onDiscard={discard}
        saveLabel={s.save}
        extra={
          category === "email" && !smtpPanel ? <EmailTestButton scope={scope} scopeId={scopeId} /> : null
        }
      />
    </form>
  );
}

function EmailTestButton({
  scope,
  scopeId,
}: {
  scope: string;
  scopeId: string | undefined;
}): React.JSX.Element {
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<EmailTest | null>(null);
  const [failed, setFailed] = React.useState<string | null>(null);

  const send = (): void => {
    setBusy(true);
    setResult(null);
    setFailed(null);
    staffClient.settings
      .emailTest({ scope, ...(scopeId ? { scopeId } : {}) })
      .then(setResult)
      .catch((e: unknown) => {
        setFailed(e instanceof Error ? e.message : t.app.unknownError);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const usedScope = result?.usedScope ?? "";
  const scopeLabel =
    usedScope === "tenant" || usedScope === "platform" || usedScope === "env"
      ? s.email.usedScopes[usedScope]
      : usedScope;

  return (
    <>
      <Button type="button" variant="outline" disabled={busy} onClick={send}>
        <MailCheckIcon /> {busy ? s.email.sending : s.email.test}
      </Button>
      {failed !== null || (result && !result.ok) ? (
        <span className="text-destructive text-xs" role="status">
          {s.email.failed(failed ?? result?.error ?? t.app.unknownError)}
        </span>
      ) : result?.ok ? (
        <span className="text-xs text-emerald-700" role="status">
          {s.email.sent(scopeLabel)}
        </span>
      ) : null}
    </>
  );
}

function SettingRow({
  entry,
  changed,
  value,
  setHere,
  source,
  locked,
  secretSet,
  secretValue,
  onChange,
  onReset,
  onSecretChange,
  onSecretClear,
}: {
  entry: SettingsCatalogEntry;
  /** The value in force differs from the catalog's default (D-394). */
  changed: boolean;
  value: unknown;
  setHere: boolean;
  source: string | undefined;
  /** Written only by the platform operator, and the viewer is not: shown, not editable. */
  locked: boolean;
  secretSet: boolean;
  secretValue: string;
  onChange: (v: unknown) => void;
  onReset: () => void;
  onSecretChange: (v: string) => void;
  onSecretClear: () => void;
}): React.JSX.Element {
  const id = `setting-${entry.key.replace(/\./g, "-")}`;
  const kind = settingInputKind(entry.key, entry.default, entry.secret);
  const text = settingText(entry.key);
  const label = text?.label ?? entry.key;

  let control: React.ReactNode;
  switch (kind.kind) {
    case "secret":
      control = (
        <div className="grid gap-2">
          <Input
            id={id}
            type="password"
            autoComplete="new-password"
            placeholder={secretSet ? s.secret.keepPlaceholder : s.secret.setPlaceholder}
            value={secretValue}
            aria-describedby={`${id}-desc`}
            onChange={(e) => {
              onSecretChange(e.target.value);
            }}
          />
          <div>
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs"
              disabled={!secretSet}
              onClick={onSecretClear}
            >
              {s.secret.clear}
            </Button>
          </div>
        </div>
      );
      break;
    case "boolean":
      control = (
        <Switch
          id={id}
          checked={Boolean(value)}
          onCheckedChange={(v) => {
            onChange(v);
          }}
          aria-describedby={`${id}-desc`}
        />
      );
      break;
    case "number":
      control = (
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          className="max-w-48"
          value={typeof value === "number" ? value : ""}
          min={kind.min}
          max={kind.max}
          step={kind.integer ? 1 : "any"}
          aria-describedby={`${id}-desc`}
          onChange={(e) => {
            onChange(e.target.value === "" ? entry.default : Number(e.target.value));
          }}
        />
      );
      break;
    case "weights": {
      const current = weightsValue(value, kind.keys);
      control = (
        <div className="grid gap-2 sm:grid-cols-2">
          {kind.keys.map((k) => (
            <div key={k} className="grid gap-1">
              <Label htmlFor={`${id}-${k}`} className="text-xs font-normal">
                {enumLabel("factor", k)}
              </Label>
              <Input
                id={`${id}-${k}`}
                type="number"
                inputMode="decimal"
                step="any"
                min={kind.min}
                max={kind.max}
                value={current[k] ?? 1}
                onChange={(e) => {
                  onChange({ ...current, [k]: e.target.value === "" ? 0 : Number(e.target.value) });
                }}
              />
            </div>
          ))}
        </div>
      );
      break;
    }
    case "enum":
      control = (
        <Select
          value={String(value)}
          onValueChange={(v) => {
            onChange(v);
          }}
        >
          <SelectTrigger id={id} className="max-w-72" aria-describedby={`${id}-desc`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {kind.values.map((v) => (
              <SelectItem key={v} value={v}>
                {settingValueLabel(entry.key, v)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
      break;
    case "list":
      control = (
        <Textarea
          id={id}
          rows={3}
          value={Array.isArray(value) ? value.map(String).join("\n") : ""}
          aria-describedby={`${id}-desc ${id}-hint`}
          onChange={(e) => {
            onChange(
              e.target.value
                .split("\n")
                .map((l) => l.trim())
                .filter(Boolean),
            );
          }}
        />
      );
      break;
    case "color":
      control = (
        <div className="flex items-center gap-2">
          <Input
            id={id}
            type="color"
            className="h-10 w-14 p-1"
            value={String(value)}
            aria-describedby={`${id}-desc`}
            onChange={(e) => {
              onChange(e.target.value);
            }}
          />
          <Input
            aria-label={label}
            className="max-w-32 font-mono"
            value={String(value)}
            onChange={(e) => {
              onChange(e.target.value);
            }}
          />
        </div>
      );
      break;
    default:
      control =
        typeof entry.default === "string" && entry.default.length > 80 ? (
          <Textarea
            id={id}
            rows={3}
            value={String(value)}
            aria-describedby={`${id}-desc`}
            onChange={(e) => {
              onChange(e.target.value);
            }}
          />
        ) : (
          <Input
            id={id}
            value={String(value)}
            aria-describedby={`${id}-desc`}
            onChange={(e) => {
              onChange(e.target.value);
            }}
          />
        );
  }

  const originBadge = locked ? (
    <Badge variant="outline">{s.operatorOnly}</Badge>
  ) : entry.secret ? (
    <Badge variant={secretSet ? "success" : "outline"}>{secretSet ? s.secret.set : s.secret.notSet}</Badge>
  ) : setHere ? (
    <Badge variant="secondary">{s.setHere}</Badge>
  ) : (
    <Badge variant="outline">{source ? s.inheritedFrom(source) : s.inherited}</Badge>
  );

  return (
    <div
      id={`${id}-row`}
      data-changed={changed || undefined}
      className={cn(
        "grid scroll-mt-24 gap-2 border-b border-l-2 border-l-transparent px-4 py-4 first:rounded-t-lg last:rounded-b-lg last:border-b-0 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] md:gap-6 md:px-5",
        changed && "border-l-primary bg-accent/20",
      )}
    >
      <div className="grid content-start gap-1">
        <Label htmlFor={id} className="flex flex-wrap items-center gap-2">
          {label}
          {changed ? (
            <span className="text-primary inline-flex items-center gap-1 text-xs font-medium">
              <span aria-hidden="true" className="bg-primary size-1.5 rounded-full" />
              {k.changedMarker}
            </span>
          ) : null}
          <span className="text-muted-foreground font-mono text-xs font-normal break-all">{entry.key}</span>
          {originBadge}
        </Label>
        <p id={`${id}-desc`} className="text-muted-foreground text-xs">
          {text?.description ?? entry.description}
        </p>
        {entry.secret ? (
          <p className="text-muted-foreground text-xs">{s.secret.hint}</p>
        ) : (
          <p className="text-muted-foreground text-xs">
            {s.default(displaySettingValue(entry.default) || t.app.none)}
          </p>
        )}
        {kind.kind === "list" ? (
          <p id={`${id}-hint`} className="text-muted-foreground text-xs">
            {s.listHint}
          </p>
        ) : null}
      </div>
      <div className="grid gap-2">
        {locked ? (
          <p id={id} tabIndex={-1} className="text-sm tabular-nums">
            {displaySettingValue(value) || t.app.none}
            <span className="text-muted-foreground block text-xs">{s.operatorOnlyHint}</span>
          </p>
        ) : (
          control
        )}
        {!entry.secret && setHere && !locked ? (
          <div>
            <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" onClick={onReset}>
              {s.reset}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
