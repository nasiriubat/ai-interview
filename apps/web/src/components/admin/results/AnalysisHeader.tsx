"use client";

import { CalendarClockIcon, Loader2Icon, PlayIcon, ZapIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { startNavigationProgress } from "@/components/common/NavigationProgress";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Label } from "@/components/ui/label";
import { t } from "@/i18n";
import type { Analysis, AnalysisStatus } from "@/lib/api/schemas";
import { formatDate } from "@/lib/utils";

const STATUS_TONE: Record<AnalysisStatus, "secondary" | "warning" | "success" | "destructive"> = {
  queued: "secondary",
  running: "warning",
  done: "success",
  failed: "destructive",
};

export function AnalysisStatusBadge({ status }: { status: AnalysisStatus }): React.JSX.Element {
  return (
    <Badge variant={STATUS_TONE[status]}>
      {status === "queued" || status === "running" ? (
        <Loader2Icon className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
      ) : null}
      {t.admin.results.status[status]}
    </Badge>
  );
}

/**
 * The run bar (D-372): which version is on screen, how it ran, and the one action that makes a new
 * one. It is a single quiet strip so the results, not the controls, are the first thing on the page.
 */
export function AnalysisHeader({
  campaignId,
  analyses,
  latest,
  selected,
  onAnalyze,
  analyzing,
}: {
  campaignId: string;
  analyses: Analysis[];
  latest: Analysis | undefined;
  selected: Analysis | undefined;
  onAnalyze: () => void;
  analyzing: boolean;
}): React.JSX.Element {
  const router = useRouter();
  const s = t.admin.results;
  const busy = latest?.status === "queued" || latest?.status === "running";
  const shown = selected ?? latest;
  return (
    <section
      aria-label={t.ws.run.title}
      className="bg-muted/50 flex flex-wrap items-end justify-between gap-x-4 gap-y-3 rounded-lg px-4 py-3 print:hidden"
    >
      <div className="flex min-w-0 flex-wrap items-end gap-x-4 gap-y-3">
        {analyses.length > 0 ? (
          <div className="grid min-w-0 gap-1">
            <Label htmlFor="analysis-version" className="text-muted-foreground text-xs">
              {s.version}
            </Label>
            <Combobox
              id="analysis-version"
              className="w-full min-w-56 sm:w-80"
              value={selected?.id ?? ""}
              onChange={(id) => {
                const params = new URLSearchParams({ version: id });
                startNavigationProgress();
                router.push(`/admin/campaigns/${campaignId}/results?${params.toString()}`);
              }}
              options={analyses.map((a, i) => ({
                value: a.id,
                label: `${s.versionOption(a.version, s.status[a.status])}${i === 0 ? ` (${s.latest})` : ""}${
                  a.preliminary ? ` · ${s.preliminary}` : ""
                }${a.stats.trigger ? ` · ${s.trigger[a.stats.trigger]}` : ""}`,
                detail: formatDate(a.finishedAt ?? a.createdAt),
              }))}
              labels={{
                placeholder: s.version,
                search: t.admin.list.searchPlaceholder,
                empty: t.admin.list.noMatches,
              }}
            />
          </div>
        ) : null}
        {latest ? (
          <div className="flex flex-wrap items-center gap-2 pb-1.5" aria-live="polite">
            <AnalysisStatusBadge status={latest.status} />
            {busy ? <span className="text-muted-foreground text-xs">{s.polling}…</span> : null}
            {shown?.stats.trigger === "auto" ? (
              <Badge variant="outline">
                <ZapIcon /> {t.ws.run.automatic}
              </Badge>
            ) : null}
            {selected && (selected.preliminary || !selected.stats.thresholdMet) ? (
              <Badge variant="warning" title={s.preliminaryHint}>
                {s.preliminary}
              </Badge>
            ) : null}
            {selected?.status === "done" && selected.finishedAt ? (
              <span className="text-muted-foreground flex items-center gap-1 text-xs">
                <CalendarClockIcon className="size-3.5" aria-hidden="true" />
                {t.ws.run.finished(formatDate(selected.finishedAt))}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      <Button onClick={onAnalyze} disabled={busy || analyzing} aria-busy={busy || analyzing}>
        {busy || analyzing ? (
          <Loader2Icon className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
        ) : (
          <PlayIcon aria-hidden="true" />
        )}
        {busy || analyzing ? s.analyzing : s.analyzeNow}
      </Button>
    </section>
  );
}
