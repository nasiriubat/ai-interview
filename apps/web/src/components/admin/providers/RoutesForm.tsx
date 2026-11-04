"use client";

import { NON_TEXT_PURPOSES, ROUTABLE_PURPOSES, type Effort, type Purpose, type Route } from "@aidp/shared";
import { RotateCcwIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { providersApiFor, type ProviderScope } from "./ProvidersPanel";
import { Flash, useAction } from "@/components/admin/Flash";
import { IconButton } from "@/components/admin/IconButton";
import { useDirty } from "@/components/common/DirtyGuard";
import { undoToast } from "@/components/common/undoToast";
import { SaveBarView } from "@/components/form/Form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import type { ModelPrice, Provider, RouteRecord } from "@/lib/api/schemas";
import { label as enumLabel } from "@/lib/i18n/enums";

const s = t.admin.routes;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const INHERIT = "__inherit__";
/** The API's own default when a route does not say (contract 19). */
const DEFAULT_MAX_OUTPUT = 4096;
/**
 * Tasks that produce no text: their output-token, effort and batch fields are off, and the row is
 * sent without a token count (the API stores 0). A required minimum here used to block every save
 * on the page, because these rows are stored with 0.
 */
const NOT_TEXT = NON_TEXT_PURPOSES;
/** The tasks "use one provider" fills: everything that produces text. */
const TEXT_PURPOSES = ROUTABLE_PURPOSES.filter((p) => !NOT_TEXT.has(p));
/** Provider kinds with no language model, which the one-provider switch does not offer. */
const AUDIO_ONLY_KINDS: ReadonlySet<string> = new Set(["local", "stt", "tts", "realtime"]);

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
  const [savedDrafts, setSavedDrafts] = React.useState(drafts);
  const dirty = JSON.stringify(drafts) !== JSON.stringify(savedDrafts);
  useDirty("routes", dirty);
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

  /**
   * Switching provider in one step (D-495): every text task gets the chosen provider and model and
   * keeps its own effort and token limit; batching is cleared because it is a per-provider feature.
   * Nothing is sent until the admin saves, so the rows can be reviewed first. Works the same for
   * every kind: nothing here knows which providers exist.
   */
  const [bulkProvider, setBulkProvider] = React.useState("");
  const [bulkModel, setBulkModel] = React.useState("");
  const applyToAll = (): void => {
    if (!bulkProvider || !bulkModel) return;
    setDrafts((prev) => {
      const next = { ...prev };
      for (const p of TEXT_PURPOSES)
        next[p] = { ...prev[p], providerId: bulkProvider, model: bulkModel, batchAllowed: false };
      return next;
    });
    toast.success(s.bulkApplied(TEXT_PURPOSES.length));
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
        ...(d.effort && !NOT_TEXT.has(p) ? { effort: d.effort } : {}),
        maxOutputTokens: NOT_TEXT.has(p)
          ? 0
          : d.maxOutputTokens === ""
            ? DEFAULT_MAX_OUTPUT
            : d.maxOutputTokens,
        batchAllowed: d.batchAllowed && !NOT_TEXT.has(p),
      });
    }
    return out;
  };

  const put = (payload: Route[]): Promise<void> =>
    scope === "platform" ? staffClient.operator.routes.put(payload) : staffClient.routes.put(payload);

  const save = (): void => {
    void action
      .run(async () => {
        await put(routesPayload(drafts));
        setSavedDrafts(drafts);
        router.refresh();
      }, s.saved)
      .then(() => undefined);
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
        setSavedDrafts(next);
        router.refresh();
      })
      .then((ok) => {
        if (!ok) return;
        undoToast(s.cleared, async () => {
          const restored = { ...draftsRef.current, [p]: previous };
          setDrafts(restored);
          await action.run(async () => {
            await put(routesPayload(restored));
            setSavedDrafts(restored);
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

  const languageProviders = providers.filter((pr) => !AUDIO_ONLY_KINDS.has(pr.kind));
  const bulkEntry = models[bulkProvider];
  const bulkModels: ComboboxOption[] = (Array.isArray(bulkEntry) ? bulkEntry : []).map((m) => ({
    value: m.id,
    label: m.name || m.id,
    detail: m.id,
  }));

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
            className="w-full"
            size="sm"
            disabled={!d.providerId || NOT_TEXT.has(p)}
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
          min={NOT_TEXT.has(p) ? 0 : 1}
          className="w-full"
          value={NOT_TEXT.has(p) ? "" : d.maxOutputTokens}
          disabled={!d.providerId || NOT_TEXT.has(p)}
          onChange={(e) => {
            update(p, { maxOutputTokens: e.target.value === "" ? "" : Number(e.target.value) });
          }}
        />
      ),
      batch: (
        <Checkbox
          aria-label={`${s.batchAllowed}: ${name}`}
          checked={d.batchAllowed}
          disabled={!d.providerId || NOT_TEXT.has(p)}
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
      className="grid grid-cols-[minmax(0,1fr)] gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <Flash flash={action.flash} />
      {languageProviders.length > 0 ? (
        <section
          aria-labelledby="routes-bulk-title"
          className="bg-card shadow-card grid gap-3 rounded-lg px-4 py-3.5"
        >
          <div className="grid gap-1">
            <h3 id="routes-bulk-title" className="text-foreground text-[15px] font-semibold">
              {s.bulkTitle}
            </h3>
            <p className="text-muted-foreground text-sm">{s.bulkHint}</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[13rem_minmax(0,1fr)_auto] lg:items-end">
            <div className="grid min-w-0 gap-1">
              <span className="text-muted-foreground text-xs font-medium">{s.provider}</span>
              <Combobox
                id="route-bulk-provider"
                size="sm"
                value={bulkProvider}
                aria-label={`${s.bulkTitle}: ${s.provider}`}
                options={languageProviders.map((pr) => ({
                  value: pr.id,
                  label: pr.name,
                  detail: enumLabel("providerKind", pr.kind),
                }))}
                labels={{
                  placeholder: s.provider,
                  search: t.admin.combobox.search,
                  empty: t.admin.combobox.empty,
                }}
                onChange={(v) => {
                  setBulkProvider(v);
                  setBulkModel("");
                  loadModels(v);
                }}
              />
            </div>
            <div className="grid min-w-0 gap-1">
              <span className="text-muted-foreground text-xs font-medium">{s.model}</span>
              <Combobox
                id="route-bulk-model"
                size="sm"
                value={bulkModel}
                disabled={!bulkProvider}
                loading={bulkEntry === "loading"}
                allowCustom
                aria-label={`${s.bulkTitle}: ${s.model}`}
                options={bulkModels}
                labels={{
                  placeholder: s.modelPlaceholder,
                  search: t.admin.combobox.search,
                  empty: s.noModels,
                  loading: t.admin.combobox.loading,
                  useCustom: t.admin.combobox.useCustom,
                }}
                onChange={setBulkModel}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!bulkProvider || !bulkModel}
              onClick={applyToAll}
            >
              {s.bulkApply}
            </Button>
          </div>
        </section>
      ) : null}
      {/*
       * One card per task at every width (D-374): the title and where the setting comes from on the
       * first line, the five controls under it. A seven-column table needed a sideways scroll on a
       * phone and crowded the model name on a laptop; a card with named controls does neither.
       */}
      <ul className="grid gap-3">
        {ROUTABLE_PURPOSES.map((p) => {
          const c = controls(p);
          const name = enumLabel("purpose", p);
          return (
            <li key={p} className="bg-card shadow-card grid gap-3 rounded-lg px-4 py-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-foreground text-[15px] font-semibold">{name}</h3>
                <div className="flex items-center gap-1">
                  {c.source}
                  {c.clear}
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[13rem_minmax(0,1fr)_7rem_7rem_auto] lg:items-end">
                <div className="grid min-w-0 gap-1">
                  <span className="text-muted-foreground text-xs font-medium">{s.provider}</span>
                  {c.provider}
                </div>
                <div className="grid min-w-0 gap-1">
                  <span className="text-muted-foreground text-xs font-medium">{s.model}</span>
                  {c.model}
                </div>
                <div className="grid min-w-0 gap-1">
                  <span className="text-muted-foreground text-xs font-medium">{s.effort}</span>
                  {c.effort}
                </div>
                <div className="grid min-w-0 gap-1">
                  <span className="text-muted-foreground text-xs font-medium">{s.maxOutputTokens}</span>
                  {c.tokens}
                </div>
                <label className="flex h-9 items-center gap-2 text-sm">
                  {c.batch}
                  <span>{s.batchAllowed}</span>
                </label>
              </div>
            </li>
          );
        })}
      </ul>
      <SaveBarView
        dirty={dirty}
        submitting={action.busy}
        onDiscard={() => {
          setDrafts(savedDrafts);
        }}
        saveLabel={s.save}
      />
    </form>
  );
}
