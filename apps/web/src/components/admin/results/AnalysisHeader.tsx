"use client";

import { Loader2Icon, PlayIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { StatTile } from "@/components/admin/StatTile";
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
  const stats = selected?.stats;
  return (
    <section aria-label={s.stats.title} className="grid gap-4 print:hidden">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          {latest ? (
            <div className="grid gap-1.5">
              <span className="text-muted-foreground text-xs font-medium">{s.statusLabel}</span>
              <div className="flex items-center gap-2" aria-live="polite">
                <AnalysisStatusBadge status={latest.status} />
                {busy ? <span className="text-muted-foreground text-xs">{s.polling}…</span> : null}
              </div>
            </div>
          ) : null}
          {analyses.length > 0 ? (
            <div className="grid gap-1.5">
              <Label htmlFor="analysis-version">{s.version}</Label>
              <Combobox
                id="analysis-version"
                className="min-w-64"
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
          {selected && !selected.stats.thresholdMet ? (
            <Badge variant="warning" title={s.preliminaryHint}>
              {s.preliminary}
            </Badge>
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
      </div>
      {selected && !selected.stats.thresholdMet ? (
        <p className="text-muted-foreground text-xs">{s.preliminaryHint}</p>
      ) : null}
      {/* A run the platform queued at the threshold says so and when it will start (D-324). */}
      {latest?.status === "queued" && latest.stats.trigger === "auto" && latest.stats.autoStartAt ? (
        <p className="text-muted-foreground text-xs" role="status">
          {s.autoWaiting(formatDate(latest.stats.autoStartAt))}
        </p>
      ) : null}
      {stats ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <StatTile label={s.stats.sessions} value={stats.sessions} />
          <StatTile label={s.stats.facts} value={stats.facts} />
          <StatTile label={s.stats.clusters} value={stats.clusters} />
          <StatTile label={s.stats.participants} value={stats.participants} />
          <StatTile
            label={s.stats.embedding}
            value={
              stats.embedding
                ? stats.embedding === "provider"
                  ? s.stats.embeddingProvider
                  : s.stats.embeddingLexical
                : t.admin.common.dash
            }
          />
        </div>
      ) : null}
    </section>
  );
}
