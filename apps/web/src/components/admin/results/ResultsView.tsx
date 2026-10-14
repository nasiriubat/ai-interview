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
import {
  AlertTriangleIcon,
  BarChart3Icon,
  BuildingIcon,
  HistoryIcon,
  InfoIcon,
  ListOrderedIcon,
  Loader2Icon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { AnalysisHeader } from "./AnalysisHeader";
import { CompareVersions } from "./CompareVersions";
import { DepartmentsPanel } from "./DepartmentsPanel";
import { EditsPanel } from "./EditsPanel";
import { MergeBar } from "./MergeBar";
import { MergeDialog } from "./MergeDialog";
import { OpportunityPanel } from "./OpportunityPanel";
import { OpportunityRow } from "./OpportunityRow";
import { DEFAULT_FILTERS, type Filters, OpportunityFilters } from "./OpportunityFilters";
import { OverviewTab } from "./OverviewTab";
import { OverrideSheet } from "./OverrideSheet";
import { PromoteDialog } from "./PromoteDialog";
import { SplitDialog } from "./SplitDialog";
import { WeightsPanel } from "./WeightsPanel";
import { CLASS_COLOR } from "@/components/admin/charts/palette";
import { EmptyState } from "@/components/admin/EmptyState";
import { SectionTitle } from "@/components/admin/Panel";
import { Flash, useAction } from "@/components/admin/Flash";
import { undoToast } from "@/components/common/undoToast";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAnalysisPolling } from "@/hooks/useAnalysisPolling";
import { useDebouncedSave } from "@/hooks/useDebouncedSave";
import { t } from "@/i18n";
import { editErrorText } from "@/lib/analysis/edit-errors";
import type { ResultsTab } from "@/lib/analysis/tabs";
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
import { formatDate } from "@/lib/utils";

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
  /** The versions table, rendered by the server page (it is a paginated list). */
  versions?: React.ReactNode;
  initialTab?: ResultsTab;
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
  versions = null,
  initialTab = "overview",
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
  const [tab, setTabState] = React.useState<ResultsTab>(initialTab);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [weightsOpen, setWeightsOpen] = React.useState(false);

  const setTab = (next: ResultsTab): void => {
    setTabState(next);
    // The tab is part of the address so a reload or a shared link lands on it (D-372); the data
    // does not depend on it, so the URL is rewritten in place without asking the server again.
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    window.history.replaceState(null, "", url);
  };

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

  const q = filters.query.trim().toLowerCase();
  const visible = ranked.filter(
    (o) =>
      (filters.solutionClass === "all" || effectiveClass(o) === filters.solutionClass) &&
      (filters.status === "all" || o.status === filters.status) &&
      o.rankScore >= filters.minRank &&
      (q === "" || effectiveTitle(o).toLowerCase().includes(q) || o.summary.toLowerCase().includes(q)),
  );
  const groups = TECHNICAL_CLASSES.map((cls) => ({
    cls,
    items: visible.filter((o) => effectiveClass(o) === cls),
  })).filter((g) => g.items.length > 0);
  // The one predicate the report and the dashboard use (FR-16a), so the three never disagree.
  const notAi = visible.filter((o) => isNotAi(effectiveClass(o)));

  const opened = openId ? (opps.find((o) => o.id === openId) ?? null) : null;

  const row = (o: Opportunity, inNotAi: boolean): React.JSX.Element => (
    <OpportunityRow
      key={o.id}
      opportunity={o}
      busy={action.busy}
      active={openId === o.id}
      whyNotAiFirst={inNotAi}
      onOpen={() => {
        setOpenId(o.id);
      }}
      onStatus={(st) => {
        setStatus(o, st);
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
    />
  );

  const orphaned = Array.isArray(selected?.stats.orphanedEdits)
    ? (selected.stats.orphanedEdits as unknown[]).length
    : 0;
  const unassigned = typeof selected?.stats.unassignedNew === "number" ? selected.stats.unassignedNew : 0;
  const w = t.ws.tabs;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
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
          <Alert variant="warning">
            <InfoIcon aria-hidden="true" />
            <AlertTitle>{s.preliminaryTitle}</AlertTitle>
            <AlertDescription>{s.preliminaryHint}</AlertDescription>
          </Alert>
        ) : null}
        {latest?.status === "queued" && latest.stats.trigger === "auto" && latest.stats.autoStartAt ? (
          <Alert>
            <InfoIcon aria-hidden="true" />
            <AlertDescription>{s.autoWaiting(formatDate(latest.stats.autoStartAt))}</AlertDescription>
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
        <Tabs
          value={tab}
          onValueChange={(v) => {
            setTab(v as ResultsTab);
          }}
          className="min-w-0 gap-5 [&>*]:min-w-0"
        >
          <TabsList aria-label={t.ws.tabs.label} className="w-full max-w-full overflow-x-auto">
            <TabsTrigger value="overview">
              <BarChart3Icon aria-hidden="true" /> {w.overview}
            </TabsTrigger>
            <TabsTrigger value="opportunities">
              <ListOrderedIcon aria-hidden="true" /> {w.opportunities}
              <span className="bg-muted text-muted-foreground rounded-full px-1.5 text-xs tabular-nums">
                {ranked.length}
              </span>
            </TabsTrigger>
            <TabsTrigger value="departments">
              <BuildingIcon aria-hidden="true" /> {w.departments}
            </TabsTrigger>
            <TabsTrigger value="history">
              <HistoryIcon aria-hidden="true" /> {w.history}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview">
            <OverviewTab
              analysis={selected}
              opportunities={ranked}
              onShowOpportunities={() => {
                setTab("opportunities");
              }}
              onOpen={(id) => {
                setOpenId(id);
              }}
            />
          </TabsContent>

          <TabsContent value="opportunities" className="grid grid-cols-[minmax(0,1fr)] gap-5">
            <OpportunityFilters
              filters={filters}
              onChange={setFilters}
              shown={visible.length}
              total={ranked.length}
              onOpenWeights={() => {
                setWeightsOpen(true);
              }}
            />
            {ranked.length === 0 ? (
              <EmptyState text={s.empty} />
            ) : visible.length === 0 ? (
              <EmptyState text={s.noMatches}>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setFilters(DEFAULT_FILTERS);
                  }}
                >
                  {t.ws.filters.clear}
                </Button>
              </EmptyState>
            ) : (
              <>
                {groups.map((g) => (
                  <section
                    key={g.cls}
                    aria-labelledby={`class-${g.cls}`}
                    className="bg-card shadow-card overflow-hidden rounded-lg"
                  >
                    <h2
                      id={`class-${g.cls}`}
                      className="flex items-baseline gap-2 border-b px-4 py-3 text-[15px] font-semibold"
                    >
                      <span
                        aria-hidden="true"
                        className="size-2.5 self-center rounded-[3px]"
                        style={{ backgroundColor: CLASS_COLOR[g.cls] }}
                      />
                      {s.classes[g.cls]}
                      <span className="text-muted-foreground text-xs font-normal">
                        {s.classCount(g.items.length)}
                      </span>
                    </h2>
                    <ul>{g.items.map((o) => row(o, false))}</ul>
                  </section>
                ))}
                {notAi.length > 0 ? (
                  <section
                    aria-labelledby="class-not-ai"
                    className="bg-card shadow-card overflow-hidden rounded-lg"
                  >
                    <div className="bg-warning-soft/50 border-b px-4 py-3">
                      <h2 id="class-not-ai" className="flex items-baseline gap-2 text-[15px] font-semibold">
                        {s.notAi.title}
                        <span className="text-muted-foreground text-xs font-normal">
                          {s.classCount(notAi.length)}
                        </span>
                      </h2>
                      <p className="text-muted-foreground mt-0.5 text-[13px]">{s.notAi.body}</p>
                    </div>
                    <ul>{notAi.map((o) => row(o, true))}</ul>
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
          </TabsContent>

          <TabsContent value="departments">
            <DepartmentsPanel comparison={departments} error={departmentsFailed} />
          </TabsContent>

          <TabsContent value="history" className="grid grid-cols-[minmax(0,1fr)] gap-5">
            <section aria-labelledby="versions-title" className="grid gap-3">
              <SectionTitle id="versions-title">{t.ws.history.title}</SectionTitle>
              {versions}
            </section>
            <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 xl:grid-cols-2">
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
            </div>
          </TabsContent>
        </Tabs>
      )}

      <WeightsPanel
        open={weightsOpen}
        onOpenChange={setWeightsOpen}
        preset={preset}
        weights={weights}
        onPresetChange={(p) => {
          if (p === "custom") setCustom(weights);
          setPreset(p);
        }}
        onWeightChange={changeWeight}
        saveState={saveState}
      />
      <MergeDialog
        open={mergeOpen}
        onOpenChange={setMergeOpen}
        titles={pickedOpps.map((o) => effectiveTitle(o))}
        defaultTitle={mergeDefaultTitle}
        onConfirm={merge}
      />
      {opened && !editing && !promoting && !splitting ? (
        <OpportunityPanel
          key={opened.id}
          opportunity={opened}
          open
          busy={action.busy}
          canPromote={canPromote}
          k={k}
          onOpenChange={(open) => {
            if (!open) setOpenId(null);
          }}
          onStatus={(st) => {
            setStatus(opened, st);
          }}
          onEdit={() => {
            setEditing(opened);
          }}
          onPromote={() => {
            setPromoting(opened);
          }}
          onSplit={
            editable && opened.status !== "promoted"
              ? () => {
                  setSplitting(opened);
                }
              : undefined
          }
          onRename={editable ? (title) => rename(opened, title) : undefined}
        />
      ) : null}
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
            setOpenId(null);
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
            setOpenId(null);
          }}
        />
      ) : null}
    </div>
  );
}
