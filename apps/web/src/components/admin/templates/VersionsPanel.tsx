"use client";

import { RotateCcwIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { Flash, useAction } from "@/components/admin/Flash";
import { Panel } from "@/components/admin/Panel";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
 * Every saved version of a template, newest first, and a way back (FR-62, D-183). Restoring
 * writes a new version with the old content: the list only ever grows, campaigns keep the row
 * they were started on, and the confirmation says which version will be created.
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
  const action = useAction();
  const [restoring, setRestoring] = React.useState<TemplateVersion | null>(null);
  const newest = versions.reduce((n, v) => Math.max(n, v.version), 0);

  return (
    <Panel title={s.title} description={s.description}>
      {versions.length <= 1 ? (
        <p className="text-muted-foreground px-5 py-4 text-sm">{s.empty}</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{s.version}</TableHead>
                <TableHead>{s.status}</TableHead>
                <TableHead>{s.saved}</TableHead>
                <TableHead>{s.by}</TableHead>
                <TableHead>{s.changes}</TableHead>
                <TableHead className="text-right">{s.campaigns}</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">{t.admin.common.actions}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {versions.map((v) => (
                <TableRow key={v.id} aria-current={v.id === currentId ? "true" : undefined}>
                  <TableCell className="font-medium whitespace-nowrap">
                    {v.id === currentId ? (
                      <>v{v.version}</>
                    ) : (
                      <Link
                        className="text-primary underline-offset-2 hover:underline"
                        href={`/admin/templates/${v.id}`}
                        aria-label={`${s.thisOne} ${v.version}`}
                      >
                        v{v.version}
                      </Link>
                    )}{" "}
                    {v.latest ? <Badge variant="secondary">{s.current}</Badge> : null}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={v.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                    {formatDate(v.createdAt)}
                  </TableCell>
                  <TableCell>{actorLabel(v.createdBy, t.admin.common.dash)}</TableCell>
                  <TableCell className="text-muted-foreground max-w-xs text-xs">
                    {v.changedFields.length > 0
                      ? v.changedFields.map(fieldName).join(", ")
                      : v.version === 1
                        ? s.first
                        : t.admin.common.dash}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{v.campaigns}</TableCell>
                  <TableCell className="text-right">
                    {canRestore && !v.latest ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={action.busy}
                        aria-label={`${s.restore} ${v.version}`}
                        onClick={() => {
                          setRestoring(v);
                        }}
                      >
                        <RotateCcwIcon /> {s.restore}
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <div className="px-5 pb-4">
        <Flash flash={action.flash} />
      </div>
      <ConfirmDialog
        open={restoring !== null}
        onOpenChange={(open) => {
          if (!open) setRestoring(null);
        }}
        title={s.restoreTitle(restoring?.version ?? 0)}
        description={<p>{s.restoreBody(restoring?.version ?? 0, newest + 1)}</p>}
        confirmLabel={s.restoreConfirm}
        tone="default"
        onConfirm={() => {
          const target = restoring;
          if (!target) return;
          void action.run(
            async () => {
              const created = await staffClient.templates.restore(target.id);
              router.push(`/admin/templates/${created.id}`);
              router.refresh();
            },
            s.restored(newest + 1),
          );
        }}
      />
    </Panel>
  );
}
