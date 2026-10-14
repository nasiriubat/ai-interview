import { BuildingIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import * as React from "react";
import { LoadError, settled } from "@/components/admin/LoadError";
import { MeterBar } from "@/components/admin/MeterBar";
import { TenantLifecycle } from "@/components/admin/operator/TenantLifecycle";
import { PageHeader } from "@/components/admin/PageHeader";
import { Panel } from "@/components/admin/Panel";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { getStrings, requestLocale } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { errorMessage } from "@/lib/api/errors";
import { staffServer } from "@/lib/api/server";
import { formatBytes } from "@/lib/format";
import { formatCents, formatDate, formatNumber } from "@/lib/utils";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).ws.tenants.detailTitle };
}

interface Props {
  params: Promise<{ id: string }>;
}

/** One tenant: its state and limits, the copies taken of its data, and offboarding (D-376). */
export default async function TenantPage({ params }: Props): Promise<React.JSX.Element> {
  await requestLocale();
  await requireMe();
  const { id } = await params;
  const api = await staffServer();
  const [tenantsR, exportsR] = await Promise.allSettled([
    api.operator.tenants.list({ limit: 200 }),
    api.operator.tenants.exports(id),
  ]);
  const tenants = settled(tenantsR);
  if (!tenants.data) return <LoadError error={tenants.error} />;
  const tenant = tenants.data.items.find((x) => x.id === id);
  if (!tenant) notFound();
  const exports = settled(exportsR);
  const s = t.ws.tenants;
  const names: Record<string, string> = t.admin.operator.ceilingNames;
  return (
    <>
      <PageHeader
        crumbLabels={{ [id]: tenant.name }}
        title={tenant.name}
        subtitle={s.detailSubtitle}
        meta={<StatusBadge status={tenant.status ?? "active"} />}
        secondaryActions={
          <Button asChild variant="outline">
            <Link href="/admin/operator">
              <BuildingIcon /> {t.admin.operator.tenantsTitle}
            </Link>
          </Button>
        }
      />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
        <Panel title={s.summary} headingLevel={2}>
          <div className="grid gap-6 px-5 py-4 md:grid-cols-2">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <div>
                <dt className="text-muted-foreground text-xs">{t.admin.operator.region}</dt>
                <dd className="font-medium">{tenant.region ?? t.admin.common.dash}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-xs">{t.admin.operator.created}</dt>
                <dd className="font-medium">{formatDate(tenant.createdAt)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-xs">{t.admin.operator.defaultBudget}</dt>
                <dd className="font-medium tabular-nums">
                  {formatCents(tenant.monthlyBudgetCents ?? tenant.defaultBudgetCents)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-xs">{s.identifier}</dt>
                <dd className="font-mono text-xs break-all">{tenant.id}</dd>
              </div>
            </dl>
            <ul className="grid gap-3" aria-label={t.admin.operator.utilisation}>
              {tenant.utilisation.length === 0 ? (
                <li className="text-muted-foreground text-sm">{t.admin.common.dash}</li>
              ) : (
                tenant.utilisation.map((u) => {
                  const fmt = (n: number): string =>
                    u.metric === "storageBytes" ? formatBytes(n) : formatNumber(n);
                  const text =
                    u.max > 0
                      ? `${fmt(u.used)} / ${fmt(u.max)}`
                      : `${fmt(u.used)} (${t.admin.operator.noLimit})`;
                  return (
                    <li key={u.metric} className="grid gap-1">
                      <span className="flex justify-between gap-3 text-sm">
                        <span className="text-muted-foreground">{names[u.metric] ?? u.metric}</span>
                        <span className="font-medium tabular-nums">{text}</span>
                      </span>
                      {u.max > 0 ? (
                        <MeterBar
                          tone="spend"
                          value={u.used}
                          max={u.max}
                          label={names[u.metric] ?? u.metric}
                          valueText={text}
                        />
                      ) : null}
                    </li>
                  );
                })
              )}
            </ul>
          </div>
        </Panel>
        <TenantLifecycle
          tenant={tenant}
          exports={exports.data?.slice().sort((a, b) => b.stamp.localeCompare(a.stamp)) ?? []}
          exportsError={exports.error ? errorMessage(exports.error, t.app.unknownError) : undefined}
        />
      </div>
    </>
  );
}
