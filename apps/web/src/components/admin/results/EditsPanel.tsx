"use client";

import { Undo2Icon } from "lucide-react";
import * as React from "react";
import { IconButton } from "@/components/admin/IconButton";
import { Panel } from "@/components/admin/Panel";
import { Badge } from "@/components/ui/badge";
import { t } from "@/i18n";
import type { ClusterEdit } from "@/lib/api/schemas";
import { formatDate } from "@/lib/utils";

/**
 * The merges and splits in force for this campaign, newest first, each with Undo. Undoing makes a
 * new version, so it is not offered when the version on screen cannot be edited.
 */
export function EditsPanel({
  edits,
  orphaned,
  unassigned,
  canUndo,
  busy,
  onUndo,
}: {
  edits: readonly ClusterEdit[];
  orphaned: number;
  unassigned: number;
  canUndo: boolean;
  busy: boolean;
  onUndo: (edit: ClusterEdit) => void;
}): React.JSX.Element {
  const s = t.admin.results.edits;
  const describe = (e: ClusterEdit): string =>
    e.op === "merge" ? s.merged(e.clusters ?? 2) : s.split(e.parts ?? 2);
  return (
    <Panel title={s.title} description={s.body} headingLevel={3}>
      <div className="grid gap-3 px-5 py-4">
        {edits.length === 0 ? (
          <p className="text-muted-foreground text-sm">{s.empty}</p>
        ) : (
          <ul className="grid gap-2">
            {edits.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0">
                  <span className={e.revokedAt ? "text-muted-foreground line-through" : undefined}>
                    {describe(e)}
                    {e.title ? `: ${e.title}` : ""}
                  </span>
                  <span className="text-muted-foreground block text-xs">{formatDate(e.createdAt)}</span>
                </span>
                {e.revokedAt ? (
                  <Badge variant="outline">{s.undone}</Badge>
                ) : (
                  <IconButton
                    label={s.undoLabel(describe(e))}
                    icon={<Undo2Icon />}
                    disabled={!canUndo || busy}
                    onClick={() => {
                      onUndo(e);
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
        {orphaned > 0 ? <p className="text-warning-soft-foreground text-xs">{s.orphaned(orphaned)}</p> : null}
        {unassigned > 0 ? <p className="text-muted-foreground text-xs">{s.unassigned(unassigned)}</p> : null}
      </div>
    </Panel>
  );
}
