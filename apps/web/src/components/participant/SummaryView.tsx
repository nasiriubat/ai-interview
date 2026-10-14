"use client";

import type { Fact } from "@aidp/shared";
import { CheckIcon, Trash2Icon } from "lucide-react";
import * as React from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import { participantErrorText } from "@/lib/api/errors";
import type { ParticipantApi } from "@/lib/api/participant";

function factLine(f: Fact): string {
  switch (f.kind) {
    case "task":
      return `${f.name} (${f.frequency})`;
    case "process":
      return f.name;
    case "information_flow":
      return `${f.from} → ${f.to}: ${f.what}`;
    case "pain_point":
      return f.description;
    case "opportunity_candidate":
      return f.title;
    case "spec_field":
      return `${f.section}: ${f.path}`;
  }
}

function FactList({ facts }: { facts: Fact[] }): React.JSX.Element {
  return (
    <div>
      <h3 className="text-sm font-medium">{t.participant.summary.factsTitle}</h3>
      <ul className="text-muted-foreground mt-1 list-disc pl-5 text-sm">
        {facts.map((f, i) => (
          <li key={i}>{factLine(f)}</li>
        ))}
      </ul>
    </div>
  );
}

/** How long, and how often, the page asks again while the summary is still being written. */
export const SUMMARY_POLL_MS = 2_500;
export const SUMMARY_POLL_TRIES = 24;

type View =
  { kind: "loading" } | { kind: "pending" } | { kind: "ready" } | { kind: "unavailable" } | { kind: "error" };

/**
 * The end-of-session summary the participant may edit, then the thank-you.
 *
 * The box is only ever the written summary (D-325). While it is still being written the page says
 * so, and when none is coming it says that: an empty editable box here read as "type your own
 * summary", and a participant's last answer typed into it became "the summary".
 */
export function SummaryView({
  api,
  available,
  onDelete,
}: {
  api: ParticipantApi;
  available: boolean;
  onDelete: () => void;
}): React.JSX.Element {
  const [summary, setSummary] = React.useState<string>("");
  const [facts, setFacts] = React.useState<Fact[]>([]);
  const [view, setView] = React.useState<View>(available ? { kind: "loading" } : { kind: "unavailable" });
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const id = React.useId();

  React.useEffect(() => {
    if (!available) {
      setView({ kind: "unavailable" });
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = (attempt: number): void => {
      api
        .getSummary()
        .then((s) => {
          if (cancelled) return;
          setFacts(s.facts);
          if (s.status === "ready" && s.summary.trim() !== "") {
            setSummary(s.summary);
            setView({ kind: "ready" });
          } else if (s.status === "pending" && attempt < SUMMARY_POLL_TRIES) {
            setView({ kind: "pending" });
            timer = setTimeout(() => {
              load(attempt + 1);
            }, SUMMARY_POLL_MS);
          } else {
            setView({ kind: "unavailable" });
          }
        })
        .catch(() => {
          if (!cancelled) setView({ kind: "error" });
        });
    };
    setView({ kind: "loading" });
    load(0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [api, available]);

  const save = async (): Promise<void> => {
    if (view.kind !== "ready") return;
    setSaving(true);
    setError(null);
    try {
      await api.putSummary(summary);
      setSaved(true);
    } catch (e) {
      setError(participantErrorText(e, "summary"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="bg-card shadow-card mt-4 grid gap-5 rounded-2xl p-5 sm:p-6"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="bg-success-soft text-success-soft-foreground grid size-10 shrink-0 place-items-center rounded-full"
        >
          <CheckIcon className="size-5" />
        </span>
        <div className="min-w-0">
          <h2 id={`${id}-title`} className="text-xl leading-tight font-semibold">
            {t.participant.summary.title}
          </h2>
          {view.kind === "unavailable" || view.kind === "error" ? null : (
            <p className="text-muted-foreground mt-1 text-sm leading-relaxed">{t.participant.summary.body}</p>
          )}
        </div>
      </div>
      {view.kind === "loading" || view.kind === "pending" ? (
        <div className="grid gap-2" aria-busy="true">
          <span className="sr-only">{t.participant.session.loadingSummary}</span>
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-24 w-full" />
          {view.kind === "pending" ? (
            <p className="text-muted-foreground text-sm" role="status">
              {t.participant.summary.generating}
            </p>
          ) : null}
        </div>
      ) : view.kind === "error" ? (
        <Alert variant="destructive">
          <AlertDescription>{t.participant.summary.loadError}</AlertDescription>
        </Alert>
      ) : view.kind === "unavailable" ? (
        <div className="grid gap-3">
          <p className="text-muted-foreground text-sm" role="status">
            {t.participant.summary.unavailable}
          </p>
          {facts.length > 0 ? <FactList facts={facts} /> : null}
        </div>
      ) : (
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Label htmlFor={`${id}-summary`}>{t.participant.summary.summaryLabel}</Label>
          <Textarea
            id={`${id}-summary`}
            value={summary}
            rows={8}
            onChange={(e) => {
              setSummary(e.target.value);
              setSaved(false);
            }}
          />
          {facts.length > 0 ? <FactList facts={facts} /> : null}
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" className="h-11" loading={saving}>
              {saving ? t.app.saving : t.participant.summary.save}
            </Button>
            {saved ? (
              <span className="text-muted-foreground inline-flex items-center gap-1 text-sm" role="status">
                <CheckIcon className="size-4" aria-hidden="true" /> {t.participant.summary.saved}
              </span>
            ) : null}
          </div>
        </form>
      )}
      <div className="bg-muted/60 rounded-xl p-4">
        <h3 className="text-sm font-semibold">{t.participant.summary.whatNext}</h3>
        <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
          {t.participant.summary.whatNextBody}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">{t.participant.summary.close}</p>
        <Button
          variant="outline"
          className="text-destructive hover:text-destructive h-11 w-full sm:w-auto"
          onClick={() => {
            setConfirmDelete(true);
          }}
        >
          <Trash2Icon aria-hidden="true" /> {t.participant.session.deleteData}
        </Button>
      </div>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.participant.session.deleteTitle}</AlertDialogTitle>
            <AlertDialogDescription>{t.participant.session.deleteBody}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t.app.cancel}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
              onClick={onDelete}
            >
              {t.participant.session.deleteConfirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
