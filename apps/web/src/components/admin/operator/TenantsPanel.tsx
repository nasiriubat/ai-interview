"use client";

import { BuildingIcon, EyeIcon, PauseIcon, PlayIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { Flash, useAction } from "@/components/admin/Flash";
import { NumberField, SelectField, TextField } from "@/components/admin/forms";
import { IconButton, RowActions } from "@/components/admin/IconButton";
import { MeterBar } from "@/components/admin/MeterBar";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { DataTable, type FilterDef, type SortSpec } from "@/components/data/DataTable";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import { CEILING_METRICS, type CeilingMetric, type Tenant, type CeilingUtilisation } from "@/lib/api/schemas";
import { currentCurrency } from "@/lib/currency";
import { formatCents, formatDate, formatNumber } from "@/lib/utils";

const s = t.admin.operator;

const MIB = 1024 * 1024;

/** `used / max` in the unit the form uses (MB for storage), or "no limit" for a ceiling of 0. */
function amount(metric: string, value: number): string {
  return metric === "storageBytes" ? formatNumber(Math.round(value / MIB)) : formatNumber(value);
}

function names(): Record<string, string> {
  return s.ceilingNames;
}

function Utilisation({ rows }: { rows: CeilingUtilisation[] }): React.JSX.Element {
  if (rows.length === 0) return <span className="text-muted-foreground">{t.admin.common.dash}</span>;
  return (
    <ul className="grid min-w-52 gap-2 text-xs">
      {rows.map((u) => {
        const text =
          u.max > 0
            ? `${amount(u.metric, u.used)} / ${amount(u.metric, u.max)}`
            : `${amount(u.metric, u.used)} (${s.noLimit})`;
        return (
          <li key={u.metric} className="grid gap-1">
            <span className="flex justify-between gap-3 tabular-nums">
              <span className="text-muted-foreground">{names()[u.metric] ?? u.metric}</span>
              <span
                className={
                  u.percent !== null && u.percent !== undefined && u.percent >= 80 ? "font-semibold" : ""
                }
              >
                {text}
              </span>
            </span>
            {u.max > 0 ? (
              <MeterBar
                tone="spend"
                value={u.used}
                max={u.max}
                label={names()[u.metric] ?? u.metric}
                valueText={text}
                className="h-1.5"
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function TenantsPanel({
  tenants,
  page,
  filters = [],
  sort,
  error,
}: {
  tenants: Tenant[];
  page?: { page: number; limit: number; count: number; total: number | null };
  filters?: FilterDef[];
  sort?: SortSpec;
  error?: string | undefined;
}): React.JSX.Element {
  const router = useRouter();
  const action = useAction();
  const [name, setName] = React.useState("");
  const [region, setRegion] = React.useState("eu");
  const [adminEmail, setAdminEmail] = React.useState("");
  const [language, setLanguage] = React.useState<"en" | "fi">("en");
  const [budget, setBudget] = React.useState<number | "">("");
  const [ceilings, setCeilings] = React.useState<Record<CeilingMetric, number | "">>({
    maxActiveCampaigns: "",
    maxSessionsPerMonth: "",
    storageBytes: "",
    voiceMinutes: "",
  });
  const [suspending, setSuspending] = React.useState<Tenant | null>(null);
  const [creating, setCreating] = React.useState(false);
  /** Who the invitation went to, for the sentence under the form. */
  const [invited, setInvited] = React.useState<string | null>(null);

  const setStatus = (tn: Tenant, status: "active" | "suspended"): void => {
    void action.run(async () => {
      await staffClient.operator.tenants.update(tn.id, { status });
      router.refresh();
    }, s.updated);
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent closeLabel={t.app.close} className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{s.newTenant}</DialogTitle>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void action.run(async () => {
                const limits: Partial<Record<CeilingMetric, number>> = {};
                for (const m of CEILING_METRICS) {
                  const v = ceilings[m];
                  if (v === "") continue;
                  limits[m] = m === "storageBytes" ? Math.round(v * MIB) : v;
                }
                const created = await staffClient.operator.tenants.create({
                  name: name.trim(),
                  region,
                  adminEmail: adminEmail.trim(),
                  language,
                  ...(budget !== "" ? { monthlyBudgetCents: Math.round(budget * 100) } : {}),
                  ...(Object.keys(limits).length > 0 ? { ceilings: limits } : {}),
                });
                setInvited(created.invitation?.to ?? null);
                setName("");
                setAdminEmail("");
                setBudget("");
                setCeilings({
                  maxActiveCampaigns: "",
                  maxSessionsPerMonth: "",
                  storageBytes: "",
                  voiceMinutes: "",
                });
                setCreating(false);
                router.refresh();
              }, s.addedToast);
            }}
          >
            <Flash flash={action.flash} />
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField id="tenant-name" label={s.name} value={name} required onChange={setName} />
              <TextField
                id="tenant-admin"
                label={s.adminEmail}
                value={adminEmail}
                required
                onChange={setAdminEmail}
              />
              <TextField id="tenant-region" label={s.region} value={region} onChange={setRegion} />
              <SelectField
                id="tenant-language"
                label={s.language}
                value={language}
                onChange={setLanguage}
                options={[
                  { value: "en", label: s.languages.en },
                  { value: "fi", label: s.languages.fi },
                ]}
              />
              <NumberField
                id="tenant-budget"
                label={`${s.defaultBudget} (${currentCurrency()})`}
                value={budget}
                min={0}
                onChange={setBudget}
              />
            </div>
            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium">{s.ceilings}</legend>
              <p className="text-muted-foreground text-xs">{s.ceilingHint}</p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {CEILING_METRICS.map((m) => (
                  <NumberField
                    key={m}
                    id={`tenant-ceiling-${m}`}
                    label={names()[m] ?? m}
                    value={ceilings[m]}
                    min={0}
                    onChange={(v) => {
                      setCeilings((prev) => ({ ...prev, [m]: v }));
                    }}
                  />
                ))}
              </div>
            </fieldset>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setCreating(false);
                }}
              >
                {t.app.cancel}
              </Button>
              <Button type="submit" loading={action.busy} disabled={!name.trim() || !adminEmail.trim()}>
                <PlusIcon /> {s.add}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {creating ? null : <Flash flash={action.flash} />}
      {invited ? (
        <p
          role="status"
          className="bg-success-soft text-success-soft-foreground rounded-lg px-4 py-3 text-sm"
        >
          {s.invitationSent(invited)}
        </p>
      ) : null}
      <DataTable
        id="tenants"
        label={s.tenantsTitle}
        searchLabel={t.admin.list.searchTenants}
        filters={filters}
        {...(sort ? { sort } : {})}
        {...(error ? { error } : {})}
        toolbarActions={
          <Button
            onClick={() => {
              setCreating(true);
            }}
          >
            <PlusIcon aria-hidden="true" /> <span className="max-sm:sr-only">{s.newTenant}</span>
          </Button>
        }
        columns={[
          { id: "name", header: s.name, sortKey: "name", primary: true, locked: true },
          { id: "status", header: s.status, sortKey: "status" },
          { id: "region", header: s.region },
          { id: "budget", header: s.defaultBudget, align: "end" },
          { id: "utilisation", header: s.utilisation },
          { id: "created", header: s.created, sortKey: "createdAt" },
        ]}
        rows={tenants.map((tn) => ({
          id: tn.id,
          label: tn.name,
          cells: {
            name: (
              <div className="min-w-0">
                <Link
                  href={`/admin/operator/tenants/${tn.id}`}
                  className="text-foreground font-medium break-words hover:underline"
                >
                  {tn.name}
                </Link>
                <p className="text-muted-foreground font-mono text-xs">{tn.id}</p>
                {tn.onboarding && tn.onboarding.total > 0 ? (
                  <p className="text-muted-foreground text-xs">
                    {s.setupProgress(tn.onboarding.done, tn.onboarding.total)}
                  </p>
                ) : null}
              </div>
            ),
            status: <StatusBadge status={tn.status ?? "active"} />,
            region: tn.region ?? t.admin.common.dash,
            budget: formatCents(tn.monthlyBudgetCents ?? tn.defaultBudgetCents),
            utilisation: <Utilisation rows={tn.utilisation} />,
            created: (
              <span className="text-muted-foreground whitespace-nowrap">{formatDate(tn.createdAt)}</span>
            ),
          },
          actions: (
            <RowActions>
              <IconButton
                label={`${t.ws.tenants.open}: ${tn.name}`}
                icon={<EyeIcon />}
                href={`/admin/operator/tenants/${tn.id}`}
              />
              <IconButton
                label={`${tn.status === "suspended" ? s.activate : s.suspend}: ${tn.name}`}
                icon={tn.status === "suspended" ? <PlayIcon /> : <PauseIcon />}
                disabled={action.busy}
                onClick={() => {
                  // Locking a company out asks first; letting it back in does not.
                  if (tn.status === "suspended") setStatus(tn, "active");
                  else setSuspending(tn);
                }}
              />
            </RowActions>
          ),
        }))}
        page={page ?? { page: 1, limit: 50, count: tenants.length, total: tenants.length }}
        empty={{
          icon: <BuildingIcon className="size-5" aria-hidden="true" />,
          title: t.ws.tenants.emptyTitle,
          description: s.empty,
          action: (
            <Button
              size="sm"
              onClick={() => {
                setCreating(true);
              }}
            >
              <PlusIcon aria-hidden="true" /> {s.newTenant}
            </Button>
          ),
        }}
      />
      <ConfirmDialog
        open={suspending !== null}
        onOpenChange={(open) => {
          if (!open) setSuspending(null);
        }}
        title={s.suspendTitle(suspending?.name ?? "")}
        description={<p>{s.suspendBody}</p>}
        confirmLabel={s.suspendConfirm}
        onConfirm={() => {
          if (suspending) setStatus(suspending, "suspended");
        }}
      />
    </div>
  );
}
