"use client";

import * as React from "react";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { t } from "@/i18n";

/**
 * The confirmation of a merge (the policy table in D-111: hard to reverse, so an AlertDialog). It
 * names what is being merged and asks for the title, which defaults to the highest ranked one.
 */
export function MergeDialog({
  open,
  onOpenChange,
  titles,
  defaultTitle,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  titles: readonly string[];
  defaultTitle: string;
  onConfirm: (title: string) => void;
}): React.JSX.Element {
  const s = t.admin.results.merge;
  const [title, setTitle] = React.useState(defaultTitle);
  React.useEffect(() => {
    if (open) setTitle(defaultTitle);
  }, [open, defaultTitle]);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={s.title}
      tone="default"
      confirmLabel={s.confirm}
      onConfirm={() => {
        onConfirm(title.trim() || defaultTitle);
      }}
      description={
        <div className="grid gap-3 text-left">
          <p>{s.body}</p>
          <ul className="list-disc pl-5 text-sm">
            {titles.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
          <div className="grid gap-1.5">
            <Label htmlFor="merge-title">{s.titleField}</Label>
            <Input
              id="merge-title"
              value={title}
              maxLength={160}
              onChange={(e) => {
                setTitle(e.target.value);
              }}
            />
          </div>
        </div>
      }
    />
  );
}
