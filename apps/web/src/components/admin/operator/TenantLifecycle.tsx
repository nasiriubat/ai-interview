"use client";

import { ArchiveIcon, FileArchiveIcon, ShieldAlertIcon, Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { Flash, useAction } from "@/components/admin/Flash";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { DataTable } from "@/components/data/DataTable";
import { DownloadButton } from "@/components/data/DownloadButton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { RowActions } from "@/components/admin/IconButton";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import type { Tenant, TenantExport } from "@/lib/api/schemas";
import { formatBytes } from "@/lib/format";
import { formatDate, formatNumber } from "@/lib/utils";

/** Days a suspended tenant has before its data is removed, unless the operator skips them. */
const GRACE_DAYS = 7;

/**
 * Taking a copy of a tenant's data and removing it (D-225, D-226, D-376). The two are one
 * section on purpose: offboarding takes an export first, and a person about to delete should see
 * the copies that exist. The destructive step needs the tenant to be suspended and its name typed,
 * and says in words what happens and when.
 */
export function TenantLifecycle({
  tenant,
  exports,
  exportsError,
}: {
  tenant: Tenant;
  exports: TenantExport[];
  exportsError?: string | undefined;
}): React.JSX.Element {
  const s = t.ws.tenants;
  const router = useRouter();
  const action = useAction();
  const [confirming, setConfirming] = React.useState(false);
  const [immediate, setImmediate_] = React.useState(false);
  const suspended = tenant.status === "suspended";

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <Flash flash={action.flash} />
      <section aria-labelledby="exports-title" className="grid gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h2 id="exports-title" className="text-foreground text-base font-semibold tracking-tight">
              {s.exportsTitle}
            </h2>
            <p className="text-muted-foreground mt-0.5 max-w-prose text-[13px]">{s.exportsBody}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            loading={action.busy}
            onClick={() => {
              void action.run(async () => {
                await staffClient.operator.tenants.requestExport(tenant.id);
                router.refresh();
              }, s.exportQueued);
            }}
          >
            <ArchiveIcon /> {s.takeExport}
          </Button>
        </div>
        <DataTable
          id={`tenant-exports-${tenant.id}`}
          label={s.exportsTitle}
          error={exportsError}
          columns={[
            { id: "stamp", header: s.exportTaken, primary: true, locked: true },
            { id: "size", header: s.exportSize, align: "end" },
            { id: "files", header: s.exportFiles, align: "end" },
            { id: "sha", header: s.exportChecksum },
          ]}
          rows={exports.map((e) => ({
            id: e.stamp,
            label: e.stamp,
            cells: {
              stamp: <span className="font-medium">{formatDate(e.createdAt)}</span>,
              size: formatBytes(e.bytes),
              files: (
                <span>
                  {formatNumber(e.files)}
                  {e.skippedFiles > 0 ? (
                    <span className="text-warning-soft-foreground block text-xs">
                      {s.skipped(e.skippedFiles)}
                    </span>
                  ) : null}
                </span>
              ),
              sha: (
                <span className="text-muted-foreground font-mono text-xs" title={e.sha256}>
                  {e.sha256.slice(0, 12)}
                </span>
              ),
            },
            actions: (
              <RowActions>
                <DownloadButton
                  label={`${s.download}: ${formatDate(e.createdAt)}`}
                  path={`/api/staff/operator/tenants/${encodeURIComponent(tenant.id)}/exports/${e.stamp}`}
                  fallbackName={`export-${tenant.id}-${e.stamp}.zip`}
                  what={s.archive}
                />
              </RowActions>
            ),
          }))}
          page={{ page: 1, limit: 100, count: exports.length, total: exports.length }}
          empty={{
            icon: <FileArchiveIcon className="size-5" aria-hidden="true" />,
            title: s.noExports,
            description: s.noExportsBody,
          }}
        />
      </section>

      <section
        aria-labelledby="offboard-title"
        className="bg-destructive-soft/40 grid gap-4 rounded-lg px-5 py-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start"
      >
        <div className="min-w-0">
          <h2
            id="offboard-title"
            className="text-destructive-soft-foreground flex items-center gap-2 text-[15px] font-semibold"
          >
            <ShieldAlertIcon className="size-4" aria-hidden="true" />
            {s.offboardTitle}
          </h2>
          <p className="text-body mt-1.5 max-w-prose text-sm leading-relaxed">{s.offboardBody(GRACE_DAYS)}</p>
          {!suspended ? (
            <p className="text-muted-foreground mt-2 text-sm">{s.offboardNeedsSuspension}</p>
          ) : null}
        </div>
        <Button
          variant="destructive"
          disabled={!suspended || action.busy}
          onClick={() => {
            setConfirming(true);
          }}
        >
          <Trash2Icon /> {s.offboardAction}
        </Button>
      </section>

      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          setConfirming(open);
          if (!open) setImmediate_(false);
        }}
        title={s.offboardConfirmTitle(tenant.name)}
        confirmPhrase={tenant.name}
        confirmLabel={s.offboardConfirm}
        pending={action.busy}
        description={
          <div className="grid gap-3">
            <p>{s.offboardConfirmBody(GRACE_DAYS)}</p>
            <div className="flex items-start gap-2">
              <Checkbox
                id="offboard-immediate"
                checked={immediate}
                onCheckedChange={(v) => {
                  setImmediate_(v === true);
                }}
              />
              <Label htmlFor="offboard-immediate" className="leading-snug font-normal">
                {s.immediate}
              </Label>
            </div>
            {immediate ? (
              <Alert variant="destructive">
                <AlertTitle>{s.immediateTitle}</AlertTitle>
                <AlertDescription>{s.immediateBody}</AlertDescription>
              </Alert>
            ) : null}
          </div>
        }
        onConfirm={() => {
          void action.run(async () => {
            const r = await staffClient.operator.tenants.offboard(tenant.id, {
              confirmName: tenant.name,
              immediate,
            });
            router.refresh();
            setImmediate_(false);
            if (r.purgeAfter)
              action.setFlash({ kind: "success", text: s.offboardQueued(formatDate(r.purgeAfter)) });
          }, s.offboardQueuedNow);
        }}
      />
    </div>
  );
}
