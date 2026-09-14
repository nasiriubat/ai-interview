"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import type { ScopeKind } from "@/lib/api/staff";

const SCOPES = ["tenant", "template", "campaign", "platform"] as const;
type Scope = (typeof SCOPES)[number];

function isScope(v: string): v is Scope {
  return (SCOPES as readonly string[]).includes(v);
}

/** Scopes whose target is chosen from `GET /settings/scopes` rather than typed (contract 19). */
function needsTarget(scope: Scope, allowPlatform: boolean): scope is ScopeKind {
  if (scope === "template" || scope === "campaign") return true;
  return scope === "tenant" && allowPlatform;
}

export function ScopePicker({
  scope,
  scopeId,
  allowPlatform,
  basePath = "/admin/settings",
  extraParams,
}: {
  scope: string;
  scopeId: string;
  allowPlatform: boolean;
  basePath?: string;
  /** Query parameters to carry across, e.g. the selected settings category. */
  extraParams?: Record<string, string>;
}): React.JSX.Element {
  const router = useRouter();
  const s = t.admin.settings;
  const [nextScope, setNextScope] = React.useState<Scope>(isScope(scope) ? scope : "tenant");
  const [nextId, setNextId] = React.useState(scopeId);
  const [targets, setTargets] = React.useState<ComboboxOption[]>([]);
  const [loading, setLoading] = React.useState(false);
  const wanted = needsTarget(nextScope, allowPlatform);

  React.useEffect(() => {
    if (!needsTarget(nextScope, allowPlatform)) {
      setTargets([]);
      return;
    }
    let live = true;
    setLoading(true);
    staffClient.settings
      .scopes(nextScope)
      .then((list) => {
        if (!live) return;
        setTargets(
          list.map((target) => ({
            value: target.id,
            label: target.name || target.id,
            detail: target.detail ?? target.id,
          })),
        );
      })
      .catch(() => {
        if (live) setTargets([]);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [nextScope, allowPlatform]);

  return (
    <form
      className="mb-6 grid gap-3 sm:flex sm:flex-wrap sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        const params = new URLSearchParams({ ...extraParams, scope: nextScope });
        if (wanted && nextId) params.set("scopeId", nextId);
        router.push(`${basePath}?${params.toString()}`);
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="scope">{s.scope}</Label>
        <Select
          value={nextScope}
          onValueChange={(v) => {
            if (isScope(v)) {
              setNextScope(v);
              setNextId("");
            }
          }}
        >
          <SelectTrigger id="scope" className="w-full sm:w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SCOPES.filter((sc) => sc !== "platform" || allowPlatform).map((sc) => (
              <SelectItem key={sc} value={sc}>
                {s.scopes[sc]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {wanted ? (
        <div className="grid gap-1.5 sm:w-72">
          <Label htmlFor="scopeTarget">{s.scopeTarget}</Label>
          <Combobox
            id="scopeTarget"
            value={nextId}
            onChange={setNextId}
            options={targets}
            loading={loading}
            labels={{
              placeholder: s.scopeTargetPlaceholder,
              search: t.admin.combobox.search,
              empty: s.noTargets,
              loading: t.admin.combobox.loading,
            }}
          />
        </div>
      ) : null}
      <Button type="submit" variant="outline" disabled={wanted && !nextId && nextScope !== "tenant"}>
        {t.app.open}
      </Button>
    </form>
  );
}
