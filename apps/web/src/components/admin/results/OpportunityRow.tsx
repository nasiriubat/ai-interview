"use client";

import {
  ClockIcon,
  PanelRightOpenIcon,
  PencilIcon,
  RotateCcwIcon,
  StarIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import * as React from "react";
import { ClassBadge, RankMeter } from "./ClassBadge";
import { IconButton, RowActions } from "@/components/admin/IconButton";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { t } from "@/i18n";
import { effectiveClass, effectiveTitle } from "@/lib/analysis/rank";
import type { Opportunity } from "@/lib/api/schemas";
import type { OpportunityStatusInput } from "@/lib/api/staff";
import { cn, formatNumber } from "@/lib/utils";

/**
 * One opportunity in the ranked list (D-372): title, class, score and the two numbers that matter
 * at a glance, with icon-only quick actions. Everything else lives in the side panel, which the
 * title and the "Open details" button both open, so the list stays scannable at fifty rows.
 */
export function OpportunityRow({
  opportunity: o,
  busy,
  active,
  onOpen,
  onStatus,
  merge,
  whyNotAiFirst = false,
}: {
  opportunity: Opportunity;
  busy: boolean;
  /** The row whose panel is open. */
  active: boolean;
  onOpen: () => void;
  onStatus: (status: OpportunityStatusInput) => void;
  merge?: { selected: boolean; disabled: boolean; onChange: (selected: boolean) => void } | undefined;
  whyNotAiFirst?: boolean;
}): React.JSX.Element {
  const s = t.admin.results;
  const title = effectiveTitle(o);
  const cls = effectiveClass(o);
  const dismissed = o.status === "dismissed";
  const promoted = o.status === "promoted";
  const edited = o.adminOverride !== null && Object.keys(o.adminOverride).length > 0;
  return (
    <li
      data-status={o.status}
      data-active={active || undefined}
      className={cn(
        "flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3.5 transition-colors not-last:border-b sm:flex-nowrap",
        active ? "bg-accent/60" : "hover:bg-muted/40",
        dismissed && "opacity-70",
      )}
    >
      {merge ? (
        <Checkbox
          className="mt-1"
          aria-label={s.merge.select(title)}
          checked={merge.selected}
          disabled={merge.disabled || busy}
          onCheckedChange={(v) => {
            merge.onChange(v === true);
          }}
        />
      ) : null}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <h3 className="min-w-0 text-[15px] leading-snug font-semibold text-balance">
            <button
              type="button"
              onClick={onOpen}
              className="hover:text-primary rounded-sm text-left break-words hover:underline"
            >
              {title}
            </button>
          </h3>
          <ClassBadge solutionClass={cls} />
          {o.status !== "new" ? (
            <Badge variant={promoted ? "success" : dismissed ? "outline" : "info"}>
              {s.statuses[o.status]}
            </Badge>
          ) : null}
          {edited ? (
            <Badge variant="warning">
              <PencilIcon /> {s.card.overridden}
            </Badge>
          ) : null}
        </div>
        {whyNotAiFirst && o.whyNotAi ? (
          <p className="text-body mt-1.5 text-[13px] leading-relaxed">
            <span className="text-muted-foreground font-medium">{s.card.whyNotAi}: </span>
            {o.whyNotAi}
          </p>
        ) : o.summary ? (
          <p className="text-muted-foreground mt-1 line-clamp-2 text-[13px] leading-relaxed">{o.summary}</p>
        ) : null}
        <dl className="text-muted-foreground mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <div className="flex items-center gap-1.5">
            <dt className="sr-only">{s.card.participants}</dt>
            <UsersIcon className="size-3.5" aria-hidden="true" />
            <dd className="tabular-nums">{t.ws.opportunity.people(o.stats.participants)}</dd>
          </div>
          <div className="flex items-center gap-1.5">
            <dt className="sr-only">{s.card.minutesPerWeek}</dt>
            <ClockIcon className="size-3.5" aria-hidden="true" />
            <dd className="tabular-nums">{t.ws.opportunity.minutes(o.stats.minutesPerWeekTotal)}</dd>
          </div>
          {o.stats.roles.length > 0 ? (
            <div className="min-w-0">
              <dt className="sr-only">{s.card.roles}</dt>
              <dd className="max-w-64 truncate" title={o.stats.roles.join(", ")}>
                {o.stats.roles.join(", ")}
              </dd>
            </div>
          ) : null}
        </dl>
      </div>
      <div className="flex w-full shrink-0 items-center justify-between gap-4 pl-0 sm:w-auto sm:justify-end">
        <RankMeter score={o.rankScore} compact />
        <RowActions>
          {!promoted && !dismissed && o.status !== "shortlisted" ? (
            <IconButton
              label={`${s.actions.shortlist}: ${title}`}
              icon={<StarIcon />}
              disabled={busy}
              onClick={() => {
                onStatus("shortlisted");
              }}
            />
          ) : null}
          {dismissed ? (
            <IconButton
              label={`${s.actions.restore}: ${title}`}
              icon={<RotateCcwIcon />}
              disabled={busy}
              onClick={() => {
                onStatus("new");
              }}
            />
          ) : !promoted ? (
            <IconButton
              label={`${s.actions.dismiss}: ${title}`}
              icon={<XIcon />}
              disabled={busy}
              onClick={() => {
                onStatus("dismissed");
              }}
            />
          ) : null}
          <IconButton label={t.ws.opportunity.open(title)} icon={<PanelRightOpenIcon />} onClick={onOpen} />
        </RowActions>
      </div>
    </li>
  );
}
