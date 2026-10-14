"use client";

import { PlayIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { EmptyState } from "@/components/admin/EmptyState";
import { Flash, useAction } from "@/components/admin/Flash";
import { IconButton, RowActions } from "@/components/admin/IconButton";
import { Panel } from "@/components/admin/Panel";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import type { DeadJob, QueueSummary } from "@/lib/api/schemas";
import { formatDate } from "@/lib/utils";

const s = t.admin.operator.jobs;

/**
 * The queue as an operator sees it (D-92): one row per job type with its counters, and below it
 * the dead letters of the chosen queue with the two verbs that resolve them. A dead letter is a
 * job that failed its last attempt; nothing else will ever report it, so this is where it ends.
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

  return (
    <div className="grid gap-6">
      <Flash flash={action.flash} />
      {queues.length === 0 ? (
        <EmptyState text={s.empty} />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{s.queue}</TableHead>
                <TableHead className="text-right">{s.queued}</TableHead>
                <TableHead className="text-right">{s.active}</TableHead>
                <TableHead className="text-right">{s.dead}</TableHead>
                <TableHead>{s.oldest}</TableHead>
                <TableHead>{s.expires}</TableHead>
                <TableHead>{s.lastFailure}</TableHead>
                <TableHead className="text-right">{t.admin.common.actions}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {queues.map((q) => (
                <TableRow key={q.name} data-selected={q.name === selected ? "true" : undefined}>
                  <TableCell className="font-mono text-xs font-medium">
                    {q.deadLettered > 0 ? (
                      <Link
                        href={`/admin/operator/jobs?queue=${encodeURIComponent(q.name)}`}
                        aria-current={q.name === selected ? "true" : undefined}
                        className="hover:text-primary underline-offset-2 hover:underline"
                      >
                        {q.name}
                      </Link>
                    ) : (
                      q.name
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{q.queued}</TableCell>
                  <TableCell className="text-right tabular-nums">{q.active}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {q.deadLettered > 0 ? (
                      <Badge variant="destructive">{q.deadLettered}</Badge>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {q.oldestQueuedAt ? formatDate(q.oldestQueuedAt) : t.admin.common.dash}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs tabular-nums">
                    {s.duration(q.expireInSeconds)} · {s.attempts(q.retryLimit + 1)}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {q.lastFailure ? formatDate(q.lastFailure.at) : t.admin.common.dash}
                  </TableCell>
                  <TableCell className="text-right">
                    {q.runNow ? (
                      <RowActions>
                        <IconButton
                          label={`${s.runNow}: ${q.name}`}
                          icon={<PlayIcon />}
                          variant="outline"
                          disabled={action.busy}
                          onClick={() => {
                            void action.run(async () => {
                              await staffClient.operator.jobs.runNow(q.name);
                              router.refresh();
                            }, s.runNowQueued);
                          }}
                        />
                      </RowActions>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Panel title={selected ? s.deadTitle(selected) : s.dead}>
        {!selected ? (
          <p className="text-muted-foreground text-sm">{s.pickQueue}</p>
        ) : dead.length === 0 ? (
          <p className="text-muted-foreground text-sm">{s.noDead}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{s.reference}</TableHead>
                  <TableHead>{s.failedAt}</TableHead>
                  <TableHead>{s.error}</TableHead>
                  <TableHead className="text-right">{t.admin.common.actions}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dead.map((j) => (
                  <TableRow key={j.id}>
                    <TableCell className="text-xs">
                      <p className="font-mono">{j.sourceId ?? j.id}</p>
                      <p className="text-muted-foreground font-mono text-xs">
                        {Object.entries(j.data)
                          .map(([k, v]) => `${k}: ${v}`)
                          .join(" · ")}
                      </p>
                      <p className="text-muted-foreground text-xs">{s.attempts(j.retryCount + 1)}</p>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">{formatDate(j.createdAt)}</TableCell>
                    <TableCell className="max-w-md text-xs break-words">
                      {j.error || t.admin.common.dash}
                    </TableCell>
                    <TableCell className="text-right">
                      <RowActions>
                        <ConfirmedAction
                          label={`${s.retry}: ${j.sourceId ?? j.id}`}
                          title={s.retry}
                          description={s.retryConfirm}
                          confirm={s.retry}
                          icon={<RotateCcwIcon aria-hidden="true" />}
                          busy={action.busy}
                          onConfirm={() => {
                            void action.run(async () => {
                              await staffClient.operator.jobs.retry(j.queue, j.id);
                              router.refresh();
                            }, s.retried);
                          }}
                        />
                        <ConfirmedAction
                          label={`${s.discard}: ${j.sourceId ?? j.id}`}
                          title={s.discard}
                          description={s.discardConfirm}
                          confirm={s.discard}
                          icon={<Trash2Icon aria-hidden="true" />}
                          destructive
                          busy={action.busy}
                          onConfirm={() => {
                            void action.run(async () => {
                              await staffClient.operator.jobs.discard(j.queue, j.id);
                              router.refresh();
                            }, s.discarded);
                          }}
                        />
                      </RowActions>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Panel>
    </div>
  );
}

/** An icon button that asks first, in the dialog pattern the rest of the admin uses. */
function ConfirmedAction({
  label,
  title,
  description,
  confirm,
  icon,
  destructive,
  busy,
  onConfirm,
}: {
  label: string;
  title: string;
  description: string;
  confirm: string;
  icon: React.ReactNode;
  destructive?: boolean;
  busy: boolean;
  onConfirm: () => void;
}): React.JSX.Element {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          disabled={busy}
          className={destructive ? "text-destructive hover:text-destructive" : undefined}
          aria-label={label}
        >
          {icon}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t.app.cancel}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{confirm}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
