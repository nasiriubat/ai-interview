"use client";

import {
  ClockIcon,
  MessagesSquareIcon,
  PanelRightOpenIcon,
  PencilIcon,
  RotateCcwIcon,
  SproutIcon,
  StarIcon,
  XIcon,
} from "lucide-react";
import * as React from "react";
import { ClassBadge, RankMeter } from "./ClassBadge";
import { IconButton, RowActions } from "@/components/admin/IconButton";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { t } from "@/i18n";
import { confidenceOf, DEFAULT_SMALL_SAMPLE } from "@/lib/analysis/confidence";
import { effectiveClass, effectiveTitle } from "@/lib/analysis/rank";
import type { Opportunity } from "@/lib/api/schemas";
import type { OpportunityStatusInput } from "@/lib/api/staff";
import { cn } from "@/lib/utils";

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
  interviewsTotal = 0,
  smallSample = DEFAULT_SMALL_SAMPLE,
}: {
  opportunity: Opportunity;
  busy: boolean;
  /** The row whose panel is open. */
  active: boolean;
  onOpen: () => void;
  onStatus: (status: OpportunityStatusInput) => void;
  merge?: { selected: boolean; disabled: boolean; onChange: (selected: boolean) => void } | undefined;
  whyNotAiFirst?: boolean;
  /** Interviews analysed in the version, for "In 3 of 12 interviews" (D-478). */
  interviewsTotal?: number;
  /** `analysis.smallSampleInterviews`. */
  smallSample?: number;
}): React.JSX.Element {
  const s = t.admin.results;
  const confidence = confidenceOf(o.stats, interviewsTotal, smallSample);
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
            <dt className="sr-only">{t.ws.opportunity.confidence}</dt>
            <MessagesSquareIcon className="size-3.5" aria-hidden="true" />
            <dd className="tabular-nums" title={t.ws.opportunity.people(o.stats.participants)}>
              {t.ws.opportunity.interviews(confidence.interviews, confidence.total)}
            </dd>
          </div>
          {confidence.small ? (
            <div className="flex items-center">
              <dt className="sr-only">{t.ws.opportunity.smallSample}</dt>
              <dd>
                <Badge
                  variant="outline"
                  className="text-muted-foreground font-normal"
                  title={t.ws.opportunity.smallSampleBody(confidence.interviews)}
                >
                  <SproutIcon aria-hidden="true" /> {t.ws.opportunity.smallSample}
                </Badge>
              </dd>
            </div>
          ) : null}
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
