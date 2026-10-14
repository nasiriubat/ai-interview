"use client";

import type { BudgetScope } from "@aidp/shared";
import { CoinsIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { Flash, useAction } from "@/components/admin/Flash";
import { ComboboxField, NumberField, SelectField, TextField } from "@/components/admin/forms";
import { IconButton, RowActions } from "@/components/admin/IconButton";
import { Panel } from "@/components/admin/Panel";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { useDirty } from "@/components/common/DirtyGuard";
import { DataTable, type FilterDef, type SortSpec } from "@/components/data/DataTable";
import { MeterBar } from "@/components/admin/MeterBar";
import { Button } from "@/components/ui/button";
import type { ComboboxOption } from "@/components/ui/combobox";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import type { BudgetRecord } from "@/lib/api/schemas";
import type { ScopeKind } from "@/lib/api/staff";
import { currentCurrency } from "@/lib/currency";
import { label } from "@/lib/i18n/enums";
import { formatCents } from "@/lib/utils";

const s = t.admin.budgets;
const SCOPES = ["tenant", "campaign", "session"] as const;
const PERIODS = ["month", "total"] as const;

/** Budget scopes whose targets can be listed by name (contract 19); a session id is typed. */
function targetScope(scope: BudgetScope): ScopeKind | null {
  return scope === "tenant" || scope === "campaign" ? scope : null;
}

export interface BudgetsPanelPage {
  page: number;
  limit: number;
  count: number;
  total: number | null;
}

export function BudgetsPanel({
  budgets,
  companyId,
  page,
  filters = [],
  sort,
  error,
  campaignNames = {},
}: {
  budgets: BudgetRecord[];
  companyId: string | null;
  page?: BudgetsPanelPage;
  filters?: FilterDef[];
  sort?: SortSpec;
  error?: string | undefined;
  /** Campaign ids to names, so a campaign budget is not an identifier. */
  campaignNames?: Record<string, string>;
}): React.JSX.Element {
  const router = useRouter();
  const action = useAction();
  const [scope, setScope] = React.useState<BudgetScope>("tenant");
  const [scopeId, setScopeId] = React.useState(companyId ?? "");
  const [limit, setLimit] = React.useState<number | "">("");
  const [period, setPeriod] = React.useState<(typeof PERIODS)[number]>("month");
  const [targets, setTargets] = React.useState<ComboboxOption[]>([]);
  const [loadingTargets, setLoadingTargets] = React.useState(false);
  const [deleting, setDeleting] = React.useState<BudgetRecord | null>(null);
  const named = targetScope(scope);
  const dirty = limit !== "" || (scope !== "tenant" && scopeId !== "");
  useDirty("budget-new", dirty);

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

  const nameOf = (b: BudgetRecord): string =>
    b.scope === "tenant" ? t.ws.budgets.wholeOrganization : (campaignNames[b.scopeId] ?? b.scopeId);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <Panel title={t.ws.budgets.newTitle} description={t.ws.budgets.newBody} headingLevel={2}>
        <form
          className="grid gap-3 px-5 py-4 md:grid-cols-[13rem_minmax(0,1fr)_9rem_9rem_auto] md:items-end"
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
            label={`${s.limit} (${currentCurrency()})`}
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
          <Button type="submit" loading={action.busy} disabled={limit === "" || !scopeId.trim()}>
            <PlusIcon /> {s.add}
          </Button>
        </form>
      </Panel>
      <Flash flash={action.flash} />
      <DataTable
        id="budgets"
        label={s.title}
        searchLabel={t.admin.list.searchBudgets}
        filters={filters}
        {...(sort ? { sort } : {})}
        {...(error ? { error } : {})}
        columns={[
          { id: "target", header: s.target, primary: true, locked: true },
          { id: "scope", header: s.scope, sortKey: "scope" },
          { id: "limit", header: s.limit, sortKey: "limitCents", align: "end" },
          { id: "spend", header: t.ws.budgets.spent },
          { id: "period", header: s.period },
        ]}
        rows={budgets.map((b, i) => {
          const spent = typeof b.spentCents === "number" ? b.spentCents : null;
          return {
            id: b.id ?? `${b.scope}-${b.scopeId}-${String(i)}`,
            label: nameOf(b),
            cells: {
              target: (
                <span className="min-w-0">
                  <span className="text-foreground font-medium break-words">{nameOf(b)}</span>
                  {b.scope !== "tenant" ? (
                    <span className="text-muted-foreground block font-mono text-xs break-all">
                      {b.scopeId}
                    </span>
                  ) : null}
                </span>
              ),
              scope: label("budgetScope", b.scope),
              limit: formatCents(b.limitCents),
              spend:
                spent !== null && b.limitCents > 0 ? (
                  <div className="grid min-w-44 gap-1">
                    <span className="text-xs tabular-nums">
                      {t.ws.budgets.percentUsed(Math.round((spent / b.limitCents) * 100), formatCents(spent))}
                    </span>
                    <MeterBar
                      tone="spend"
                      value={spent}
                      max={b.limitCents}
                      label={`${nameOf(b)}`}
                      valueText={s.spentSoFar(formatCents(spent), formatCents(b.limitCents))}
                    />
                  </div>
                ) : (
                  <span className="text-muted-foreground">{t.admin.common.dash}</span>
                ),
              period: s.periods[b.period],
            },
            actions: b.id ? (
              <RowActions>
                <IconButton
                  label={`${s.delete}: ${nameOf(b)}`}
                  icon={<Trash2Icon />}
                  className="text-destructive hover:text-destructive"
                  disabled={action.busy}
                  onClick={() => {
                    setDeleting(b);
                  }}
                />
              </RowActions>
            ) : undefined,
          };
        })}
        page={page ?? { page: 1, limit: 50, count: budgets.length, total: budgets.length }}
        empty={{
          icon: <CoinsIcon className="size-5" aria-hidden="true" />,
          title: t.ws.budgets.emptyTitle,
          description: s.empty,
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={t.ws.budgets.deleteTitle(deleting ? nameOf(deleting) : "")}
        description={<p>{s.deleteConfirm}</p>}
        confirmLabel={t.app.delete}
        onConfirm={() => {
          const b = deleting;
          if (!b?.id) return;
          const id = b.id;
          void action.run(async () => {
            await staffClient.budgets.remove(id);
            router.refresh();
          }, s.deleted);
        }}
      />
    </div>
  );
}
