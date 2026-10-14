"use client";

import { FACTOR_KEYS } from "@aidp/shared";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  PencilIcon,
  RocketIcon,
  RotateCcwIcon,
  StarIcon,
  XIcon,
} from "lucide-react";
import * as React from "react";
import { ClassBadge, RankMeter } from "./ClassBadge";
import { FactorBars } from "./FactorBars";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { t } from "@/i18n";
import { effectiveClass, effectiveFactors, effectiveTitle } from "@/lib/analysis/rank";
import type { Opportunity } from "@/lib/api/schemas";
import type { OpportunityStatusInput } from "@/lib/api/staff";
import { formatNumber } from "@/lib/utils";

function List({ title, items }: { title: string; items: readonly string[] }): React.JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <div>
      <h4 className="text-muted-foreground mb-1 text-xs font-medium">{title}</h4>
      <ul className="list-disc space-y-0.5 pl-5 text-sm">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

export function OpportunityCard({
  opportunity: o,
  busy,
  onStatus,
  onEdit,
  onPromote,
  canPromote = true,
}: {
  opportunity: Opportunity;
  busy: boolean;
  onStatus: (status: OpportunityStatusInput) => void;
  onEdit: () => void;
  onPromote: () => void;
  /** `features.chaining` (D-187): off hides the action instead of offering one the API refuses. */
  canPromote?: boolean;
}): React.JSX.Element {
  const s = t.admin.results;
  const [open, setOpen] = React.useState(false);
  const title = effectiveTitle(o);
  const cls = effectiveClass(o);
  const factors = effectiveFactors(o);
  const overriddenKeys = FACTOR_KEYS.filter((k) => o.adminOverride?.factors?.[k] !== undefined);
  const edited = o.adminOverride !== null && Object.keys(o.adminOverride).length > 0;
  const detailsId = `opportunity-${o.id}-details`;
  const dismissed = o.status === "dismissed";
  const promoted = o.status === "promoted";
  const quotes = o.evidence.length > 0 ? o.evidence.map((e) => e.snippet) : o.stats.quotes;
  const anonymized = o.evidence.length === 0 || o.evidence.every((e) => e.anonymized);

  return (
    <Card className={dismissed ? "gap-3 py-4 opacity-70" : "gap-3 py-4"} data-status={o.status}>
      <CardHeader className="px-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid min-w-0 gap-1.5">
            <h3 className="text-base leading-tight font-semibold">{title}</h3>
            <div className="flex flex-wrap items-center gap-1.5">
              <ClassBadge solutionClass={cls} />
              <Badge variant={promoted ? "success" : dismissed ? "outline" : "secondary"}>
                {s.statuses[o.status]}
              </Badge>
              {edited ? (
                <Badge variant="warning">
                  <PencilIcon /> {s.card.overridden}
                </Badge>
              ) : null}
            </div>
          </div>
          <RankMeter score={o.rankScore} />
        </div>
      </CardHeader>
      <CardContent className="grid gap-4 px-5">
        {o.summary ? <p className="text-sm leading-relaxed">{o.summary}</p> : null}
        <FactorBars factors={factors} overridden={overriddenKeys} />
        <dl className="text-muted-foreground grid grid-cols-2 gap-x-4 gap-y-1 text-xs md:grid-cols-4">
          <div>
            <dt className="font-medium">{s.card.participants}</dt>
            <dd className="text-foreground tabular-nums">{formatNumber(o.stats.participants)}</dd>
          </div>
          <div>
            <dt className="font-medium">{s.card.minutesPerWeek}</dt>
            <dd className="text-foreground tabular-nums">{formatNumber(o.stats.minutesPerWeekTotal)}</dd>
          </div>
          <div>
            <dt className="font-medium">{s.card.roles}</dt>
            <dd className="text-foreground truncate" title={o.stats.roles.join(", ")}>
              {o.stats.roles.length > 0 ? o.stats.roles.join(", ") : t.admin.common.dash}
            </dd>
          </div>
          <div>
            <dt className="font-medium">{s.card.tools}</dt>
            <dd className="text-foreground truncate" title={o.stats.tools.join(", ")}>
              {o.stats.tools.length > 0 ? o.stats.tools.join(", ") : t.admin.common.dash}
            </dd>
          </div>
        </dl>

        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={() => {
              setOpen((v) => !v);
            }}
          >
            {open ? <ChevronUpIcon /> : <ChevronDownIcon />}
            {open ? s.card.hideDetails : s.card.showDetails}
          </Button>
        </div>
        {open ? (
          <div id={detailsId} className="grid gap-4 border-t pt-4">
            {o.rationale ? (
              <div>
                <h4 className="text-muted-foreground mb-1 text-xs font-medium">{s.card.rationale}</h4>
                <p className="text-sm">{o.rationale}</p>
              </div>
            ) : null}
            <div>
              <h4 className="text-muted-foreground mb-1 text-xs font-medium">{s.factorsLabel}</h4>
              <dl className="grid gap-1 text-sm">
                {FACTOR_KEYS.map((k) => (
                  <div key={k} className="grid grid-cols-[minmax(0,12rem)_auto_1fr] gap-x-3">
                    <dt className="truncate">{s.factors[k]}</dt>
                    <dd className="tabular-nums">{factors[k].score}/5</dd>
                    <dd className="text-muted-foreground">{factors[k].rationale}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <div>
              <h4 className="text-muted-foreground mb-1 flex items-center gap-2 text-xs font-medium">
                {s.card.evidence}
                {quotes.length > 0 && anonymized ? (
                  <Badge variant="outline">{s.card.anonymized}</Badge>
                ) : null}
              </h4>
              {quotes.length > 0 ? (
                <ul className="grid gap-1.5">
                  {quotes.map((q, i) => (
                    <li key={i}>
                      <blockquote className="border-l-2 pl-3 text-sm italic">{q}</blockquote>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground text-sm">{s.card.quotesHidden}</p>
              )}
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <List title={s.card.dataNeeded} items={o.dataNeeded} />
              <List title={s.card.risks} items={o.risks} />
            </div>
            {o.whyNotAi ? (
              <div>
                <h4 className="text-muted-foreground mb-1 text-xs font-medium">{s.card.whyNotAi}</h4>
                <p className="text-sm">{o.whyNotAi}</p>
              </div>
            ) : null}
            {o.adminOverride?.note ? (
              <div>
                <h4 className="text-muted-foreground mb-1 text-xs font-medium">{s.card.note}</h4>
                <p className="text-sm">{o.adminOverride.note}</p>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2 print:hidden" role="group" aria-label={s.actions.menu}>
          {!promoted && !dismissed && o.status !== "shortlisted" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                onStatus("shortlisted");
              }}
            >
              <StarIcon /> {s.actions.shortlist}
            </Button>
          ) : null}
          {dismissed ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                onStatus("new");
              }}
            >
              <RotateCcwIcon /> {s.actions.restore}
            </Button>
          ) : !promoted ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                onStatus("dismissed");
              }}
            >
              <XIcon /> {s.actions.dismiss}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" disabled={busy} onClick={onEdit}>
            <PencilIcon /> {s.actions.edit}
          </Button>
          {!promoted && !dismissed && canPromote ? (
            <Button size="sm" disabled={busy} onClick={onPromote}>
              <RocketIcon /> {s.actions.promote}
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
