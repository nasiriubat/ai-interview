"use client";

import { PURPOSES, type Effort, type Purpose, type Route } from "@aidp/shared";
import { RotateCcwIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { providersApiFor, type ProviderScope } from "./ProvidersPanel";
import { Flash, useAction } from "@/components/admin/Flash";
import { IconButton, RowActions } from "@/components/admin/IconButton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
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
/** The API's own default when a route does not say (contract 19). */
const DEFAULT_MAX_OUTPUT = 4096;

interface Draft {
  providerId: string;
  model: string;
  effort: Effort | "";
  maxOutputTokens: number | "";
  batchAllowed: boolean;
}

type RouteSource = "tenant" | "platform" | "none";

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

/**
 * One row per purpose. The model comes from the selected provider's own catalogue, with a
 * free-text escape hatch for a model it does not list. An empty provider means "inherit the
 * platform default"; the row is still sent so the API can drop the tenant override.
 */
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

  const sources = React.useMemo(() => {
    const out = {} as Record<Purpose, RouteSource>;
    for (const p of PURPOSES) {
      const tenant = routes.find((r) => r.purpose === p && r.companyId !== null);
      const platform = routes.find((r) => r.purpose === p && r.companyId === null);
      out[p] =
        scope === "platform"
          ? platform
            ? "platform"
            : "none"
          : tenant
            ? "tenant"
            : platform
              ? "platform"
              : "none";
    }
    return out;
  }, [routes, scope]);

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
  const [models, setModels] = React.useState<Record<string, ModelPrice[] | "loading">>({});

  const loadModels = React.useCallback(
    (providerId: string): void => {
      if (!providerId) return;
      setModels((prev) => {
        if (providerId in prev) return prev;
        api
          .models(providerId)
          .then((catalogue) => {
            setModels((inner) => ({ ...inner, [providerId]: catalogue.models }));
          })
          .catch(() => {
            setModels((inner) => ({ ...inner, [providerId]: [] }));
          });
        return { ...prev, [providerId]: "loading" };
      });
    },
    [api],
  );

  React.useEffect(() => {
    for (const d of Object.values<Draft>(drafts)) if (d.providerId) loadModels(d.providerId);
  }, [drafts, loadModels]);

  const update = (p: Purpose, patch: Partial<Draft>): void => {
    setDrafts((prev) => ({ ...prev, [p]: { ...prev[p], ...patch } }));
  };

  const routesPayload = (current: Record<Purpose, Draft>): Route[] => {
    const out: Route[] = [];
    for (const p of PURPOSES) {
      const d = current[p];
      // A row with no provider is sent too: that is how an existing override is cleared.
      out.push({
        companyId: scope === "platform" ? null : companyId,
        purpose: p,
        providerId: d.providerId,
        model: d.model,
        ...(d.effort ? { effort: d.effort } : {}),
        maxOutputTokens: d.maxOutputTokens === "" ? DEFAULT_MAX_OUTPUT : d.maxOutputTokens,
        batchAllowed: d.batchAllowed,
      });
    }
    return out;
  };

  const put = (payload: Route[]): Promise<void> =>
    scope === "platform" ? staffClient.operator.routes.put(payload) : staffClient.routes.put(payload);

  const save = (): void => {
    void action.run(async () => {
      await put(routesPayload(drafts));
      router.refresh();
    }, s.saved);
  };

  const clearOverride = (p: Purpose): void => {
    const next: Record<Purpose, Draft> = {
      ...drafts,
      [p]: { providerId: "", model: "", effort: "", maxOutputTokens: "", batchAllowed: false },
    };
    setDrafts(next);
    void action.run(async () => {
      await put(routesPayload(next));
      router.refresh();
    }, s.cleared);
  };

  if (providers.length === 0) return <p className="text-muted-foreground text-sm">{s.noProviders}</p>;

  const inheritLabel = scope === "platform" ? t.app.none : s.inherit;
  const providerOptions: ComboboxOption[] = [
    { value: INHERIT, label: inheritLabel },
    ...providers.map((pr) => ({ value: pr.id, label: pr.name, detail: pr.kind })),
  ];

  const sourceLabel = (src: RouteSource): string =>
    src === "tenant" ? s.sourceTenant : src === "platform" ? s.sourcePlatform : s.sourceNone;

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <Flash flash={action.flash} />
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{s.purpose}</TableHead>
              <TableHead>{s.provider}</TableHead>
              <TableHead>{s.model}</TableHead>
              <TableHead>{s.effort}</TableHead>
              <TableHead>{s.maxOutputTokens}</TableHead>
              <TableHead>{s.batchAllowed}</TableHead>
              <TableHead>{s.source}</TableHead>
              {scope === "platform" ? null : (
                <TableHead className="text-right">{t.admin.common.actions}</TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {PURPOSES.map((p) => {
              const d = drafts[p];
              const entry = models[d.providerId];
              const loading = entry === "loading";
              const list: ModelPrice[] = Array.isArray(entry) ? entry : [];
              const options: ComboboxOption[] = list.map((m) => ({
                value: m.id,
                label: m.name || m.id,
                detail: m.id,
              }));
              return (
                <TableRow key={p}>
                  <TableCell className="font-medium">{humanize(p)}</TableCell>
                  <TableCell>
                    <div className="w-44">
                      <Combobox
                        id={`route-provider-${p}`}
                        size="sm"
                        value={d.providerId || INHERIT}
                        aria-label={`${s.provider}: ${humanize(p)}`}
                        options={providerOptions}
                        labels={{
                          placeholder: inheritLabel,
                          search: t.admin.combobox.search,
                          empty: t.admin.combobox.empty,
                        }}
                        onChange={(v) => {
                          update(p, { providerId: v === INHERIT ? "" : v, model: "" });
                        }}
                      />
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="w-56">
                      <Combobox
                        id={`route-model-${p}`}
                        size="sm"
                        value={d.model}
                        disabled={!d.providerId}
                        loading={loading}
                        allowCustom
                        aria-label={`${s.model}: ${humanize(p)}`}
                        options={options}
                        labels={{
                          placeholder: s.modelPlaceholder,
                          search: t.admin.combobox.search,
                          empty: s.noModels,
                          loading: t.admin.combobox.loading,
                          useCustom: t.admin.combobox.useCustom,
                        }}
                        onChange={(v) => {
                          update(p, { model: v });
                        }}
                      />
                    </div>
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
                  <TableCell>
                    <Badge variant={sources[p] === "tenant" ? "secondary" : "outline"}>
                      {sourceLabel(sources[p])}
                    </Badge>
                  </TableCell>
                  {scope === "platform" ? null : (
                    <TableCell className="text-right">
                      <RowActions>
                        {sources[p] === "tenant" ? (
                          <IconButton
                            label={`${s.clearOverride}: ${humanize(p)}`}
                            icon={RotateCcwIcon}
                            disabled={action.busy}
                            onClick={() => {
                              clearOverride(p);
                            }}
                          />
                        ) : null}
                      </RowActions>
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <div>
        <Button type="submit" disabled={action.busy}>
          {action.busy ? t.app.saving : s.save}
        </Button>
      </div>
    </form>
  );
}
