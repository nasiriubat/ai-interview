"use client";

import { BarChart3Icon, FileTextIcon, PlayIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { Flash, useAction } from "@/components/admin/Flash";
import { Panel } from "@/components/admin/Panel";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { DateText } from "@/components/common/DateText";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAnalysisPolling } from "@/hooks/useAnalysisPolling";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import { isApiError } from "@/lib/api/errors";
import type { Analysis } from "@/lib/api/schemas";

/**
 * Where the campaign's analysis stands and the one next step: run it (a preliminary run below the
 * completion threshold says so), watch it, or open what it produced. Polls while a run is active,
 * as the results page does, so the card is never stale beside a running analysis.
 */
export function AnalysisCard({
  campaignId,
  latest,
  completed,
  threshold,
}: {
  campaignId: string;
  latest: Analysis | undefined;
  completed: number;
  threshold: number;
}): React.JSX.Element {
  const s = t.admin.campaigns;
  const router = useRouter();
  const action = useAction();
  const live = useAnalysisPolling(campaignId, latest);
  const running = live?.status === "queued" || live?.status === "running";
  const met = threshold > 0 && completed >= threshold;

  const analyze = (): void => {
    void action.run(async () => {
      try {
        await staffClient.analyses.start(campaignId);
      } catch (e) {
        if (isApiError(e) && e.status === 409) throw new Error(t.admin.results.alreadyRunning);
        throw e;
      }
      router.refresh();
    }, t.admin.results.started);
  };

  const guidance = running
    ? s.analysisRunning
    : completed === 0
      ? s.analysisNone
      : met
        ? s.analysisReady
        : s.analysisNeedMore(Math.max(0, threshold - completed));

  return (
    <Panel
      title={s.analysisTitle}
      actions={
        <Button
          type="button"
          size="sm"
          loading={action.busy}
          disabled={action.busy || running || completed === 0}
          onClick={analyze}
        >
          <PlayIcon aria-hidden="true" /> {t.admin.results.analyzeNow}
        </Button>
      }
    >
      <div className="grid gap-3 px-5 py-4 text-sm">
        {live ? (
          <p className="flex flex-wrap items-center gap-2">
            <span className="text-foreground font-medium">{s.analysisLatest(live.version)}</span>
            <StatusBadge status={live.status} />
            {live.preliminary ? <Badge variant="outline">{t.admin.results.preliminary}</Badge> : null}
            <span className="text-muted-foreground text-xs">
              <DateText iso={live.createdAt} />
            </span>
          </p>
        ) : null}
        <p role="status">{guidance}</p>
        <Flash flash={action.flash} />
        {live ? (
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={`/admin/campaigns/${campaignId}/results`}>
                <BarChart3Icon aria-hidden="true" /> {s.analysisOpenResults}
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={`/admin/campaigns/${campaignId}/report`}>
                <FileTextIcon aria-hidden="true" /> {s.analysisOpenReport}
              </Link>
            </Button>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
