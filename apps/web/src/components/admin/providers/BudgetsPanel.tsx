"use client";

import type { BudgetScope } from "@aidp/shared";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { EmptyState } from "@/components/admin/EmptyState";
import { Flash, useAction } from "@/components/admin/Flash";
import { ComboboxField, NumberField, SelectField, TextField } from "@/components/admin/forms";
import { IconTooltip, RowActions } from "@/components/admin/IconButton";
import { MeterBar } from "@/components/admin/MeterBar";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { ComboboxOption } from "@/components/ui/combobox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import type { BudgetRecord } from "@/lib/api/schemas";
import type { ScopeKind } from "@/lib/api/staff";
import { label } from "@/lib/i18n/enums";
import { formatCents } from "@/lib/utils";

const s = t.admin.budgets;
const SCOPES = ["tenant", "campaign", "session"] as const;
const PERIODS = ["month", "total"] as const;

/** Budget scopes whose targets can be listed by name (contract 19); a session id is typed. */
function targetScope(scope: BudgetScope): ScopeKind | null {
  return scope === "tenant" || scope === "campaign" ? scope : null;
}

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
  const [targets, setTargets] = React.useState<ComboboxOption[]>([]);
  const [loadingTargets, setLoadingTargets] = React.useState(false);
  const named = targetScope(scope);

  React.useEffect(() => {
    if (!named) {
      setTargets([]);
      return;
    }
    let live = true;
    setLoadingTargets(true);
    staffClient.settings
      .scopes(named)
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
        if (live) setLoadingTargets(false);
      });
    return () => {
      live = false;
    };
  }, [named]);

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
        className="grid gap-3 bg-card shadow-card rounded-lg p-4 md:grid-cols-[10rem_1fr_8rem_8rem_auto] md:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <SelectField
          id="budget-scope"
          label={s.scope}
          value={scope}
          required
          options={SCOPES.map((v) => ({ value: v, label: label("budgetScope", v) }))}
          onChange={(v) => {
            setScope(v);
            setScopeId(v === "tenant" && companyId ? companyId : "");
          }}
        />
        {named ? (
          <ComboboxField
            id="budget-target"
            label={s.target}
            value={scopeId}
            required
            loading={loadingTargets}
            options={targets}
            labels={{
              placeholder: s.targetPlaceholder,
              search: t.admin.combobox.search,
              empty: s.noTargets,
              loading: t.admin.combobox.loading,
            }}
            onChange={setScopeId}
          />
        ) : (
          <TextField
            id="budget-scopeId"
            label={s.scopeId}
            value={scopeId}
            required
            hint={s.scopeIdHint}
            onChange={setScopeId}
          />
        )}
        <NumberField
          id="budget-limit"
          label={`${s.limit} (€)`}
          value={limit}
          min={0}
          step={1}
          required
          onChange={setLimit}
        />
        <SelectField
          id="budget-period"
          label={s.period}
          value={period}
          required
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
        <div className="overflow-x-auto">
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
                <TableRow key={b.id ?? `${b.scope}-${b.scopeId}-${String(i)}`}>
                  <TableCell>{label("budgetScope", b.scope)}</TableCell>
                  <TableCell className="font-mono text-xs">{b.scopeId}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCents(b.limitCents)}
                    {typeof b.spentCents === "number" ? (
                      <div className="mt-1 grid min-w-40 gap-1">
                        <span className="text-muted-foreground block text-xs">
                          {s.spentSoFar(formatCents(b.spentCents), formatCents(b.limitCents))}
                        </span>
                        {b.limitCents > 0 ? (
                          <MeterBar
                            tone="spend"
                            value={b.spentCents}
                            max={b.limitCents}
                            label={`${label("budgetScope", b.scope)}: ${b.scopeId}`}
                            valueText={s.spentSoFar(formatCents(b.spentCents), formatCents(b.limitCents))}
                          />
                        ) : null}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>{s.periods[b.period]}</TableCell>
                  <TableCell className="text-right">
                    <RowActions>
                      {b.id ? <DeleteBudget id={b.id} label={b.scopeId} action={action} /> : null}
                    </RowActions>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function DeleteBudget({
  id,
  label,
  action,
}: {
  id: string;
  label: string;
  action: ReturnType<typeof useAction>;
}): React.JSX.Element {
  const router = useRouter();
  return (
    <AlertDialog>
      <IconTooltip label={`${s.delete}: ${label}`}>
        <AlertDialogTrigger asChild>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            aria-label={`${s.delete}: ${label}`}
            disabled={action.busy}
          >
            <Trash2Icon aria-hidden="true" />
          </Button>
        </AlertDialogTrigger>
      </IconTooltip>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{s.delete}</AlertDialogTitle>
          <AlertDialogDescription>{s.deleteConfirm}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t.app.cancel}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              void action.run(async () => {
                await staffClient.budgets.remove(id);
                router.refresh();
              }, s.deleted);
            }}
          >
            {t.app.delete}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
