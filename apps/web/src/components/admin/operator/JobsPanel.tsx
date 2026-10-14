"use client";

import { CheckCircle2Icon, ListChecksIcon, PlayIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { Flash, useAction } from "@/components/admin/Flash";
import { IconButton, RowActions } from "@/components/admin/IconButton";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { DataTable } from "@/components/data/DataTable";
import { Badge } from "@/components/ui/badge";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import type { DeadJob, QueueSummary } from "@/lib/api/schemas";
import { formatDate } from "@/lib/utils";

const s = t.admin.operator.jobs;

interface Pending {
  job: DeadJob;
  kind: "retry" | "discard";
}

/**
 * The queue as an operator sees it (D-92): one row per job type with its counters, and below it
 * the dead letters of the chosen queue with the two verbs that resolve them. A dead letter is a
 * job that failed its last attempt; nothing else will ever report it, so this is where it ends.
 * Both verbs ask first, and say whose job it is.
 */
export function JobsPanel({
  queues,
  selected,
  dead,
}: {
  queues: QueueSummary[];
  selected: string | undefined;
  dead: DeadJob[];
}): React.JSX.Element {
  const router = useRouter();
  const action = useAction();
  const [pending, setPending] = React.useState<Pending | null>(null);
  const nameOf = (j: DeadJob): string => j.sourceId ?? j.id;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <Flash flash={action.flash} />
      <DataTable
        id="job-queues"
        label={s.title}
        columns={[
          { id: "queue", header: s.queue, primary: true, locked: true },
          { id: "queued", header: s.queued, align: "end" },
          { id: "active", header: s.active, align: "end" },
          { id: "dead", header: s.dead, align: "end" },
          { id: "oldest", header: s.oldest },
          { id: "expires", header: s.expires },
          { id: "last", header: s.lastFailure },
        ]}
        rows={queues.map((q) => ({
          id: q.name,
          label: q.name,
          cells: {
            queue:
              q.deadLettered > 0 ? (
                <Link
                  href={`/admin/operator/jobs?queue=${encodeURIComponent(q.name)}`}
                  aria-current={q.name === selected ? "true" : undefined}
                  className={
                    q.name === selected
                      ? "text-primary font-mono text-xs font-semibold underline underline-offset-2"
                      : "text-foreground hover:text-primary font-mono text-xs font-medium underline-offset-2 hover:underline"
                  }
                >
                  {q.name}
                </Link>
              ) : (
                <span className="font-mono text-xs font-medium">{q.name}</span>
              ),
            queued: q.queued,
            active: q.active,
            dead:
              q.deadLettered > 0 ? (
                <Badge variant="destructive">{q.deadLettered}</Badge>
              ) : (
                <span className="text-muted-foreground">0</span>
              ),
            oldest: (
              <span className="text-muted-foreground text-xs">
                {q.oldestQueuedAt ? formatDate(q.oldestQueuedAt) : t.admin.common.dash}
              </span>
            ),
            expires: (
              <span className="text-muted-foreground text-xs tabular-nums">
                {s.duration(q.expireInSeconds)} · {s.attempts(q.retryLimit + 1)}
              </span>
            ),
            last: (
              <span className="text-muted-foreground text-xs">
                {q.lastFailure ? formatDate(q.lastFailure.at) : t.admin.common.dash}
              </span>
            ),
          },
          actions: q.runNow ? (
            <RowActions>
              <IconButton
                label={`${s.runNow}: ${q.name}`}
                icon={<PlayIcon />}
                disabled={action.busy}
                onClick={() => {
                  void action.run(async () => {
                    await staffClient.operator.jobs.runNow(q.name);
                    router.refresh();
                  }, s.runNowQueued);
                }}
              />
            </RowActions>
          ) : undefined,
        }))}
        page={{ page: 1, limit: 200, count: queues.length, total: queues.length }}
        empty={{
          icon: <ListChecksIcon className="size-5" aria-hidden="true" />,
          title: t.ws.jobs.emptyTitle,
          description: s.empty,
        }}
      />

      <section aria-labelledby="dead-title" className="grid gap-3">
        <h2 id="dead-title" className="text-foreground text-base font-semibold tracking-tight">
          {selected ? s.deadTitle(selected) : s.dead}
        </h2>
        {!selected ? (
          <p className="text-muted-foreground bg-card shadow-card flex items-center gap-2 rounded-lg px-5 py-4 text-sm">
            <CheckCircle2Icon className="text-success size-4" aria-hidden="true" />
            {queues.some((q) => q.deadLettered > 0) ? s.pickQueue : t.ws.jobs.allClear}
          </p>
        ) : dead.length === 0 ? (
          <p className="text-muted-foreground bg-card shadow-card rounded-lg px-5 py-4 text-sm">{s.noDead}</p>
        ) : (
          <DataTable
            id="dead-letters"
            label={s.deadTitle(selected)}
            columns={[
              { id: "ref", header: s.reference, primary: true, locked: true },
              { id: "at", header: s.failedAt },
              { id: "error", header: s.error },
            ]}
            rows={dead.map((j) => ({
              id: j.id,
              label: nameOf(j),
              cells: {
                ref: (
                  <div className="min-w-0 text-xs">
                    <p className="font-mono font-medium break-all">{nameOf(j)}</p>
                    <p className="text-muted-foreground font-mono break-all">
                      {Object.entries(j.data)
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(" · ")}
                    </p>
                    <p className="text-muted-foreground">{s.attempts(j.retryCount + 1)}</p>
                  </div>
                ),
                at: <span className="text-muted-foreground text-xs">{formatDate(j.createdAt)}</span>,
                error: (
                  <span className="max-w-md text-xs leading-relaxed break-words">
                    {j.error || t.admin.common.dash}
                  </span>
                ),
              },
              actions: (
                <RowActions>
                  <IconButton
                    label={`${s.retry}: ${nameOf(j)}`}
                    icon={<RotateCcwIcon />}
                    disabled={action.busy}
                    onClick={() => {
                      setPending({ job: j, kind: "retry" });
                    }}
                  />
                  <IconButton
                    label={`${s.discard}: ${nameOf(j)}`}
                    icon={<Trash2Icon />}
                    className="text-destructive hover:text-destructive"
                    disabled={action.busy}
                    onClick={() => {
                      setPending({ job: j, kind: "discard" });
                    }}
                  />
                </RowActions>
              ),
            }))}
            page={{ page: 1, limit: 100, count: dead.length, total: dead.length }}
          />
        )}
      </section>

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={pending ? `${pending.kind === "retry" ? s.retry : s.discard}: ${nameOf(pending.job)}` : ""}
        description={<p>{pending?.kind === "retry" ? s.retryConfirm : s.discardConfirm}</p>}
        confirmLabel={pending?.kind === "retry" ? s.retry : s.discard}
        tone={pending?.kind === "retry" ? "default" : "destructive"}
        onConfirm={() => {
          const p = pending;
          if (!p) return;
          void action.run(
            async () => {
              if (p.kind === "retry") await staffClient.operator.jobs.retry(p.job.queue, p.job.id);
              else await staffClient.operator.jobs.discard(p.job.queue, p.job.id);
              router.refresh();
            },
            p.kind === "retry" ? s.retried : s.discarded,
          );
        }}
      />
    </div>
  );
}
