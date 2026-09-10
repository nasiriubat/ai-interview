"use client";

import { type OpportunityStatus, SOLUTION_CLASSES, type SolutionClass } from "@aidp/shared";
import * as React from "react";
import { Label } from "@/components/ui/label";
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
}

export const DEFAULT_FILTERS: Filters = { solutionClass: "all", status: "all", minRank: 0 };

export function OpportunityFilters({
  filters,
  onChange,
  shown,
  total,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  shown: number;
  total: number;
}): React.JSX.Element {
  const s = t.admin.results;
  return (
    <div className="flex flex-wrap items-end gap-4 print:hidden" role="group" aria-label={s.filters.title}>
      <div className="grid gap-1.5">
        <Label htmlFor="filter-class">{s.filters.class}</Label>
        <Select
          value={filters.solutionClass}
          onValueChange={(v) => {
            onChange({ ...filters, solutionClass: v as Filters["solutionClass"] });
          }}
        >
          <SelectTrigger id="filter-class" size="sm" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{s.filters.all}</SelectItem>
            {SOLUTION_CLASSES.map((c) => (
              <SelectItem key={c} value={c}>
                {s.classes[c]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="filter-status">{s.filters.status}</Label>
        <Select
          value={filters.status}
          onValueChange={(v) => {
            onChange({ ...filters, status: v as Filters["status"] });
          }}
        >
          <SelectTrigger id="filter-status" size="sm" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{s.filters.all}</SelectItem>
            {STATUS_KEYS.map((st) => (
              <SelectItem key={st} value={st}>
                {s.statuses[st]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="filter-min-rank">
          {s.filters.minRank}: <span className="tabular-nums">{filters.minRank}</span>
        </Label>
        <input
          id="filter-min-rank"
          type="range"
          min={0}
          max={100}
          step={5}
          value={filters.minRank}
          onChange={(e) => {
            onChange({ ...filters, minRank: Number(e.target.value) });
          }}
          className="accent-primary h-2 w-40 cursor-pointer"
        />
      </div>
      <p className="text-muted-foreground text-xs" aria-live="polite">
        {s.filters.showing(shown, total)} · {s.filters.sortedByRank}
      </p>
    </div>
  );
}
