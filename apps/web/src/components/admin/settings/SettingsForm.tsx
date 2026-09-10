"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { Flash, useAction } from "@/components/admin/Flash";
import { FormSection } from "@/components/admin/forms";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import { displaySettingValue, settingInputKind } from "@/lib/admin/settingInput";
import { staffClient } from "@/lib/api/browser";
import type { SettingsCatalogEntry, SettingsResponse } from "@/lib/api/schemas";
import { humanize } from "@/lib/utils";

const s = t.admin.settings;
const CATEGORY_LABELS: Record<string, string> = s.categories;
const CATEGORY_ORDER = Object.keys(s.categories);

export function SettingsForm({
  data,
  scope,
  scopeId,
}: {
  data: SettingsResponse;
  scope: string;
  scopeId: string | undefined;
}): React.JSX.Element {
  const router = useRouter();
  const action = useAction();
  const [values, setValues] = React.useState<Record<string, unknown>>(data.values);
  const catalog = data.catalog.filter((c) => c.scopes.length === 0 || c.scopes.includes(scope));
  const grouped = new Map<string, SettingsCatalogEntry[]>();
  for (const c of catalog) {
    const list = grouped.get(c.category) ?? [];
    list.push(c);
    grouped.set(c.category, list);
  }
  const categories = [...grouped.keys()].sort((a, b) => {
    const ia = CATEGORY_ORDER.indexOf(a);
    const ib = CATEGORY_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  const set = (key: string, v: unknown): void => {
    setValues((prev) => ({ ...prev, [key]: v }));
  };
  const reset = (key: string): void => {
    setValues((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== key)));
  };

  const save = (): void => {
    void action.run(async () => {
      await staffClient.settings.put({ scope, ...(scopeId ? { scopeId } : {}) }, values);
      router.refresh();
    }, s.saved);
  };

  if (catalog.length === 0) return <p className="text-muted-foreground text-sm">{s.empty}</p>;

  return (
    <form
      className="grid gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <Flash flash={action.flash} />
      {categories.map((cat) => (
        <FormSection key={cat} title={CATEGORY_LABELS[cat] ?? humanize(cat)}>
          {(grouped.get(cat) ?? []).map((entry) => (
            <SettingRow
              key={entry.key}
              entry={entry}
              value={values[entry.key]}
              overridden={entry.key in values}
              onChange={(v) => {
                set(entry.key, v);
              }}
              onReset={() => {
                reset(entry.key);
              }}
            />
          ))}
        </FormSection>
      ))}
      <div>
        <Button type="submit" disabled={action.busy}>
          {action.busy ? t.app.saving : s.save}
        </Button>
      </div>
    </form>
  );
}

function SettingRow({
  entry,
  value,
  overridden,
  onChange,
  onReset,
}: {
  entry: SettingsCatalogEntry;
  value: unknown;
  overridden: boolean;
  onChange: (v: unknown) => void;
  onReset: () => void;
}): React.JSX.Element {
  const id = `setting-${entry.key.replace(/\./g, "-")}`;
  const kind = settingInputKind(entry.key, entry.default);
  const effective = overridden ? value : entry.default;
  const label = humanize(entry.key.split(".").slice(1).join(" ") || entry.key);

  let control: React.ReactNode;
  switch (kind.kind) {
    case "boolean":
      control = (
        <Switch
          id={id}
          checked={Boolean(effective)}
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
          value={typeof effective === "number" ? effective : ""}
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
    case "enum":
      control = (
        <Select
          value={String(effective)}
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
                {humanize(v)}
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
          value={Array.isArray(effective) ? effective.map(String).join("\n") : ""}
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
            value={String(effective)}
            aria-describedby={`${id}-desc`}
            onChange={(e) => {
              onChange(e.target.value);
            }}
          />
          <Input
            aria-label={label}
            className="max-w-32 font-mono"
            value={String(effective)}
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
            value={String(effective)}
            aria-describedby={`${id}-desc`}
            onChange={(e) => {
              onChange(e.target.value);
            }}
          />
        ) : (
          <Input
            id={id}
            value={String(effective)}
            aria-describedby={`${id}-desc`}
            onChange={(e) => {
              onChange(e.target.value);
            }}
          />
        );
  }

  return (
    <div className="grid gap-2 border-b pb-4 last:border-0 last:pb-0 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] md:gap-6">
      <div className="grid gap-1">
        <Label htmlFor={id} className="flex flex-wrap items-center gap-2">
          {label}
          <span className="text-muted-foreground font-mono text-[11px] font-normal">{entry.key}</span>
          {overridden ? <Badge variant="secondary">{s.overridden}</Badge> : null}
        </Label>
        <p id={`${id}-desc`} className="text-muted-foreground text-xs">
          {entry.description}
        </p>
        <p className="text-muted-foreground text-xs">
          {s.default(displaySettingValue(entry.default) || t.app.none)}
        </p>
        {kind.kind === "list" ? (
          <p id={`${id}-hint`} className="text-muted-foreground text-xs">
            {s.listHint}
          </p>
        ) : null}
      </div>
      <div className="grid gap-2">
        {control}
        {overridden ? (
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
