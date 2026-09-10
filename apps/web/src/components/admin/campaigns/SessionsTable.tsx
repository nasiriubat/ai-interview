import Link from "next/link";
import * as React from "react";
import { EmptyState } from "@/components/admin/EmptyState";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { t } from "@/i18n";
import type { SessionListItem } from "@/lib/api/schemas";
import { formatCents, formatDate } from "@/lib/utils";

const s = t.admin.campaigns;

export function SessionsTable({ sessions }: { sessions: SessionListItem[] }): React.JSX.Element {
  if (sessions.length === 0) return <EmptyState text={s.noSessions} />;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{s.sessionId}</TableHead>
          <TableHead>{s.sessionStatus}</TableHead>
          <TableHead>{s.sessionProgress}</TableHead>
          <TableHead className="text-right">{s.sessionCost}</TableHead>
          <TableHead>{s.sessionUpdated}</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {sessions.map((sess) => {
          const areas = sess.progress?.areas ?? [];
          const done = areas.filter((a) => a.status === "covered").length;
          const pct = areas.length ? Math.round((done / areas.length) * 100) : 0;
          return (
            <TableRow key={sess.id}>
              <TableCell className="font-mono text-xs">
                {sess.participantEmail ?? sess.id.slice(0, 8)}
              </TableCell>
              <TableCell>
                <StatusBadge status={sess.status} />
              </TableCell>
              <TableCell>
                {areas.length > 0 ? (
                  <div className="flex items-center gap-2">
                    <div
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={pct}
                      aria-label={s.areasCovered(done, areas.length)}
                      className="bg-muted h-2 w-24 overflow-hidden rounded-full"
                    >
                      <div className="bg-primary h-full" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-muted-foreground text-xs">
                      {s.areasCovered(done, areas.length)}
                    </span>
                  </div>
                ) : (
                  <span className="text-muted-foreground">{t.admin.common.dash}</span>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatCents(sess.costCents)}</TableCell>
              <TableCell className="text-muted-foreground text-xs">
                {formatDate(sess.updatedAt ?? sess.createdAt)}
              </TableCell>
              <TableCell className="text-right">
                <Button asChild size="sm" variant="ghost">
                  <Link href={`/admin/sessions/${sess.id}`}>{s.viewSession}</Link>
                </Button>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
