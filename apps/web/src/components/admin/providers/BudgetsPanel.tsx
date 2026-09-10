"use client";

import type { BudgetScope } from "@aidp/shared";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { EmptyState } from "@/components/admin/EmptyState";
import { Flash, useAction } from "@/components/admin/Flash";
import { NumberField, SelectField, TextField } from "@/components/admin/forms";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import type { BudgetRecord } from "@/lib/api/schemas";
import { formatCents, humanize } from "@/lib/utils";

const s = t.admin.budgets;
const SCOPES = ["tenant", "campaign", "session"] as const;
const PERIODS = ["month", "total"] as const;

export function BudgetsPanel({
  budgets,
  companyId,
}: {
  budgets: BudgetRecord[];
  companyId: string | null;
}): React.JSX.Element {
  const router = useRouter();
  const action = useAction();
  const [scope, setScope] = React.useState<BudgetScope>("tenant");
  const [scopeId, setScopeId] = React.useState(companyId ?? "");
  const [limit, setLimit] = React.useState<number | "">("");
  const [period, setPeriod] = React.useState<(typeof PERIODS)[number]>("month");

  const add = (): void => {
    if (limit === "" || !scopeId.trim()) return;
    void action.run(async () => {
      await staffClient.budgets.create({
        scope,
        scopeId: scopeId.trim(),
        limitCents: Math.round(limit * 100),
        period,
      });
      setLimit("");
      router.refresh();
    }, s.added);
  };

  return (
    <div className="grid gap-6">
      <form
        className="grid gap-3 rounded-xl border p-4 md:grid-cols-[10rem_1fr_8rem_8rem_auto] md:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <SelectField
          id="budget-scope"
          label={s.scope}
          value={scope}
          options={SCOPES.map((v) => ({ value: v, label: humanize(v) }))}
          onChange={(v) => {
            setScope(v);
            if (v === "tenant" && companyId) setScopeId(companyId);
          }}
        />
        <TextField
          id="budget-scopeId"
          label={s.scopeId}
          value={scopeId}
          hint={s.scopeIdHint}
          onChange={setScopeId}
        />
        <NumberField
          id="budget-limit"
          label={`${s.limit} (€)`}
          value={limit}
          min={0}
          step={1}
          onChange={setLimit}
        />
        <SelectField
          id="budget-period"
          label={s.period}
          value={period}
          options={PERIODS.map((v) => ({ value: v, label: s.periods[v] }))}
          onChange={setPeriod}
        />
        <Button type="submit" disabled={action.busy || limit === "" || !scopeId.trim()}>
          <PlusIcon /> {s.add}
        </Button>
      </form>
      <Flash flash={action.flash} />
      {budgets.length === 0 ? (
        <EmptyState text={s.empty} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{s.scope}</TableHead>
              <TableHead>{s.scopeId}</TableHead>
              <TableHead className="text-right">{s.limit}</TableHead>
              <TableHead>{s.period}</TableHead>
              <TableHead className="text-right">{t.admin.common.actions}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {budgets.map((b, i) => (
              <TableRow key={b.id ?? `${b.scope}-${b.scopeId}-${i}`}>
                <TableCell>{humanize(b.scope)}</TableCell>
                <TableCell className="font-mono text-xs">{b.scopeId}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCents(b.limitCents)}
                  {typeof b.spentCents === "number" ? (
                    <span className="text-muted-foreground block text-xs">
                      {s.spentSoFar(formatCents(b.spentCents), formatCents(b.limitCents))}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell>{s.periods[b.period]}</TableCell>
                <TableCell className="text-right">
                  {b.id ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      aria-label={`${s.delete}: ${b.scopeId}`}
                      disabled={action.busy}
                      onClick={() => {
                        const id = b.id;
                        if (!id) return;
                        void action.run(async () => {
                          await staffClient.budgets.remove(id);
                          router.refresh();
                        }, s.deleted);
                      }}
                    >
                      <Trash2Icon />
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
