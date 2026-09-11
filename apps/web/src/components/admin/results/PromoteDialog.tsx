"use client";

import { Loader2Icon, RocketIcon } from "lucide-react";
import Link from "next/link";
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
import { t } from "@/i18n";
import { effectiveTitle } from "@/lib/analysis/rank";
import { staffClient } from "@/lib/api/browser";
import { errorMessage } from "@/lib/api/errors";
import type { Opportunity, PromoteResult } from "@/lib/api/schemas";

function HandoffList({ label, items }: { label: string; items: readonly string[] }): React.JSX.Element {
  return (
    <div>
      <dt className="text-muted-foreground text-xs font-medium">{label}</dt>
      <dd>
        {items.length > 0 ? (
          <ul className="list-disc pl-5">
            {items.map((i, n) => (
              <li key={n}>{i}</li>
            ))}
          </ul>
        ) : (
          t.admin.common.dash
        )}
      </dd>
    </div>
  );
}

/** Confirms the promotion, then shows the hand-off the API produced for the new session. */
export function PromoteDialog({
  opportunity: o,
  open,
  onOpenChange,
  onPromoted,
}: {
  opportunity: Opportunity;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPromoted: (result: PromoteResult) => void;
}): React.JSX.Element {
  const s = t.admin.results.promote;
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<PromoteResult | null>(null);

  const confirm = (): void => {
    setBusy(true);
    setError(null);
    staffClient.opportunities
      .promote(o.id)
      .then((r) => {
        setResult(r);
        onPromoted(r);
      })
      .catch((e: unknown) => {
        setError(errorMessage(e, t.app.unknownError));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const h = result?.handoff;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t.app.close} className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{result ? s.done : s.title}</DialogTitle>
          <DialogDescription>{result ? s.sessionCreated(result.session.id) : s.body}</DialogDescription>
        </DialogHeader>
        <p className="text-sm font-medium">{effectiveTitle(o)}</p>
        {h ? (
          <dl className="grid gap-3 text-sm">
            <div>
              <dt className="text-muted-foreground text-xs font-medium">{s.handoff.problem}</dt>
              <dd>{h.problem}</dd>
            </div>
            <HandoffList label={s.handoff.affectedUsers} items={h.affectedUsers} />
            <HandoffList label={s.handoff.existingProcess} items={h.existingProcess} />
            <HandoffList label={s.handoff.tools} items={h.tools} />
            <div>
              <dt className="text-muted-foreground text-xs font-medium">{s.handoff.constraints}</dt>
              <dd>{h.constraints || t.admin.common.dash}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs font-medium">{s.handoff.expectedBenefit}</dt>
              <dd>{h.expectedBenefit || t.admin.common.dash}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs font-medium">{s.handoff.evidenceQuotes}</dt>
              <dd>
                {h.evidenceQuotes.length > 0 ? (
                  <ul className="grid gap-1">
                    {h.evidenceQuotes.map((q, n) => (
                      <li key={n}>
                        <blockquote className="border-l-2 pl-3 italic">{q}</blockquote>
                      </li>
                    ))}
                  </ul>
                ) : (
                  t.admin.common.dash
                )}
              </dd>
            </div>
          </dl>
        ) : null}
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          {result ? (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  onOpenChange(false);
                }}
              >
                {t.app.close}
              </Button>
              <Button asChild>
                <Link href={`/admin/requirements/${result.session.id}`}>{s.openSession}</Link>
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  onOpenChange(false);
                }}
              >
                {t.app.cancel}
              </Button>
              <Button onClick={confirm} disabled={busy} aria-busy={busy}>
                {busy ? <Loader2Icon className="animate-spin motion-reduce:animate-none" /> : <RocketIcon />}
                {busy ? s.starting : s.confirm}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
