import { EyeIcon } from "lucide-react";
import * as React from "react";
import { FlagBadge } from "@/components/admin/FlagBadge";
import { IconButton, RowActions } from "@/components/admin/IconButton";
import { MeterBar } from "@/components/admin/MeterBar";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { DateText } from "@/components/common/DateText";
import type { DataRow } from "@/components/data/DataTable";
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
      <span className="block min-w-0">
        <span className="text-foreground block truncate font-medium">{named}</span>
        {session.participantName && session.participantEmail ? (
          <span className="text-muted-foreground block truncate text-xs">{session.participantEmail}</span>
        ) : null}
      </span>
    );
  }
  return (
    <span>
      <span className="text-muted-foreground">{s.sessionAnonymousLabel}</span>{" "}
      <span className="font-mono text-xs">{session.id.slice(0, 8)}</span>
    </span>
  );
}

/** Label of a session for assistive technology: the name, or "Anonymous" and the short id. */
export function sessionLabel(sess: SessionListItem): string {
  return sess.participantName ?? sess.participantEmail ?? `${s.sessionAnonymousLabel} ${sess.id.slice(0, 8)}`;
}

/** One page of a campaign's sessions as `DataTable` rows (plain elements, safe to pass from a server page). */
export function sessionRowsOf(sessions: SessionListItem[]): DataRow[] {
  return sessions.map((sess) => {
    const areas = sess.progress?.areas ?? [];
    const done = areas.filter((a) => a.status === "covered").length;
    const label = sessionLabel(sess);
    return {
      id: sess.id,
      label,
      cells: {
        participant: <Participant session={sess} />,
        status: <StatusBadge status={sess.status} />,
        mode: sess.mode ? (s.modes[sess.mode] ?? sess.mode) : t.admin.common.dash,
        flag: sess.flagged ? (
          <FlagBadge acknowledged={Boolean(sess.flagAckedAt)} />
        ) : (
          <span className="text-muted-foreground">{s.noFlag}</span>
        ),
        progress:
          areas.length > 0 ? (
            <span className="flex items-center gap-2">
              <MeterBar
                value={done}
                max={areas.length}
                label={s.sessionProgress}
                valueText={s.areasCovered(done, areas.length)}
                className="w-20"
              />
              <span className="text-muted-foreground text-xs whitespace-nowrap">
                {s.areasCovered(done, areas.length)}
              </span>
            </span>
          ) : sess.areasCovered != null ? (
            <span className="text-muted-foreground text-xs whitespace-nowrap">
              {s.topicsCovered(sess.areasCovered)}
            </span>
          ) : (
            <span className="text-muted-foreground">{t.admin.common.dash}</span>
          ),
        cost: <span className="tabular-nums">{formatCents(sess.costCents)}</span>,
        updated: (
          <span className="text-muted-foreground text-xs">
            <DateText iso={sess.lastActivityAt ?? sess.updatedAt ?? sess.createdAt} />
          </span>
        ),
      },
      actions: (
        <RowActions>
          <IconButton
            label={`${s.viewSession}: ${label}`}
            icon={<EyeIcon />}
            href={`/admin/sessions/${sess.id}`}
          />
        </RowActions>
      ),
    };
  });
}
