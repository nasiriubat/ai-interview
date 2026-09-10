"use client";

import { DownloadIcon, PlusIcon, Trash2Icon } from "lucide-react";
import * as React from "react";
import { providersApiFor, type ProviderScope } from "./ProvidersPanel";
import { EmptyState } from "@/components/admin/EmptyState";
import { Flash, useAction } from "@/components/admin/Flash";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { t } from "@/i18n";
import type { ModelPrice } from "@/lib/api/schemas";

const s = t.admin.providers;

interface Row {
  id: string;
  name: string;
  contextWindow: number | "";
  inputPerMtok: number | "";
  cachedInputPerMtok: number | "";
  outputPerMtok: number | "";
}

function toRow(m: ModelPrice): Row {
  return {
    id: m.id,
    name: m.name,
    contextWindow: m.contextWindow ?? "",
    inputPerMtok: m.inputPerMtok ?? "",
    cachedInputPerMtok: m.cachedInputPerMtok ?? "",
    outputPerMtok: m.outputPerMtok ?? "",
  };
}
function fromRow(r: Row): ModelPrice {
  return {
    id: r.id,
    name: r.name || r.id,
    ...(r.contextWindow !== "" ? { contextWindow: r.contextWindow } : {}),
    ...(r.inputPerMtok !== "" ? { inputPerMtok: r.inputPerMtok } : {}),
    ...(r.cachedInputPerMtok !== "" ? { cachedInputPerMtok: r.cachedInputPerMtok } : {}),
    ...(r.outputPerMtok !== "" ? { outputPerMtok: r.outputPerMtok } : {}),
  };
}

/** Model list and price table of one provider. Import pulls the live list; admin edits win. */
export function ModelsPanel({
  providerId,
  prices,
  scope,
}: {
  providerId: string;
  prices: ModelPrice[];
  scope: ProviderScope;
}): React.JSX.Element {
  const api = providersApiFor(scope);
  const action = useAction();
  const [rows, setRows] = React.useState<Row[]>(prices.map(toRow));

  const update = (i: number, patch: Partial<Row>): void => {
    setRows((prev) => prev.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  };
  const numeric = (v: string): number | "" => (v === "" ? "" : Number(v));

  const importModels = (): void => {
    void action.run(async () => {
      const models = await api.models(providerId);
      setRows((prev) => {
        const byId = new Map(prev.map((r) => [r.id, r]));
        for (const m of models) {
          const existing = byId.get(m.id);
          byId.set(m.id, existing ? { ...toRow(m), ...existing, name: existing.name || m.name } : toRow(m));
        }
        return [...byId.values()];
      });
      action.setFlash({ kind: "success", text: s.imported(models.length) });
    });
  };
  const save = (): void => {
    void action.run(async () => {
      await api.putPrices(providerId, rows.filter((r) => r.id.trim()).map(fromRow));
    }, s.pricesSaved);
  };

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={action.busy} onClick={importModels}>
          <DownloadIcon /> {s.importModels}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setRows((prev) => [
              ...prev,
              {
                id: "",
                name: "",
                contextWindow: "",
                inputPerMtok: "",
                cachedInputPerMtok: "",
                outputPerMtok: "",
              },
            ]);
          }}
        >
          <PlusIcon /> {s.addModelRow}
        </Button>
        <Button type="submit" disabled={action.busy}>
          {action.busy ? t.app.saving : s.savePrices}
        </Button>
      </div>
      <Flash flash={action.flash} />
      {rows.length === 0 ? (
        <EmptyState text={s.noModels} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{s.modelId}</TableHead>
              <TableHead>{s.name}</TableHead>
              <TableHead>{s.contextWindow}</TableHead>
              <TableHead>{s.inputPrice}</TableHead>
              <TableHead>{s.cachedPrice}</TableHead>
              <TableHead>{s.outputPrice}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={i}>
                <TableCell>
                  <Input
                    aria-label={`${s.modelId} ${i + 1}`}
                    className="min-w-48 font-mono text-xs"
                    value={r.id}
                    onChange={(e) => {
                      update(i, { id: e.target.value });
                    }}
                  />
                </TableCell>
                <TableCell>
                  <Input
                    aria-label={`${s.name} ${i + 1}`}
                    className="min-w-40"
                    value={r.name}
                    onChange={(e) => {
                      update(i, { name: e.target.value });
                    }}
                  />
                </TableCell>
                <TableCell>
                  <Input
                    aria-label={`${s.contextWindow} ${i + 1}`}
                    type="number"
                    className="w-28"
                    value={r.contextWindow}
                    onChange={(e) => {
                      update(i, { contextWindow: numeric(e.target.value) });
                    }}
                  />
                </TableCell>
                <TableCell>
                  <Input
                    aria-label={`${s.inputPrice} ${i + 1}`}
                    type="number"
                    step="any"
                    className="w-24"
                    value={r.inputPerMtok}
                    onChange={(e) => {
                      update(i, { inputPerMtok: numeric(e.target.value) });
                    }}
                  />
                </TableCell>
                <TableCell>
                  <Input
                    aria-label={`${s.cachedPrice} ${i + 1}`}
                    type="number"
                    step="any"
                    className="w-24"
                    value={r.cachedInputPerMtok}
                    onChange={(e) => {
                      update(i, { cachedInputPerMtok: numeric(e.target.value) });
                    }}
                  />
                </TableCell>
                <TableCell>
                  <Input
                    aria-label={`${s.outputPrice} ${i + 1}`}
                    type="number"
                    step="any"
                    className="w-24"
                    value={r.outputPerMtok}
                    onChange={(e) => {
                      update(i, { outputPerMtok: numeric(e.target.value) });
                    }}
                  />
                </TableCell>
                <TableCell>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`${t.app.remove} ${r.id || i + 1}`}
                    onClick={() => {
                      setRows((prev) => prev.filter((_, k) => k !== i));
                    }}
                  >
                    <Trash2Icon />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </form>
  );
}
