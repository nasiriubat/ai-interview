"use client";

import { ROUTABLE_PURPOSES, type Effort, type Purpose, type Route } from "@aidp/shared";
import { RotateCcwIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { providersApiFor, type ProviderScope } from "./ProvidersPanel";
import { Flash, useAction } from "@/components/admin/Flash";
import { IconButton, RowActions } from "@/components/admin/IconButton";
import { undoToast } from "@/components/common/undoToast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import type { ModelPrice, Provider, RouteRecord } from "@/lib/api/schemas";
import { label as enumLabel } from "@/lib/i18n/enums";

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
  // A table where there is room for one, a card per task where there is not.
  const narrow = useMediaQuery("(max-width: 767px)");

  const sources = React.useMemo(() => {
    const out = {} as Record<Purpose, RouteSource>;
    for (const p of ROUTABLE_PURPOSES) {
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
    for (const p of ROUTABLE_PURPOSES) {
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
    for (const p of ROUTABLE_PURPOSES) {
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

  const draftsRef = React.useRef(drafts);
  draftsRef.current = drafts;

  /** Clears one override at once and offers Undo, which puts the row back (D-111). */
  const clearOverride = (p: Purpose): void => {
    const previous = drafts[p];
    const next: Record<Purpose, Draft> = {
      ...drafts,
      [p]: { providerId: "", model: "", effort: "", maxOutputTokens: "", batchAllowed: false },
    };
    setDrafts(next);
    void action
      .run(async () => {
        await put(routesPayload(next));
        router.refresh();
      })
      .then((ok) => {
        if (!ok) return;
        undoToast(s.cleared, async () => {
          const restored = { ...draftsRef.current, [p]: previous };
          setDrafts(restored);
          await action.run(async () => {
            await put(routesPayload(restored));
            router.refresh();
          }, s.clearedRestored);
        });
      });
  };

  if (providers.length === 0) return <p className="text-muted-foreground text-sm">{s.noProviders}</p>;

  const inheritLabel = scope === "platform" ? t.app.none : s.inherit;
  const providerOptions: ComboboxOption[] = [
    { value: INHERIT, label: inheritLabel },
    ...providers.map((pr) => ({ value: pr.id, label: pr.name, detail: enumLabel("providerKind", pr.kind) })),
  ];

  const sourceLabel = (src: RouteSource): string =>
    src === "tenant" ? s.sourceTenant : src === "platform" ? s.sourcePlatform : s.sourceNone;

  /** The controls of one purpose, built once and placed in a table row or in a card. */
  const controls = (p: Purpose) => {
    const d = drafts[p];
    const entry = models[d.providerId];
    const loading = entry === "loading";
    const list: ModelPrice[] = Array.isArray(entry) ? entry : [];
    const options: ComboboxOption[] = list.map((m) => ({
      value: m.id,
      label: m.name || m.id,
      detail: m.id,
    }));
    const name = enumLabel("purpose", p);
    return {
      provider: (
        <Combobox
          id={`route-provider-${p}`}
          size="sm"
          value={d.providerId || INHERIT}
          aria-label={`${s.provider}: ${name}`}
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
      ),
      model: (
        <Combobox
          id={`route-model-${p}`}
          size="sm"
          value={d.model}
          disabled={!d.providerId}
          loading={loading}
          allowCustom
          aria-label={`${s.model}: ${name}`}
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
      ),
      effort: (
        <Select
          value={d.effort || "__none__"}
          onValueChange={(v) => {
            update(p, { effort: v === "__none__" ? "" : (v as Effort) });
          }}
        >
          <SelectTrigger
            aria-label={`${s.effort}: ${name}`}
            className="w-full md:w-28"
            size="sm"
            disabled={!d.providerId}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">{t.app.none}</SelectItem>
            {EFFORTS.map((e) => (
              <SelectItem key={e} value={e}>
                {enumLabel("effort", e)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ),
      tokens: (
        <Input
          aria-label={`${s.maxOutputTokens}: ${name}`}
          type="number"
          min={1}
          className="w-full md:w-28"
          value={d.maxOutputTokens}
          disabled={!d.providerId}
          onChange={(e) => {
            update(p, { maxOutputTokens: e.target.value === "" ? "" : Number(e.target.value) });
          }}
        />
      ),
      batch: (
        <Checkbox
          aria-label={`${s.batchAllowed}: ${name}`}
          checked={d.batchAllowed}
          disabled={!d.providerId}
          onCheckedChange={(v) => {
            update(p, { batchAllowed: v === true });
          }}
        />
      ),
      source: (
        <Badge variant={sources[p] === "tenant" ? "secondary" : "outline"}>{sourceLabel(sources[p])}</Badge>
      ),
      clear:
        scope !== "platform" && sources[p] === "tenant" ? (
          <IconButton
            label={`${s.clearOverride}: ${name}`}
            icon={<RotateCcwIcon />}
            disabled={action.busy}
            onClick={() => {
              clearOverride(p);
            }}
          />
        ) : null,
    };
  };

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <Flash flash={action.flash} />
      {!narrow ? (
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
              {ROUTABLE_PURPOSES.map((p) => {
                const c = controls(p);
                return (
                  <TableRow key={p}>
                    <TableCell className="font-medium">{enumLabel("purpose", p)}</TableCell>
                    <TableCell>
                      <div className="w-44">{c.provider}</div>
                    </TableCell>
                    <TableCell>
                      <div className="w-56">{c.model}</div>
                    </TableCell>
                    <TableCell>{c.effort}</TableCell>
                    <TableCell>{c.tokens}</TableCell>
                    <TableCell>{c.batch}</TableCell>
                    <TableCell>{c.source}</TableCell>
                    {scope === "platform" ? null : (
                      <TableCell className="text-right">
                        <RowActions>{c.clear}</RowActions>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : (
        // On a phone a seven-column table is a sideways scroll. One card per task keeps every
        // control reachable with a thumb and names it in words next to the control.
        <ul className="grid gap-3">
          {ROUTABLE_PURPOSES.map((p) => {
            const c = controls(p);
            return (
              <li key={p} className="bg-card shadow-card grid gap-3 rounded-lg p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-foreground text-sm font-semibold">{enumLabel("purpose", p)}</h3>
                  <div className="flex items-center gap-1">
                    {c.source}
                    {c.clear}
                  </div>
                </div>
                <div className="grid gap-1">
                  <span className="text-muted-foreground text-xs font-medium">{s.provider}</span>
                  {c.provider}
                </div>
                <div className="grid gap-1">
                  <span className="text-muted-foreground text-xs font-medium">{s.model}</span>
                  {c.model}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1">
                    <span className="text-muted-foreground text-xs font-medium">{s.effort}</span>
                    {c.effort}
                  </div>
                  <div className="grid gap-1">
                    <span className="text-muted-foreground text-xs font-medium">{s.maxOutputTokens}</span>
                    {c.tokens}
                  </div>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  {c.batch}
                  <span>{s.batchAllowed}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div>
        <Button type="submit" loading={action.busy}>
          {action.busy ? t.app.saving : s.save}
        </Button>
      </div>
    </form>
  );
}
