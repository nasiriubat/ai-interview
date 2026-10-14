"use client";

import { type OpportunityStatus, SOLUTION_CLASSES, type SolutionClass } from "@aidp/shared";
import { FilterXIcon, SearchIcon, SlidersHorizontalIcon } from "lucide-react";
import * as React from "react";
import { IconButton } from "@/components/admin/IconButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { t } from "@/i18n";

export const STATUS_KEYS = [
  "new",
  "shortlisted",
  "promoted",
  "dismissed",
] as const satisfies readonly OpportunityStatus[];

export interface Filters {
  solutionClass: SolutionClass | "all";
  status: OpportunityStatus | "all";
  minRank: number;
  query: string;
}

export const DEFAULT_FILTERS: Filters = { solutionClass: "all", status: "all", minRank: 0, query: "" };

const MIN_RANKS = [0, 25, 50, 60, 70, 80] as const;

export function isFiltered(f: Filters): boolean {
  return f.solutionClass !== "all" || f.status !== "all" || f.minRank > 0 || f.query.trim() !== "";
}

/**
 * The filter bar of the opportunity list. It sticks under the top bar while the list scrolls
 * (D-372), so a person who has narrowed to "AI, new, 70+" keeps seeing what they chose and how
 * many rows it leaves. Scoring weights open from here too: they change the order, so they belong
 * next to the filters that change the set.
 */
export function OpportunityFilters({
  filters,
  onChange,
  shown,
  total,
  onOpenWeights,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  shown: number;
  total: number;
  onOpenWeights: () => void;
}): React.JSX.Element {
  const s = t.admin.results;
  return (
    <div
      role="group"
      aria-label={s.filters.title}
      data-sticky-filters
      className="bg-card/95 supports-[backdrop-filter]:bg-card/85 sticky top-14 z-20 -mx-4 flex flex-wrap items-center gap-2 border-b px-4 py-2.5 backdrop-blur sm:-mx-6 sm:px-6 lg:top-[4.25rem] lg:-mx-8 lg:px-8 print:hidden"
    >
      <div className="relative min-w-48 flex-1 basis-56 sm:max-w-xs">
        <SearchIcon
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
          aria-hidden="true"
        />
        <Input
          type="search"
          value={filters.query}
          aria-label={t.ws.filters.search}
          placeholder={t.ws.filters.search}
          className="h-9 pl-8"
          onChange={(e) => {
            onChange({ ...filters, query: e.target.value });
          }}
        />
      </div>
      <Select
        value={filters.solutionClass}
        onValueChange={(v) => {
          onChange({ ...filters, solutionClass: v as Filters["solutionClass"] });
        }}
      >
        <SelectTrigger size="sm" className="w-40" aria-label={s.filters.class}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{`${s.filters.class}: ${s.filters.all}`}</SelectItem>
          {SOLUTION_CLASSES.map((c) => (
            <SelectItem key={c} value={c}>
              {s.classes[c]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={filters.status}
        onValueChange={(v) => {
          onChange({ ...filters, status: v as Filters["status"] });
        }}
      >
        <SelectTrigger size="sm" className="w-36" aria-label={s.filters.status}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{`${s.filters.status}: ${s.filters.all}`}</SelectItem>
          {STATUS_KEYS.map((st) => (
            <SelectItem key={st} value={st}>
              {s.statuses[st]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={String(filters.minRank)}
        onValueChange={(v) => {
          onChange({ ...filters, minRank: Number(v) });
        }}
      >
        <SelectTrigger size="sm" className="w-36" aria-label={s.filters.minRank}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {MIN_RANKS.map((r) => (
            <SelectItem key={r} value={String(r)}>
              {r === 0 ? t.ws.filters.anyScore : t.ws.filters.atLeast(r)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {isFiltered(filters) ? (
        <IconButton
          label={t.ws.filters.clear}
          icon={<FilterXIcon />}
          onClick={() => {
            onChange(DEFAULT_FILTERS);
          }}
        />
      ) : null}
      <p
        className="text-muted-foreground order-last w-full text-xs sm:order-none sm:ml-auto sm:w-auto"
        aria-live="polite"
      >
        {s.filters.showing(shown, total)} · {s.filters.sortedByRank}
      </p>
      <Button variant="outline" size="sm" onClick={onOpenWeights}>
        <SlidersHorizontalIcon /> {t.ws.filters.weights}
      </Button>
    </div>
  );
}
