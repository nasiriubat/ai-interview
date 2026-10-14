"use client";

import {
  isNotAi,
  MAX_MERGE,
  SOLUTION_CLASSES,
  type DepartmentComparison,
  type FactorKey,
  type SolutionClass,
  type Weights,
} from "@aidp/shared";
import { AlertTriangleIcon, InfoIcon, Loader2Icon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { AnalysisHeader } from "./AnalysisHeader";
import { CompareVersions } from "./CompareVersions";
import { DepartmentsPanel } from "./DepartmentsPanel";
import { EditsPanel } from "./EditsPanel";
import { MergeBar } from "./MergeBar";
import { MergeDialog } from "./MergeDialog";
import { OpportunityCard } from "./OpportunityCard";
import { DEFAULT_FILTERS, type Filters, OpportunityFilters } from "./OpportunityFilters";
import { OverrideSheet } from "./OverrideSheet";
import { PromoteDialog } from "./PromoteDialog";
import { SplitDialog } from "./SplitDialog";
import { WeightsPanel } from "./WeightsPanel";
import { EmptyState } from "@/components/admin/EmptyState";
import { Flash, useAction } from "@/components/admin/Flash";
import { undoToast } from "@/components/common/undoToast";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useAnalysisPolling } from "@/hooks/useAnalysisPolling";
import { useDebouncedSave } from "@/hooks/useDebouncedSave";
import { t } from "@/i18n";
import { editErrorText } from "@/lib/analysis/edit-errors";
import {
  effectiveClass,
  effectiveTitle,
  effectiveWeights,
  rerank,
  type WeightsPreset,
} from "@/lib/analysis/rank";
import { staffClient } from "@/lib/api/browser";
import { isApiError } from "@/lib/api/errors";
import type { Analysis, AnalysisDetail, ClusterEdit, Opportunity } from "@/lib/api/schemas";
import type { OpportunityStatusInput } from "@/lib/api/staff";

export interface ResultsViewProps {
  campaignId: string;
  analyses: Analysis[];
  selectedId: string | undefined;
  detail: AnalysisDetail | null;
  initialPreset: WeightsPreset;
  initialWeights: Weights;
  /** False when `features.chaining` is off for the organization. */
  canPromote?: boolean;
  /** Administrators may merge, split and rename; members may read. */
  canEdit?: boolean;
  /** `privacy.kAnonymity` in force, for the messages that say why something is not shown. */
  k?: number;
  /** The department comparison of the selected analysis; null when it could not be loaded. */
  departments?: DepartmentComparison | null;
  departmentsFailed?: boolean;
  /** The campaign's merges and splits, newest first. */
  edits?: ClusterEdit[];
}

/** The classes shown as groups of their own, in order; the rest form the "not the answer" section. */
const TECHNICAL_CLASSES: readonly SolutionClass[] = SOLUTION_CLASSES.filter((c) => !isNotAi(c));

/** The campaign results page: header, weights, filters, grouped opportunity cards, compare. */
export function ResultsView({
  campaignId,
  analyses,
  selectedId,
  detail,
  initialPreset,
  initialWeights,
  canPromote = true,
  canEdit = false,
  k = 3,
  departments = null,
  departmentsFailed = false,
  edits = [],
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
  const [splitting, setSplitting] = React.useState<Opportunity | null>(null);
  const [analyzing, setAnalyzing] = React.useState(false);
  const [picked, setPicked] = React.useState<ReadonlySet<string>>(new Set());
  const [mergeOpen, setMergeOpen] = React.useState(false);

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

  /**
   * Shortlist, dismiss and restore take effect at once and offer Undo, which sends the status the
   * card had (D-111). Undo itself does not offer Undo.
   */
  const setStatus = (o: Opportunity, status: OpportunityStatusInput, offerUndo = true): void => {
    const previous: OpportunityStatusInput =
      o.status === "shortlisted" || o.status === "dismissed" ? o.status : "new";
    void action
      .run(async () => {
        replace(await staffClient.opportunities.setStatus(o.id, status));
      })
      .then((ok) => {
        if (!ok || !offerUndo) return;
        const title = effectiveTitle(o);
        const text =
          status === "shortlisted"
            ? s.undoShortlisted(title)
            : status === "dismissed"
              ? s.undoDismissed(title)
              : s.undoRestored(title);
        undoToast(text, () => {
          setStatus(o, previous, false);
        });
      });
  };

  // ---- merge, split, rename, undo (FR-18) ----------------------------------------------------
  const newest = analyses[0];
  const runActive = latest?.status === "queued" || latest?.status === "running";
  const onNewest = selected !== undefined && selected.id === newest?.id;
  const editable = canEdit && onNewest && selected.status === "done" && !runActive;
  const newerReady =
    latest !== undefined && selected !== undefined && latest.id !== selected.id && latest.status === "done";

  /** Sends the inverse of an edit: one more edit run, with the same Undo-free toast as the others. */
  const undoEdit = (editId: string): void => {
    void action
      .run(async () => {
        try {
          await staffClient.analyses.undoClusterEdit(campaignId, editId);
        } catch (e) {
          throw new Error(editErrorText(e, k));
        }
        router.refresh();
      }, s.edits.undoStarted)
      .then(() => undefined);
  };

  const offerUndo = (text: string, editId: string | undefined): void => {
    if (!editId) return;
    undoToast(text, () => {
      undoEdit(editId);
    });
  };

  const toggle = (id: string, on: boolean): void => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const pickedOpps = ranked.filter((o) => picked.has(o.id));
  const mergeDefaultTitle = pickedOpps[0] ? effectiveTitle(pickedOpps[0]) : "";

  const merge = (title: string): void => {
    if (!selected) return;
    void action
      .run(async () => {
        let editId: string | undefined;
        try {
          const r = await staffClient.analyses.merge(selected.id, {
            opportunityIds: pickedOpps.map((o) => o.id),
            title,
          });
          editId = r.editId;
        } catch (e) {
          throw new Error(editErrorText(e, k));
        }
        setPicked(new Set());
        router.refresh();
        offerUndo(s.merge.undone(title), editId);
      }, s.merge.started)
      .then(() => undefined);
  };

  const rename = async (o: Opportunity, title: string): Promise<void> => {
    try {
      replace(await staffClient.opportunities.override(o.id, { title }));
    } catch (e) {
      throw new Error(editErrorText(e, k));
    }
  };

  const visible = ranked.filter(
    (o) =>
      (filters.solutionClass === "all" || effectiveClass(o) === filters.solutionClass) &&
      (filters.status === "all" || o.status === filters.status) &&
      o.rankScore >= filters.minRank,
  );
  const groups = TECHNICAL_CLASSES.map((cls) => ({
    cls,
    items: visible.filter((o) => effectiveClass(o) === cls),
  })).filter((g) => g.items.length > 0);
  // The one predicate the report and the dashboard use (FR-16a), so the three never disagree.
  const notAi = visible.filter((o) => isNotAi(effectiveClass(o)));

  const card = (o: Opportunity, inNotAi: boolean): React.JSX.Element => (
    <OpportunityCard
      key={o.id}
      opportunity={o}
      busy={action.busy}
      whyNotAiFirst={inNotAi}
      onStatus={(st) => {
        setStatus(o, st);
      }}
      onEdit={() => {
        setEditing(o);
      }}
      canPromote={canPromote}
      onPromote={() => {
        setPromoting(o);
      }}
      merge={
        editable
          ? {
              selected: picked.has(o.id),
              disabled: o.status === "promoted" || (!picked.has(o.id) && picked.size >= MAX_MERGE),
              onChange: (on) => {
                toggle(o.id, on);
              },
            }
          : undefined
      }
      onSplit={
        editable && o.status !== "promoted"
          ? () => {
              setSplitting(o);
            }
          : undefined
      }
      onRename={editable ? (title) => rename(o, title) : undefined}
    />
  );

  const orphaned = Array.isArray(selected?.stats.orphanedEdits)
    ? (selected.stats.orphanedEdits as unknown[]).length
    : 0;
  const unassigned = typeof selected?.stats.unassignedNew === "number" ? selected.stats.unassignedNew : 0;

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
      {[latest, selected]
        .filter((a, i, all) => a?.status === "failed" && all.indexOf(a) === i)
        .map((a) =>
          a ? (
            <Alert key={a.id} variant="destructive">
              <AlertTriangleIcon />
              <AlertTitle>{s.versionOption(a.version, s.status.failed)}</AlertTitle>
              <AlertDescription>{s.failedBody(a.stats.error ?? t.app.unknownError)}</AlertDescription>
            </Alert>
          ) : null,
        )}
      <div aria-live="polite" className="grid gap-3 empty:hidden">
        {runActive && selected?.status === "done" ? (
          <Alert>
            <Loader2Icon className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            <AlertTitle>{s.reanalysing}</AlertTitle>
            <AlertDescription>{s.reanalysingBody}</AlertDescription>
          </Alert>
        ) : null}
        {newerReady ? (
          <Alert>
            <InfoIcon aria-hidden="true" />
            <AlertTitle>{s.newerReady}</AlertTitle>
            <AlertDescription>
              <Button asChild variant="link" className="h-auto p-0">
                <Link href={`/admin/campaigns/${campaignId}/results?version=${latest.id}`}>
                  {s.showNewer}
                </Link>
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {selected?.status === "done" && selected.preliminary ? (
          <Alert>
            <InfoIcon aria-hidden="true" />
            <AlertTitle>{s.preliminaryTitle}</AlertTitle>
            <AlertDescription>{s.preliminaryHint}</AlertDescription>
          </Alert>
        ) : null}
        {canEdit && selected?.status === "done" && !onNewest && !newerReady ? (
          <p className="text-muted-foreground text-xs">{s.onlyNewest}</p>
        ) : null}
      </div>

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
              <>
                {groups.map((g) => (
                  <section key={g.cls} aria-labelledby={`class-${g.cls}`} className="grid gap-3">
                    <h2 id={`class-${g.cls}`} className="flex items-baseline gap-2 text-base font-semibold">
                      {s.classes[g.cls]}
                      <span className="text-muted-foreground text-xs font-normal">
                        {s.classCount(g.items.length)}
                      </span>
                    </h2>
                    {g.items.map((o) => card(o, false))}
                  </section>
                ))}
                {notAi.length > 0 ? (
                  <section aria-labelledby="class-not-ai" className="grid gap-3">
                    <div>
                      <h2 id="class-not-ai" className="flex items-baseline gap-2 text-base font-semibold">
                        {s.notAi.title}
                        <span className="text-muted-foreground text-xs font-normal">
                          {s.classCount(notAi.length)}
                        </span>
                      </h2>
                      <p className="text-muted-foreground mt-0.5 text-[13px]">{s.notAi.body}</p>
                    </div>
                    {notAi.map((o) => card(o, true))}
                  </section>
                ) : null}
              </>
            )}
            <MergeBar
              count={picked.size}
              max={MAX_MERGE}
              onMerge={() => {
                setMergeOpen(true);
              }}
              onClear={() => {
                setPicked(new Set());
              }}
            />
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
            <DepartmentsPanel comparison={departments} error={departmentsFailed} />
            {canEdit ? (
              <EditsPanel
                edits={edits}
                orphaned={orphaned}
                unassigned={unassigned}
                canUndo={editable}
                busy={action.busy}
                onUndo={(e) => {
                  undoEdit(e.id);
                }}
              />
            ) : null}
            <CompareVersions current={selected} analyses={analyses} />
          </aside>
        </div>
      )}

      <MergeDialog
        open={mergeOpen}
        onOpenChange={setMergeOpen}
        titles={pickedOpps.map((o) => effectiveTitle(o))}
        defaultTitle={mergeDefaultTitle}
        onConfirm={merge}
      />
      {splitting ? (
        <SplitDialog
          key={splitting.id}
          opportunity={splitting}
          k={k}
          open
          onOpenChange={(open) => {
            if (!open) setSplitting(null);
          }}
          onSplit={(editId) => {
            router.refresh();
            offerUndo(s.split.undone(effectiveTitle(splitting)), editId);
          }}
        />
      ) : null}
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
