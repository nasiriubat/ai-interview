"use client";

import { AlertTriangleIcon, PlusIcon, RefreshCwIcon, RotateCcwIcon, SquarePenIcon } from "lucide-react";
import * as React from "react";
import { providersApiFor, type ProviderScope } from "./ProvidersPanel";
import { EmptyState } from "@/components/admin/EmptyState";
import { Flash, useAction } from "@/components/admin/Flash";
import { IconButton, RowActions } from "@/components/admin/IconButton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { t } from "@/i18n";
import type { ModelCatalogue, ModelPriceInput, ModelPriceRow, PriceSource } from "@/lib/api/schemas";
import { formatDate, formatNumber } from "@/lib/utils";

const s = t.admin.providers;

type Num = number | "";

interface Row {
  model: string;
  name: string;
  contextLength: number | null;
  /** What the provider publishes, when it publishes anything. */
  provider: { input: Num; cached: Num; output: Num } | null;
  /** What is stored for this model, with where it came from. */
  stored: { input: Num; cached: Num; output: Num } | null;
  source: PriceSource;
  /** A row the admin added by hand for a model the provider does not list. */
  manual?: boolean | undefined;
}

function num(v: number | null | undefined): Num {
  return typeof v === "number" ? v : "";
}

function buildRows(catalogue: ModelCatalogue | null, prices: ModelPriceRow[]): Row[] {
  const byModel = new Map<string, Row>();
  for (const m of catalogue?.models ?? []) {
    byModel.set(m.id, {
      model: m.id,
      name: m.name,
      contextLength: m.contextLength ?? m.contextWindow ?? null,
      provider: {
        input: num(m.inputPerMtok),
        cached: num(m.cachedInputPerMtok),
        output: num(m.outputPerMtok),
      },
      stored: null,
      source: "provider",
    });
  }
  for (const p of prices) {
    const existing = byModel.get(p.model);
    const stored = {
      input: num(p.inputPerMtok),
      cached: num(p.cachedInputPerMtok),
      output: num(p.outputPerMtok),
    };
    const source: PriceSource = p.source ?? "admin";
    if (existing) byModel.set(p.model, { ...existing, stored, source });
    else {
      byModel.set(p.model, {
        model: p.model,
        name: p.model,
        contextLength: null,
        provider: null,
        stored,
        source,
      });
    }
  }
  return [...byModel.values()].sort((a, b) => a.model.localeCompare(b.model));
}

/** The price in force for a row: an admin override first, then whatever was imported. */
function effective(row: Row): { input: Num; cached: Num; output: Num } {
  return row.stored ?? row.provider ?? { input: "", cached: "", output: "" };
}

function price(v: Num): string {
  return v === "" ? t.admin.common.dash : formatNumber(v);
}

/**
 * The provider's own catalogue with the prices it publishes, plus the per-model overrides an
 * admin typed. Nothing has to be typed for a model whose price the provider already knows;
 * an override is explicit and reversible, and a stale catalogue still renders.
 */
export function ModelsPanel({
  providerId,
  prices,
  catalogue: initialCatalogue,
  catalogueError,
  scope,
}: {
  providerId: string;
  prices: ModelPriceRow[];
  catalogue: ModelCatalogue | null;
  catalogueError?: unknown;
  scope: ProviderScope;
}): React.JSX.Element {
  const api = providersApiFor(scope);
  const action = useAction();
  const [catalogue, setCatalogue] = React.useState<ModelCatalogue | null>(initialCatalogue);
  const [rows, setRows] = React.useState<Row[]>(() => buildRows(initialCatalogue, prices));
  const [drafts, setDrafts] = React.useState<Record<string, { input: Num; cached: Num; output: Num }>>({});

  const editing = (model: string): boolean => model in drafts;
  const startEdit = (row: Row): void => {
    setDrafts((prev) => ({ ...prev, [row.model]: { ...effective(row) } }));
  };
  const stopEdit = (model: string): void => {
    setDrafts((prev) => {
      const { [model]: _drop, ...rest } = prev;
      return rest;
    });
  };
  const updateDraft = (model: string, patch: Partial<{ input: Num; cached: Num; output: Num }>): void => {
    setDrafts((prev) => {
      const current = prev[model] ?? { input: "", cached: "", output: "" };
      return { ...prev, [model]: { ...current, ...patch } };
    });
  };

  const refresh = (): void => {
    void action.run(async () => {
      const next = await api.models(providerId);
      setCatalogue(next);
      setRows((prev) => {
        const manual = prev.filter((r) => r.manual);
        const rebuilt = buildRows(
          next,
          prev
            .filter((r) => r.stored)
            .map((r) => ({
              model: r.model,
              inputPerMtok: r.stored?.input === "" ? null : (r.stored?.input ?? null),
              cachedInputPerMtok: r.stored?.cached === "" ? null : (r.stored?.cached ?? null),
              outputPerMtok: r.stored?.output === "" ? null : (r.stored?.output ?? null),
              source: r.source,
            })),
        );
        const seen = new Set(rebuilt.map((r) => r.model));
        return [...rebuilt, ...manual.filter((r) => !seen.has(r.model))];
      });
      action.setFlash({ kind: "success", text: s.refreshed });
    });
  };

  const save = (): void => {
    const payload: ModelPriceInput[] = [];
    for (const [model, d] of Object.entries(drafts)) {
      if (!model.trim()) continue;
      payload.push({
        model: model.trim(),
        ...(d.input === "" ? {} : { inputPerMtok: d.input }),
        ...(d.output === "" ? {} : { outputPerMtok: d.output }),
        ...(d.cached === "" ? {} : { cachedInputPerMtok: d.cached }),
      });
    }
    if (payload.length === 0) return;
    void action.run(async () => {
      await api.putPrices(providerId, payload);
      setRows((prev) =>
        prev.map((r) => {
          const d = drafts[r.model];
          return d ? { ...r, stored: { ...d }, source: "admin" } : r;
        }),
      );
      setDrafts({});
    }, s.pricesSaved);
  };

  const addRow = (): void => {
    const model = "";
    setRows((prev) => [
      ...prev,
      { model, name: "", contextLength: null, provider: null, stored: null, source: "admin", manual: true },
    ]);
  };

  const dirty = Object.keys(drafts).length > 0;

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <p className="text-muted-foreground text-sm">{s.catalogueBody}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" disabled={action.busy} onClick={refresh}>
          <RefreshCwIcon /> {s.refresh}
        </Button>
        <Button type="button" variant="outline" onClick={addRow}>
          <PlusIcon /> {s.addModelRow}
        </Button>
        <Button type="submit" disabled={action.busy || !dirty}>
          {action.busy ? t.app.saving : s.savePrices}
        </Button>
        {catalogue ? (
          <span className="text-muted-foreground text-xs">
            {catalogue.fetchedAt ? s.fetchedAt(formatDate(catalogue.fetchedAt)) : s.neverFetched}
          </span>
        ) : null}
        {typeof catalogue?.importedPrices === "number" ? (
          <span className="text-muted-foreground text-xs">{s.importedPrices(catalogue.importedPrices)}</span>
        ) : null}
      </div>
      {catalogue?.stale || catalogueError ? (
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertTitle>{s.catalogue}</AlertTitle>
          <AlertDescription>{catalogue?.error ? s.stale(catalogue.error) : s.staleUnknown}</AlertDescription>
        </Alert>
      ) : null}
      <Flash flash={action.flash} />
      {rows.length === 0 ? (
        <EmptyState text={s.noModels} />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{s.modelId}</TableHead>
                <TableHead>{s.name}</TableHead>
                <TableHead className="text-right">{s.contextWindow}</TableHead>
                <TableHead className="text-right">{s.inputPrice}</TableHead>
                <TableHead className="text-right">{s.cachedPrice}</TableHead>
                <TableHead className="text-right">{s.outputPrice}</TableHead>
                <TableHead>{s.priceSource}</TableHead>
                <TableHead className="text-right">{t.admin.common.actions}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, i) => {
                const draft = drafts[row.model];
                const shown = draft ?? effective(row);
                const isEditing = row.manual === true || editing(row.model);
                return (
                  <TableRow key={`${row.model}-${String(i)}`}>
                    <TableCell className="font-mono text-xs">
                      {row.manual ? (
                        <Input
                          aria-label={`${s.modelId} ${String(i + 1)}`}
                          className="min-w-44 font-mono text-xs"
                          value={row.model}
                          onChange={(e) => {
                            const next = e.target.value;
                            setRows((prev) => prev.map((r, k) => (k === i ? { ...r, model: next } : r)));
                          }}
                        />
                      ) : (
                        row.model
                      )}
                    </TableCell>
                    <TableCell>{row.name || t.admin.common.dash}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.contextLength === null ? t.admin.common.dash : formatNumber(row.contextLength)}
                    </TableCell>
                    <PriceCell
                      label={`${s.inputPrice} ${row.model === "" ? String(i + 1) : row.model}`}
                      editing={isEditing}
                      value={shown.input}
                      onChange={(v) => {
                        updateDraft(row.model, { input: v });
                      }}
                    />
                    <PriceCell
                      label={`${s.cachedPrice} ${row.model === "" ? String(i + 1) : row.model}`}
                      editing={isEditing}
                      value={shown.cached}
                      onChange={(v) => {
                        updateDraft(row.model, { cached: v });
                      }}
                    />
                    <PriceCell
                      label={`${s.outputPrice} ${row.model === "" ? String(i + 1) : row.model}`}
                      editing={isEditing}
                      value={shown.output}
                      onChange={(v) => {
                        updateDraft(row.model, { output: v });
                      }}
                    />
                    <TableCell>
                      <Badge variant={row.source === "admin" ? "secondary" : "outline"}>
                        {row.source === "admin" ? s.sourceAdmin : s.sourceProvider}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <RowActions>
                        {row.manual ? null : editing(row.model) ? (
                          <IconButton
                            label={s.clearOverride}
                            icon={RotateCcwIcon}
                            onClick={() => {
                              stopEdit(row.model);
                            }}
                          />
                        ) : (
                          <IconButton
                            label={s.overridePrice}
                            icon={SquarePenIcon}
                            onClick={() => {
                              startEdit(row);
                            }}
                          />
                        )}
                      </RowActions>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </form>
  );
}

function PriceCell({
  label,
  editing,
  value,
  onChange,
}: {
  label: string;
  editing: boolean;
  value: Num;
  onChange: (v: Num) => void;
}): React.JSX.Element {
  return (
    <TableCell className="text-right tabular-nums">
      {editing ? (
        <Input
          aria-label={label}
          type="number"
          step="any"
          min={0}
          className="w-24"
          value={value}
          onChange={(e) => {
            onChange(e.target.value === "" ? "" : Number(e.target.value));
          }}
        />
      ) : (
        price(value)
      )}
    </TableCell>
  );
}
