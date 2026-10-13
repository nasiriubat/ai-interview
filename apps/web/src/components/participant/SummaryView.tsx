"use client";

import type { Fact } from "@aidp/shared";
import { CheckIcon } from "lucide-react";
import * as React from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
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

/** The end-of-session summary the participant may edit, then the thank-you. */
export function SummaryView({
  api,
  available,
  onDelete,
}: {
  api: ParticipantApi;
  available: boolean;
  onDelete: () => void;
}): React.JSX.Element {
  const [summary, setSummary] = React.useState<string | null>(null);
  const [facts, setFacts] = React.useState<Fact[]>([]);
  const [loading, setLoading] = React.useState(available);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const id = React.useId();

  React.useEffect(() => {
    if (!available) return;
    let cancelled = false;
    api
      .getSummary()
      .then((s) => {
        if (cancelled) return;
        setSummary(s.summary);
        setFacts(s.facts);
      })
      .catch(() => {
        if (!cancelled) setSummary(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, available]);

  const save = async (): Promise<void> => {
    if (summary === null) return;
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
    <section aria-labelledby={`${id}-title`} className="bg-card mt-2 grid gap-4 rounded-2xl border p-5">
      <div>
        <h2 id={`${id}-title`} className="text-xl font-semibold">
          {t.participant.summary.title}
        </h2>
        <p className="text-muted-foreground text-sm">{t.participant.summary.body}</p>
      </div>
      {loading ? (
        <div className="grid gap-2" aria-busy="true">
          <span className="sr-only">{t.participant.session.loadingSummary}</span>
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : summary !== null ? (
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
          {facts.length > 0 ? (
            <div>
              <h3 className="text-sm font-medium">{t.participant.summary.factsTitle}</h3>
              <ul className="text-muted-foreground mt-1 list-disc pl-5 text-sm">
                {facts.map((f, i) => (
                  <li key={i}>{factLine(f)}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={saving}>
              {saving ? t.app.saving : t.participant.summary.save}
            </Button>
            {saved ? (
              <span className="text-muted-foreground inline-flex items-center gap-1 text-sm" role="status">
                <CheckIcon className="size-4" aria-hidden="true" /> {t.participant.summary.saved}
              </span>
            ) : null}
          </div>
        </form>
      ) : null}
      <div>
        <h3 className="text-sm font-medium">{t.participant.summary.whatNext}</h3>
        <p className="text-muted-foreground text-sm">{t.participant.summary.whatNextBody}</p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">{t.participant.summary.close}</p>
        <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={onDelete}>
          {t.participant.session.deleteData}
        </Button>
      </div>
    </section>
  );
}
