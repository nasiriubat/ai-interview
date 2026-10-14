"use client";

import { PauseIcon, PlayIcon, PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { EmptyState } from "@/components/admin/EmptyState";
import { Flash, useAction } from "@/components/admin/Flash";
import { NumberField, SelectField, TextField } from "@/components/admin/forms";
import { IconButton, RowActions } from "@/components/admin/IconButton";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import { CEILING_METRICS, type CeilingMetric, type Tenant, type CeilingUtilisation } from "@/lib/api/schemas";
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
  if (rows.length === 0) return <span>{t.admin.common.dash}</span>;
  return (
    <ul className="grid gap-0.5 text-xs">
      {rows.map((u) => (
        <li key={u.metric} className="flex justify-between gap-3 tabular-nums">
          <span className="text-muted-foreground">{names()[u.metric] ?? u.metric}</span>
          <span
            className={
              u.percent !== null && u.percent !== undefined && u.percent >= 80 ? "font-semibold" : ""
            }
          >
            {u.max > 0
              ? `${amount(u.metric, u.used)} / ${amount(u.metric, u.max)}`
              : `${amount(u.metric, u.used)} (${s.noLimit})`}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function TenantsPanel({ tenants }: { tenants: Tenant[] }): React.JSX.Element {
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
  /** Who the invitation went to, for the sentence under the form. */
  const [invited, setInvited] = React.useState<string | null>(null);

  const setStatus = (tn: Tenant, status: "active" | "suspended"): void => {
    void action.run(async () => {
      await staffClient.operator.tenants.update(tn.id, { status });
      router.refresh();
    }, s.updated);
  };

  return (
    <div className="grid gap-6">
      <form
        className="bg-card shadow-card grid gap-4 rounded-lg p-4"
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
            router.refresh();
          }, s.addedToast);
        }}
      >
        <div className="grid gap-3 md:grid-cols-[1fr_1fr_8rem_10rem_12rem] md:items-end">
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
            label={`${s.defaultBudget} (€)`}
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
        <div>
          <Button type="submit" disabled={action.busy || !name.trim() || !adminEmail.trim()}>
            <PlusIcon /> {s.add}
          </Button>
        </div>
      </form>
      <Flash flash={action.flash} />
      {invited ? (
        <p role="status" className="text-sm">
          {s.invitationSent(invited)}
        </p>
      ) : null}
      {tenants.length === 0 ? (
        <EmptyState text={s.empty} />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{s.name}</TableHead>
                <TableHead>{s.status}</TableHead>
                <TableHead>{s.region}</TableHead>
                <TableHead className="text-right">{s.defaultBudget}</TableHead>
                <TableHead>{s.utilisation}</TableHead>
                <TableHead>{s.created}</TableHead>
                <TableHead className="text-right">{t.admin.common.actions}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tenants.map((tn) => {
                const suspended = tn.status === "suspended";
                return (
                  <TableRow key={tn.id}>
                    <TableCell className="font-medium">
                      {tn.name}
                      <p className="text-muted-foreground font-mono text-[11px]">{tn.id}</p>
                      {tn.onboarding && tn.onboarding.total > 0 ? (
                        <p className="text-muted-foreground text-[11px] font-normal">
                          {s.setupProgress(tn.onboarding.done, tn.onboarding.total)}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={tn.status ?? "active"} />
                    </TableCell>
                    <TableCell>{tn.region ?? t.admin.common.dash}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCents(tn.monthlyBudgetCents ?? tn.defaultBudgetCents)}
                    </TableCell>
                    <TableCell className="min-w-56">
                      <Utilisation rows={tn.utilisation} />
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {formatDate(tn.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <RowActions>
                        <IconButton
                          label={`${suspended ? s.activate : s.suspend}: ${tn.name}`}
                          icon={suspended ? <PlayIcon /> : <PauseIcon />}
                          variant={suspended ? "outline" : "ghost"}
                          disabled={action.busy}
                          onClick={() => {
                            // Locking a company out asks first; letting it back in does not.
                            if (suspended) setStatus(tn, "active");
                            else setSuspending(tn);
                          }}
                        />
                      </RowActions>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
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
