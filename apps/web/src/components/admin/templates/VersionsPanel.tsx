"use client";

import { RotateCcwIcon, EyeIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { IconButton, RowActions } from "@/components/admin/IconButton";
import { SectionTitle } from "@/components/admin/Panel";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { notify } from "@/components/common/notify";
import { DataTable } from "@/components/data/DataTable";
import { Badge } from "@/components/ui/badge";
import { t } from "@/i18n";
import { actorLabel } from "@/lib/admin/actor";
import { staffClient } from "@/lib/api/browser";
import type { TemplateVersion } from "@/lib/api/schemas";
import { formatDate } from "@/lib/utils";

/** The names of a template's fields, for "what changed in this version". */
function fieldName(field: string): string {
  const names: Record<string, unknown> = t.admin.templates.fields;
  const name = names[field];
  return typeof name === "string" ? name : field;
}

/**
 * Every saved version of a template, newest first, and a way back (FR-62, D-183, D-363). Restoring
 * writes a new version with the old content: the list only ever grows, campaigns keep the row
 * they were started on, and the confirmation says which version will be created. The history is
 * small and arrives whole, so the table shows it on one page.
 */
export function VersionsPanel({
  versions,
  currentId,
  canRestore,
}: {
  versions: TemplateVersion[];
  currentId: string;
  /** An admin viewing a template their organization owns; a built-in cannot be restored. */
  canRestore: boolean;
}): React.JSX.Element {
  const s = t.admin.templates.versions;
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [restoring, setRestoring] = React.useState<TemplateVersion | null>(null);
  const newest = versions.reduce((n, v) => Math.max(n, v.version), 0);
  const dash = t.admin.common.dash;

  const restore = (target: TemplateVersion): void => {
    setBusy(true);
    staffClient.templates
      .restore(target.id)
      .then((created) => {
        notify.success(s.restored(newest + 1));
        router.push(`/admin/templates/${created.id}`);
        router.refresh();
      })
      .catch((e: unknown) => {
        notify.error(e, {
          retry: () => {
            restore(target);
          },
        });
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <section aria-labelledby="template-versions" className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <div>
        <SectionTitle id="template-versions">{s.title}</SectionTitle>
        <p className="text-muted-foreground mt-0.5 max-w-prose text-[13px]">{s.description}</p>
      </div>
      <DataTable
        id="template-versions"
        label={s.title}
        columns={[
          { id: "version", header: s.version, primary: true, locked: true },
          { id: "status", header: s.status, locked: true },
          { id: "saved", header: s.saved, locked: true },
          { id: "by", header: s.by, locked: true },
          { id: "changes", header: s.changes, locked: true },
          { id: "campaigns", header: s.campaigns, align: "end", locked: true },
        ]}
        rows={versions.map((v) => ({
          id: v.id,
          label: `v${String(v.version)}`,
          cells: {
            version: (
              <span className="font-medium whitespace-nowrap">
                {v.id === currentId ? (
                  <>v{v.version}</>
                ) : (
                  <Link
                    className="text-primary underline-offset-2 hover:underline"
                    href={`/admin/templates/${v.id}`}
                    aria-label={`${s.thisOne} ${String(v.version)}`}
                  >
                    v{v.version}
                  </Link>
                )}{" "}
                {v.latest ? <Badge variant="secondary">{s.current}</Badge> : null}
              </span>
            ),
            status: <StatusBadge status={v.status} />,
            saved: <span className="text-muted-foreground whitespace-nowrap">{formatDate(v.createdAt)}</span>,
            by: actorLabel(v.createdBy, dash),
            changes: (
              <span className="text-muted-foreground block max-w-xs text-xs">
                {v.changedFields.length > 0
                  ? v.changedFields.map(fieldName).join(", ")
                  : v.version === 1
                    ? s.first
                    : dash}
              </span>
            ),
            campaigns: <span className="tabular-nums">{v.campaigns}</span>,
          },
          actions: (
            <RowActions>
              {v.id !== currentId ? (
                <IconButton
                  label={`${s.thisOne} ${String(v.version)}`}
                  icon={<EyeIcon />}
                  href={`/admin/templates/${v.id}`}
                />
              ) : null}
              {canRestore && !v.latest ? (
                <IconButton
                  label={`${s.restore} ${String(v.version)}`}
                  icon={<RotateCcwIcon />}
                  disabled={busy}
                  onClick={() => {
                    setRestoring(v);
                  }}
                />
              ) : null}
            </RowActions>
          ),
        }))}
        page={{
          page: 1,
          limit: Math.max(versions.length, 1),
          count: versions.length,
          total: versions.length,
        }}
        empty={{ title: s.empty }}
      />
      <ConfirmDialog
        open={restoring !== null}
        onOpenChange={(open) => {
          if (!open) setRestoring(null);
        }}
        title={s.restoreTitle(restoring?.version ?? 0)}
        description={<p>{s.restoreBody(restoring?.version ?? 0, newest + 1)}</p>}
        confirmLabel={s.restoreConfirm}
        tone="default"
        pending={busy}
        onConfirm={() => {
          if (restoring) restore(restoring);
        }}
      />
    </section>
  );
}
