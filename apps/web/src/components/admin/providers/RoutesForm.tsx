"use client";

import { PURPOSES, type Effort, type Purpose, type Route } from "@aidp/shared";
import { useRouter } from "next/navigation";
import * as React from "react";
import { providersApiFor, type ProviderScope } from "./ProvidersPanel";
import { Flash, useAction } from "@/components/admin/Flash";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import type { ModelPrice, Provider, RouteRecord } from "@/lib/api/schemas";
import { humanize } from "@/lib/utils";

const s = t.admin.routes;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const INHERIT = "__inherit__";

interface Draft {
  providerId: string;
  model: string;
  effort: Effort | "";
  maxOutputTokens: number | "";
  batchAllowed: boolean;
}

function draftFrom(r: RouteRecord | undefined): Draft {
  return r
    ? {
        providerId: r.providerId,
        model: r.model,
        effort: r.effort ?? "",
        maxOutputTokens: r.maxOutputTokens,
        batchAllowed: r.batchAllowed,
      }
    : { providerId: "", model: "", effort: "", maxOutputTokens: "", batchAllowed: false };
}

/** One row per purpose. Empty provider means "inherit the platform default" for tenants. */
export function RoutesForm({
  routes,
  providers,
  scope,
  companyId,
}: {
  routes: RouteRecord[];
  providers: Provider[];
  scope: ProviderScope;
  companyId: string | null;
}): React.JSX.Element {
  const router = useRouter();
  const action = useAction();
  const api = providersApiFor(scope);
  const [drafts, setDrafts] = React.useState<Record<Purpose, Draft>>(() => {
    const out = {} as Record<Purpose, Draft>;
    for (const p of PURPOSES) {
      const own = routes.find(
        (r) => r.purpose === p && (scope === "platform" ? r.companyId === null : r.companyId !== null),
      );
      out[p] = draftFrom(own ?? (scope === "platform" ? routes.find((r) => r.purpose === p) : undefined));
    }
    return out;
  });
  const [models, setModels] = React.useState<Record<string, ModelPrice[]>>({});

  const loadModels = React.useCallback(
    (providerId: string): void => {
      if (!providerId || providerId in models) return;
      setModels((prev) => ({ ...prev, [providerId]: [] }));
      api
        .prices(providerId)
        .then((list) => {
          setModels((prev) => ({ ...prev, [providerId]: list }));
        })
        .catch(() => undefined);
    },
    [api, models],
  );

  React.useEffect(() => {
    for (const d of Object.values(drafts)) if (d.providerId) loadModels(d.providerId);
  }, [drafts, loadModels]);

  const update = (p: Purpose, patch: Partial<Draft>): void => {
    setDrafts((prev) => ({ ...prev, [p]: { ...prev[p], ...patch } }));
  };

  const save = (): void => {
    const out: Route[] = [];
    for (const p of PURPOSES) {
      const d = drafts[p];
      if (!d.providerId || !d.model) continue;
      out.push({
        companyId: scope === "platform" ? null : companyId,
        purpose: p,
        providerId: d.providerId,
        model: d.model,
        ...(d.effort ? { effort: d.effort } : {}),
        maxOutputTokens: d.maxOutputTokens === "" ? 1024 : d.maxOutputTokens,
        batchAllowed: d.batchAllowed,
      });
    }
    void action.run(async () => {
      await (scope === "platform" ? staffClient.operator.routes.put(out) : staffClient.routes.put(out));
      router.refresh();
    }, s.saved);
  };

  if (providers.length === 0) return <p className="text-muted-foreground text-sm">{s.noProviders}</p>;

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <Flash flash={action.flash} />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{s.purpose}</TableHead>
            <TableHead>{s.provider}</TableHead>
            <TableHead>{s.model}</TableHead>
            <TableHead>{s.effort}</TableHead>
            <TableHead>{s.maxOutputTokens}</TableHead>
            <TableHead>{s.batchAllowed}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {PURPOSES.map((p) => {
            const d = drafts[p];
            const list = models[d.providerId] ?? [];
            return (
              <TableRow key={p}>
                <TableCell className="font-medium">{humanize(p)}</TableCell>
                <TableCell>
                  <Select
                    value={d.providerId || INHERIT}
                    onValueChange={(v) => {
                      update(p, { providerId: v === INHERIT ? "" : v, model: "" });
                    }}
                  >
                    <SelectTrigger aria-label={`${s.provider}: ${humanize(p)}`} className="w-44" size="sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={INHERIT}>{scope === "platform" ? t.app.none : s.inherit}</SelectItem>
                      {providers.map((pr) => (
                        <SelectItem key={pr.id} value={pr.id}>
                          {pr.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell>
                  <Input
                    aria-label={`${s.model}: ${humanize(p)}`}
                    list={`models-${d.providerId}`}
                    className="w-56 font-mono text-xs"
                    value={d.model}
                    disabled={!d.providerId}
                    onChange={(e) => {
                      update(p, { model: e.target.value });
                    }}
                  />
                  <datalist id={`models-${d.providerId}`}>
                    {list.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </datalist>
                </TableCell>
                <TableCell>
                  <Select
                    value={d.effort || "__none__"}
                    onValueChange={(v) => {
                      update(p, { effort: v === "__none__" ? "" : (v as Effort) });
                    }}
                  >
                    <SelectTrigger
                      aria-label={`${s.effort}: ${humanize(p)}`}
                      className="w-28"
                      size="sm"
                      disabled={!d.providerId}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">{t.app.none}</SelectItem>
                      {EFFORTS.map((e) => (
                        <SelectItem key={e} value={e}>
                          {e}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell>
                  <Input
                    aria-label={`${s.maxOutputTokens}: ${humanize(p)}`}
                    type="number"
                    min={1}
                    className="w-28"
                    value={d.maxOutputTokens}
                    disabled={!d.providerId}
                    onChange={(e) => {
                      update(p, { maxOutputTokens: e.target.value === "" ? "" : Number(e.target.value) });
                    }}
                  />
                </TableCell>
                <TableCell>
                  <Checkbox
                    aria-label={`${s.batchAllowed}: ${humanize(p)}`}
                    checked={d.batchAllowed}
                    disabled={!d.providerId}
                    onCheckedChange={(v) => {
                      update(p, { batchAllowed: v === true });
                    }}
                  />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <div>
        <Button type="submit" disabled={action.busy}>
          {action.busy ? t.app.saving : s.save}
        </Button>
      </div>
    </form>
  );
}
