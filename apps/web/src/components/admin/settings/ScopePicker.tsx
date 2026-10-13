"use client";

import * as React from "react";
import { useDirtyGuard } from "@/components/common/DirtyGuard";
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

/**
 * Which level of the settings hierarchy the page shows. There is no Open button: choosing a level
 * that stands alone, or a target for one that needs it, navigates at once (D-113). Template and
 * campaign settings have nothing to show until a target is chosen, so the page says so (see the
 * settings page) rather than falling back to the tenant's values under another scope's name.
 *
 * Navigation goes through the dirty guard, so unsaved edits are asked about, not dropped.
 */
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
  const guard = useDirtyGuard();
  const s = t.admin.settings;
  const [nextScope, setNextScope] = React.useState<Scope>(isScope(scope) ? scope : "tenant");
  const [nextId, setNextId] = React.useState(scopeId);
  const [targets, setTargets] = React.useState<ComboboxOption[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [announcement, setAnnouncement] = React.useState("");
  const wanted = needsTarget(nextScope, allowPlatform);

  // The URL is the source of truth: back/forward and the category links change it from outside.
  React.useEffect(() => {
    setNextScope(isScope(scope) ? scope : "tenant");
    setNextId(scopeId);
  }, [scope, scopeId]);

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

  const go = (toScope: Scope, toId: string, announce: string): void => {
    const params = new URLSearchParams({ ...extraParams, scope: toScope });
    if (toId) params.set("scopeId", toId);
    setAnnouncement(announce);
    guard.navigate(`${basePath}?${params.toString()}`);
  };

  return (
    <div role="group" aria-label={s.scope} className="mb-6 grid gap-3 sm:flex sm:flex-wrap sm:items-end">
      <div className="grid gap-1.5">
        <Label htmlFor="scope">{s.scope}</Label>
        <Select
          value={nextScope}
          onValueChange={(v) => {
            if (!isScope(v) || v === nextScope) return;
            setNextScope(v);
            setNextId("");
            // Template and campaign have no values until a target is chosen: the page then shows an
            // instruction instead of the tenant's values under another scope's name.
            go(
              v,
              "",
              v === "template" || v === "campaign"
                ? t.admin.form.scopeInstruction(s.scopes[v].toLowerCase())
                : t.admin.form.scopeShowing(s.scopes[v]),
            );
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
            onChange={(id) => {
              setNextId(id);
              if (!id) return;
              const label = targets.find((x) => x.value === id)?.label ?? id;
              go(nextScope, id, t.admin.form.scopeShowing(label));
            }}
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
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}
