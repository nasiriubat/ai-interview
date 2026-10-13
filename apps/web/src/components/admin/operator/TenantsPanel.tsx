"use client";

import { PauseIcon, PlayIcon, PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { EmptyState } from "@/components/admin/EmptyState";
import { Flash, useAction } from "@/components/admin/Flash";
import { NumberField, TextField } from "@/components/admin/forms";
import { IconButton, RowActions } from "@/components/admin/IconButton";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import type { Tenant } from "@/lib/api/schemas";
import { formatCents, formatDate } from "@/lib/utils";

const s = t.admin.operator;

export function TenantsPanel({ tenants }: { tenants: Tenant[] }): React.JSX.Element {
  const router = useRouter();
  const action = useAction();
  const [name, setName] = React.useState("");
  const [region, setRegion] = React.useState("eu");
  const [budget, setBudget] = React.useState<number | "">("");

  return (
    <div className="grid gap-6">
      <form
        className="grid gap-3 bg-card shadow-card rounded-lg p-4 md:grid-cols-[1fr_8rem_12rem_auto] md:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            await staffClient.operator.tenants.create({
              name: name.trim(),
              region,
              ...(budget !== "" ? { defaultBudgetCents: Math.round(budget * 100) } : {}),
            });
            setName("");
            setBudget("");
            router.refresh();
          }, s.addedToast);
        }}
      >
        <TextField id="tenant-name" label={s.name} value={name} required onChange={setName} />
        <TextField id="tenant-region" label={s.region} value={region} onChange={setRegion} />
        <NumberField
          id="tenant-budget"
          label={`${s.defaultBudget} (€)`}
          value={budget}
          min={0}
          onChange={setBudget}
        />
        <Button type="submit" disabled={action.busy || !name.trim()}>
          <PlusIcon /> {s.add}
        </Button>
      </form>
      <Flash flash={action.flash} />
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
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={tn.status ?? "active"} />
                    </TableCell>
                    <TableCell>{tn.region ?? t.admin.common.dash}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCents(tn.defaultBudgetCents)}
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
                            void action.run(async () => {
                              await staffClient.operator.tenants.update(tn.id, {
                                status: suspended ? "active" : "suspended",
                              });
                              router.refresh();
                            }, s.updated);
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
    </div>
  );
}
