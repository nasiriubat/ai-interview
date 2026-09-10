"use client";

import { Loader2Icon, PlayIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { StatTile } from "@/components/admin/StatTile";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
              <select
                id="analysis-version"
                value={selected?.id ?? ""}
                onChange={(e) => {
                  const params = new URLSearchParams({ version: e.target.value });
                  router.push(`/admin/campaigns/${campaignId}/results?${params.toString()}`);
                }}
                className="border-input bg-background focus-visible:ring-ring/50 h-9 rounded-md border px-2 text-sm outline-none focus-visible:ring-[3px]"
              >
                {analyses.map((a, i) => (
                  <option key={a.id} value={a.id}>
                    {s.versionOption(a.version, s.status[a.status])}
                    {i === 0 ? ` (${s.latest})` : ""}
                    {a.preliminary ? ` · ${s.preliminary}` : ""} · {formatDate(a.finishedAt ?? a.createdAt)}
                  </option>
                ))}
              </select>
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
