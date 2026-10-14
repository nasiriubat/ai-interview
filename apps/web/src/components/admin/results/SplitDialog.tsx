"use client";

import { Loader2Icon, SplitIcon } from "lucide-react";
import * as React from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { t } from "@/i18n";
import { editErrorText } from "@/lib/analysis/edit-errors";
import { staffClient } from "@/lib/api/browser";
import type { Opportunity } from "@/lib/api/schemas";

/**
 * Splits one opportunity into two or three parts. The facts arrive as text only (no person, role or
 * department), grouped by similarity as a starting point, and each fact is placed with a radio
 * group, so the whole dialog works from the keyboard and needs no drag and drop.
 */
export function SplitDialog({
  opportunity: o,
  k,
  open,
  onOpenChange,
  onSplit,
}: {
  opportunity: Opportunity;
  k: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the id of the stored edit once the API accepted the split and queued the run. */
  onSplit: (editId: string | undefined) => void;
}): React.JSX.Element {
  const s = t.admin.results.split;
  const [facts, setFacts] = React.useState<{ id: string; text: string }[] | null>(null);
  const [part, setPart] = React.useState<Record<string, number>>({});
  const [parts, setParts] = React.useState(2);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setFacts(null);
    setError(null);
    staffClient.opportunities
      .splitProposal(o.id)
      .then((p) => {
        if (cancelled) return;
        setFacts(p.facts.map((f) => ({ id: f.id, text: f.text })));
        setPart(Object.fromEntries(p.facts.map((f) => [f.id, f.part])));
        setParts(p.parts);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(editErrorText(e, k));
      });
    return () => {
      cancelled = true;
    };
  }, [open, o.id, k]);

  const counts = Array.from({ length: parts }, (_, i) =>
    facts ? facts.filter((f) => Math.min(part[f.id] ?? 0, parts - 1) === i).length : 0,
  );
  const ready = facts !== null && counts.every((c) => c > 0);

  const confirm = (): void => {
    if (!facts) return;
    const groups: string[][] = Array.from({ length: parts }, () => []);
    for (const f of facts) groups[Math.min(part[f.id] ?? 0, parts - 1)]?.push(f.id);
    setBusy(true);
    setError(null);
    staffClient.opportunities
      .split(o.id, groups)
      .then((r) => {
        onSplit(r.editId);
        onOpenChange(false);
      })
      .catch((e: unknown) => {
        setError(editErrorText(e, k));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t.app.close} className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{s.title}</DialogTitle>
          <DialogDescription>{s.body}</DialogDescription>
        </DialogHeader>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {facts === null && !error ? (
          <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
            <Loader2Icon className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> {s.loading}
          </p>
        ) : null}
        {facts ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-muted-foreground text-xs" aria-live="polite">
                {s.sizes(counts)}
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setParts((n) => (n === 2 ? 3 : 2));
                }}
              >
                {parts === 2 ? s.addPart : s.removePart}
              </Button>
            </div>
            <ul className="grid gap-3">
              {facts.map((f) => (
                <li key={f.id} className="grid gap-2 rounded-md border p-3">
                  <p className="text-sm" id={`split-fact-${f.id}`}>
                    {f.text}
                  </p>
                  <RadioGroup
                    aria-labelledby={`split-fact-${f.id}`}
                    className="flex flex-wrap gap-4"
                    value={String(Math.min(part[f.id] ?? 0, parts - 1))}
                    onValueChange={(v) => {
                      setPart((prev) => ({ ...prev, [f.id]: Number(v) }));
                    }}
                  >
                    {Array.from({ length: parts }, (_, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <RadioGroupItem value={String(i)} id={`split-${f.id}-${i}`} />
                        <Label htmlFor={`split-${f.id}-${i}`} className="text-sm font-normal">
                          {s.part(i + 1)}
                        </Label>
                      </div>
                    ))}
                  </RadioGroup>
                </li>
              ))}
            </ul>
            {!ready ? <p className="text-muted-foreground text-xs">{s.needEach}</p> : null}
          </>
        ) : null}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {t.app.cancel}
          </Button>
          <Button onClick={confirm} disabled={!ready} loading={busy}>
            {busy ? null : <SplitIcon />}
            {busy ? s.splitting : s.confirm(parts)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
