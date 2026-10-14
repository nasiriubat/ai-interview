import { EyeIcon } from "lucide-react";
import * as React from "react";
import { EmptyState } from "@/components/admin/EmptyState";
import { FlagBadge } from "@/components/admin/FlagBadge";
import { IconButton, RowActions } from "@/components/admin/IconButton";
import { MeterBar } from "@/components/admin/MeterBar";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { DateText } from "@/components/common/DateText";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { t } from "@/i18n";
import type { SessionListItem } from "@/lib/api/schemas";
import { formatCents } from "@/lib/utils";

const s = t.admin.campaigns;

/**
 * Who the interview belongs to, as far as staff may know it. An identified participant is named
 * (name, then email); anyone else is "Anonymous" with the short interview id, which is how an admin
 * refers to one interview without learning whose it is.
 */
function Participant({ session }: { session: SessionListItem }): React.JSX.Element {
  const named = session.participantName ?? session.participantEmail;
  if (named) {
    return (
      <>
        <span className="text-foreground font-medium">{named}</span>
        {session.participantName && session.participantEmail ? (
          <span className="text-muted-foreground block text-xs">{session.participantEmail}</span>
        ) : null}
      </>
    );
  }
  return (
    <>
      <span className="text-muted-foreground">{s.sessionAnonymousLabel}</span>{" "}
      <span className="font-mono text-xs">{session.id.slice(0, 8)}</span>
    </>
  );
}

export function SessionsTable({ sessions }: { sessions: SessionListItem[] }): React.JSX.Element {
  if (sessions.length === 0) return <EmptyState text={s.noSessions} />;
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{s.sessionParticipant}</TableHead>
            <TableHead>{s.sessionStatus}</TableHead>
            <TableHead>{s.sessionMode}</TableHead>
            <TableHead>{s.sessionFlag}</TableHead>
            <TableHead>{s.sessionProgress}</TableHead>
            <TableHead className="text-right">{s.sessionCost}</TableHead>
            <TableHead>{s.sessionUpdated}</TableHead>
            <TableHead className="text-right">
              <span className="sr-only">{t.admin.common.actions}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sessions.map((sess) => {
            const areas = sess.progress?.areas ?? [];
            const done = areas.filter((a) => a.status === "covered").length;
            return (
              <TableRow key={sess.id}>
                <TableCell>
                  <Participant session={sess} />
                </TableCell>
                <TableCell>
                  <StatusBadge status={sess.status} />
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {sess.mode ? (s.modes[sess.mode] ?? sess.mode) : t.admin.common.dash}
                </TableCell>
                <TableCell>
                  {sess.flagged ? (
                    <FlagBadge acknowledged={Boolean(sess.flagAckedAt)} />
                  ) : (
                    <span className="text-muted-foreground">{s.noFlag}</span>
                  )}
                </TableCell>
                <TableCell>
                  {areas.length > 0 ? (
                    <div className="flex items-center gap-2">
                      <MeterBar
                        value={done}
                        max={areas.length}
                        label={s.sessionProgress}
                        valueText={s.areasCovered(done, areas.length)}
                        className="w-24"
                      />
                      <span className="text-muted-foreground text-xs whitespace-nowrap">
                        {s.areasCovered(done, areas.length)}
                      </span>
                    </div>
                  ) : sess.areasCovered != null ? (
                    <span className="text-muted-foreground text-xs whitespace-nowrap">
                      {s.topicsCovered(sess.areasCovered)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">{t.admin.common.dash}</span>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatCents(sess.costCents)}</TableCell>
                <TableCell className="text-muted-foreground text-xs">
                  <DateText iso={sess.lastActivityAt ?? sess.updatedAt ?? sess.createdAt} />
                </TableCell>
                <TableCell className="text-right">
                  <RowActions>
                    <IconButton
                      label={s.viewSession}
                      icon={<EyeIcon />}
                      href={`/admin/sessions/${sess.id}`}
                    />
                  </RowActions>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
