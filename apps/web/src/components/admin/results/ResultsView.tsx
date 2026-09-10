"use client";

import { SOLUTION_CLASSES, type FactorKey, type Weights } from "@aidp/shared";
import { AlertTriangleIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { AnalysisHeader } from "./AnalysisHeader";
import { CompareVersions } from "./CompareVersions";
import { OpportunityCard } from "./OpportunityCard";
import { DEFAULT_FILTERS, type Filters, OpportunityFilters } from "./OpportunityFilters";
import { OverrideSheet } from "./OverrideSheet";
import { PromoteDialog } from "./PromoteDialog";
import { WeightsPanel } from "./WeightsPanel";
import { EmptyState } from "@/components/admin/EmptyState";
import { Flash, useAction } from "@/components/admin/Flash";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useAnalysisPolling } from "@/hooks/useAnalysisPolling";
import { useDebouncedSave } from "@/hooks/useDebouncedSave";
import { t } from "@/i18n";
import { effectiveClass, effectiveWeights, rerank, type WeightsPreset } from "@/lib/analysis/rank";
import { staffClient } from "@/lib/api/browser";
import { isApiError } from "@/lib/api/errors";
import type { Analysis, AnalysisDetail, Opportunity } from "@/lib/api/schemas";
import type { OpportunityStatusInput } from "@/lib/api/staff";

export interface ResultsViewProps {
  campaignId: string;
  analyses: Analysis[];
  selectedId: string | undefined;
  detail: AnalysisDetail | null;
  initialPreset: WeightsPreset;
  initialWeights: Weights;
}

/** The campaign results page: header, weights, filters, grouped opportunity cards, compare. */
export function ResultsView({
  campaignId,
  analyses,
  selectedId,
  detail,
  initialPreset,
  initialWeights,
}: ResultsViewProps): React.JSX.Element {
  const s = t.admin.results;
  const router = useRouter();
  const action = useAction();
  const latest = useAnalysisPolling(campaignId, analyses[0]);
  const selected = analyses.find((a) => a.id === selectedId);

  const [opps, setOpps] = React.useState<Opportunity[]>(detail?.opportunities ?? []);
  const [preset, setPreset] = React.useState<WeightsPreset>(initialPreset);
  const [custom, setCustom] = React.useState<Weights>(initialWeights);
  const [filters, setFilters] = React.useState<Filters>(DEFAULT_FILTERS);
  const [editing, setEditing] = React.useState<Opportunity | null>(null);
  const [promoting, setPromoting] = React.useState<Opportunity | null>(null);
  const [analyzing, setAnalyzing] = React.useState(false);

  const weights = effectiveWeights(preset, custom);
  const ranked = React.useMemo(() => rerank(opps, weights), [opps, weights]);

  const weightsSetting = React.useMemo(() => ({ preset, weights }), [preset, weights]);
  const saveState = useDebouncedSave(weightsSetting, async (v) => {
    await staffClient.settings.put(
      { scope: "campaign", scopeId: campaignId },
      { "analysis.weightsPreset": v.preset, "analysis.weights": v.weights },
    );
  });

  const changeWeight = (key: FactorKey, value: number): void => {
    setCustom({ ...weights, [key]: value });
    setPreset("custom");
  };

  const analyze = (): void => {
    setAnalyzing(true);
    void action
      .run(async () => {
        try {
          await staffClient.analyses.start(campaignId);
        } catch (e) {
          if (isApiError(e) && e.status === 409) throw new Error(s.alreadyRunning);
          throw e;
        }
        router.refresh();
      }, s.started)
      .finally(() => {
        setAnalyzing(false);
      });
  };

  const replace = (updated: Opportunity): void => {
    setOpps((prev) => prev.map((o) => (o.id === updated.id ? updated : o)));
  };

  const setStatus = (o: Opportunity, status: OpportunityStatusInput): void => {
    void action.run(async () => {
      replace(await staffClient.opportunities.setStatus(o.id, status));
    }, s.statusChanged);
  };

  const visible = ranked.filter(
    (o) =>
      (filters.solutionClass === "all" || effectiveClass(o) === filters.solutionClass) &&
      (filters.status === "all" || o.status === filters.status) &&
      o.rankScore >= filters.minRank,
  );
  const groups = SOLUTION_CLASSES.map((cls) => ({
    cls,
    items: visible.filter((o) => effectiveClass(o) === cls),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="grid gap-6">
      <AnalysisHeader
        campaignId={campaignId}
        analyses={analyses}
        latest={latest}
        selected={selected}
        onAnalyze={analyze}
        analyzing={analyzing}
      />
      <Flash flash={action.flash} />
      {selected?.status === "failed" ? (
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertTitle>{s.status.failed}</AlertTitle>
          <AlertDescription>{s.failedBody(selected.stats.error ?? t.app.unknownError)}</AlertDescription>
        </Alert>
      ) : null}

      {analyses.length === 0 ? (
        <EmptyState text={s.noAnalyses} />
      ) : !selected || selected.status === "queued" || selected.status === "running" ? (
        <EmptyState text={s.noResultsYet} />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="grid gap-4">
            <OpportunityFilters
              filters={filters}
              onChange={setFilters}
              shown={visible.length}
              total={ranked.length}
            />
            {ranked.length === 0 ? (
              <EmptyState text={s.empty} />
            ) : visible.length === 0 ? (
              <EmptyState text={s.noMatches} />
            ) : (
              groups.map((g) => (
                <section key={g.cls} aria-labelledby={`class-${g.cls}`} className="grid gap-3">
                  <h2 id={`class-${g.cls}`} className="flex items-baseline gap-2 text-base font-semibold">
                    {s.classes[g.cls]}
                    <span className="text-muted-foreground text-xs font-normal">
                      {s.classCount(g.items.length)}
                    </span>
                  </h2>
                  {g.items.map((o) => (
                    <OpportunityCard
                      key={o.id}
                      opportunity={o}
                      busy={action.busy}
                      onStatus={(st) => {
                        setStatus(o, st);
                      }}
                      onEdit={() => {
                        setEditing(o);
                      }}
                      onPromote={() => {
                        setPromoting(o);
                      }}
                    />
                  ))}
                </section>
              ))
            )}
          </div>
          <aside className="grid content-start gap-6">
            <WeightsPanel
              preset={preset}
              weights={weights}
              onPresetChange={(p) => {
                if (p === "custom") setCustom(weights);
                setPreset(p);
              }}
              onWeightChange={changeWeight}
              saveState={saveState}
            />
            <CompareVersions current={selected} analyses={analyses} />
          </aside>
        </div>
      )}

      {editing ? (
        <OverrideSheet
          key={editing.id}
          opportunity={editing}
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          onSaved={replace}
        />
      ) : null}
      {promoting ? (
        <PromoteDialog
          key={promoting.id}
          opportunity={promoting}
          open
          onOpenChange={(open) => {
            if (!open) setPromoting(null);
          }}
          onPromoted={() => {
            replace({ ...promoting, status: "promoted" });
          }}
        />
      ) : null}
    </div>
  );
}
