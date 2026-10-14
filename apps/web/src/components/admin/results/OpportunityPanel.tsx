"use client";

import { FACTOR_KEYS } from "@aidp/shared";
import {
  AlertTriangleIcon,
  CheckIcon,
  PencilIcon,
  RocketIcon,
  RotateCcwIcon,
  SplitIcon,
  StarIcon,
  TypeIcon,
  XIcon,
} from "lucide-react";
import * as React from "react";
import { ClassBadge, RankMeter } from "./ClassBadge";
import { Withheld } from "@/components/admin/charts/Withheld";
import { IconButton } from "@/components/admin/IconButton";
import { QuoteBlock } from "@/components/admin/QuoteBlock";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { t } from "@/i18n";
import { effectiveClass, effectiveFactors, effectiveTitle } from "@/lib/analysis/rank";
import type { Opportunity } from "@/lib/api/schemas";
import type { OpportunityStatusInput } from "@/lib/api/staff";
import { formatNumber } from "@/lib/utils";

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="grid gap-2">
      <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">{title}</h3>
      {children}
    </section>
  );
}

function Bullets({ items }: { items: readonly string[] }): React.JSX.Element {
  return (
    <ul className="grid gap-1.5 text-sm">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2">
          <span aria-hidden="true" className="bg-muted-foreground/60 mt-2 size-1.5 shrink-0 rounded-full" />
          <span className="min-w-0 break-words">{item}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The detail of one opportunity in a side panel (D-372): the evidence first, because the score is
 * only as good as what people said, then the factors with their reasons, then what it would need.
 * The actions that change the opportunity are in the footer, where a person who has just read the
 * evidence expects to decide.
 */
export function OpportunityPanel({
  opportunity: o,
  open,
  onOpenChange,
  busy,
  canPromote,
  k,
  onStatus,
  onEdit,
  onPromote,
  onSplit,
  onRename,
}: {
  opportunity: Opportunity;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  canPromote: boolean;
  /** `privacy.kAnonymity`, for the sentence that says why a quote is not shown. */
  k: number;
  onStatus: (status: OpportunityStatusInput) => void;
  onEdit: () => void;
  onPromote: () => void;
  onSplit?: (() => void) | undefined;
  onRename?: ((title: string) => Promise<void>) | undefined;
}): React.JSX.Element {
  const s = t.admin.results;
  const w = t.ws.opportunity;
  const title = effectiveTitle(o);
  const cls = effectiveClass(o);
  const factors = effectiveFactors(o);
  const overriddenKeys = FACTOR_KEYS.filter((key) => o.adminOverride?.factors?.[key] !== undefined);
  const promoted = o.status === "promoted";
  const dismissed = o.status === "dismissed";
  const quotes =
    o.evidence.length > 0
      ? o.evidence.map((e) => ({ text: e.snippet, anonymized: e.anonymized, source: e.factId }))
      : o.stats.quotes.map((q) => ({ text: q, anonymized: true, source: "" }));

  const [renaming, setRenaming] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [renameError, setRenameError] = React.useState<string | null>(null);
  const [renameBusy, setRenameBusy] = React.useState(false);

  const submitRename = (e: React.SyntheticEvent): void => {
    e.preventDefault();
    const next = draft.trim();
    if (!onRename || next === "" || next === title) {
      setRenaming(false);
      return;
    }
    setRenameBusy(true);
    setRenameError(null);
    onRename(next)
      .then(() => {
        setRenaming(false);
      })
      .catch((err: unknown) => {
        setRenameError(err instanceof Error ? err.message : t.app.unknownError);
      })
      .finally(() => {
        setRenameBusy(false);
      });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        closeLabel={t.app.close}
        className="gap-0 p-0 sm:max-w-xl lg:max-w-2xl"
        data-testid="opportunity-panel"
      >
        <SheetHeader className="bg-card sticky top-0 z-10 border-b px-5 pt-5 pb-4 pr-12">
          <div className="flex flex-wrap items-center gap-1.5">
            <ClassBadge solutionClass={cls} />
            <Badge variant={promoted ? "success" : dismissed ? "outline" : "secondary"}>
              {s.statuses[o.status]}
            </Badge>
            {o.adminOverride !== null && Object.keys(o.adminOverride).length > 0 ? (
              <Badge variant="warning">
                <PencilIcon /> {s.card.overridden}
              </Badge>
            ) : null}
          </div>
          {renaming ? (
            <form className="flex flex-wrap items-center gap-2" onSubmit={submitRename}>
              <label htmlFor={`rename-${o.id}`} className="sr-only">
                {s.rename.label}
              </label>
              <Input
                id={`rename-${o.id}`}
                className="h-9 min-w-0 flex-1"
                value={draft}
                maxLength={160}
                autoFocus
                aria-invalid={renameError ? true : undefined}
                aria-describedby={renameError ? `rename-${o.id}-error` : undefined}
                onChange={(e) => {
                  setDraft(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setRenaming(false);
                  }
                }}
              />
              <Button type="submit" size="sm" loading={renameBusy}>
                {s.rename.save}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={renameBusy}
                onClick={() => {
                  setRenaming(false);
                }}
              >
                {t.app.cancel}
              </Button>
              {renameError ? (
                <p id={`rename-${o.id}-error`} role="alert" className="text-destructive w-full text-xs">
                  {renameError}
                </p>
              ) : null}
            </form>
          ) : (
            <SheetTitle className="text-lg leading-snug text-balance break-words">{title}</SheetTitle>
          )}
          <SheetDescription asChild>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <RankMeter score={o.rankScore} />
              <span className="text-muted-foreground text-xs tabular-nums">
                {w.people(o.stats.participants)} · {w.minutes(o.stats.minutesPerWeekTotal)}
              </span>
            </div>
          </SheetDescription>
        </SheetHeader>

        <div tabIndex={0} className="grid flex-1 content-start gap-6 overflow-y-auto px-5 py-5">
          {o.whyNotAi ? (
            <div className="bg-warning-soft text-warning-soft-foreground flex gap-3 rounded-lg px-4 py-3">
              <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <div className="min-w-0">
                <h3 className="text-sm font-semibold">{s.card.whyNotAi}</h3>
                <p className="mt-0.5 text-sm leading-relaxed">{o.whyNotAi}</p>
              </div>
            </div>
          ) : null}

          {o.summary ? (
            <Section title={w.summary}>
              <p className="text-sm leading-relaxed text-pretty">{o.summary}</p>
              {o.rationale ? (
                <p className="text-muted-foreground text-sm leading-relaxed">{o.rationale}</p>
              ) : null}
            </Section>
          ) : null}

          <Section title={s.card.evidence}>
            {quotes.length > 0 ? (
              <ul className="grid gap-2.5">
                {quotes.map((q, i) => (
                  <li key={i}>
                    <QuoteBlock
                      text={q.text}
                      anonymized={q.anonymized}
                      source={q.source ? `${w.fact} ${q.source.slice(-6)}` : undefined}
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <div className="bg-muted/50 flex items-start gap-3 rounded-lg px-4 py-3">
                <Withheld />
                <p className="text-muted-foreground min-w-0 text-sm leading-relaxed">{w.quotesWithheld(k)}</p>
              </div>
            )}
          </Section>

          <Section title={s.factorsLabel}>
            <dl className="grid gap-2.5">
              {FACTOR_KEYS.map((key) => (
                <div
                  key={key}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5 text-sm sm:grid-cols-[8rem_5.5rem_minmax(0,1fr)]"
                >
                  <dt className="text-foreground min-w-0 font-medium">{s.factors[key]}</dt>
                  <dd className="text-foreground flex items-center gap-1.5 font-semibold tabular-nums">
                    <span aria-hidden="true" className="flex gap-px">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <span
                          key={n}
                          className={`h-3 w-1.5 rounded-[2px] ${
                            n <= factors[key].score
                              ? overriddenKeys.includes(key)
                                ? "bg-warning"
                                : "bg-primary"
                              : "bg-muted"
                          }`}
                        />
                      ))}
                    </span>
                    {factors[key].score}/5
                  </dd>
                  <dd className="text-muted-foreground col-span-2 min-w-0 text-[13px] leading-relaxed break-words sm:col-span-1">
                    {factors[key].rationale || t.admin.common.dash}
                  </dd>
                </div>
              ))}
            </dl>
          </Section>

          <Section title={w.reach}>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <div>
                <dt className="text-muted-foreground text-xs">{s.card.participants}</dt>
                <dd className="font-medium tabular-nums">{formatNumber(o.stats.participants)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-xs">{s.card.minutesPerWeek}</dt>
                <dd className="font-medium tabular-nums">{formatNumber(o.stats.minutesPerWeekTotal)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-xs">{s.card.roles}</dt>
                <dd className="font-medium break-words">
                  {o.stats.roles.length > 0 ? o.stats.roles.join(", ") : t.admin.common.dash}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-xs">{s.card.tools}</dt>
                <dd className="font-medium break-words">
                  {o.stats.tools.length > 0 ? o.stats.tools.join(", ") : t.admin.common.dash}
                </dd>
              </div>
            </dl>
          </Section>

          {o.dataNeeded.length > 0 || o.risks.length > 0 ? (
            <div className="grid gap-6 sm:grid-cols-2">
              {o.dataNeeded.length > 0 ? (
                <Section title={s.card.dataNeeded}>
                  <Bullets items={o.dataNeeded} />
                </Section>
              ) : null}
              {o.risks.length > 0 ? (
                <Section title={s.card.risks}>
                  <Bullets items={o.risks} />
                </Section>
              ) : null}
            </div>
          ) : null}

          {o.adminOverride?.note ? (
            <Section title={s.card.note}>
              <p className="text-sm leading-relaxed">{o.adminOverride.note}</p>
            </Section>
          ) : null}
        </div>

        <SheetFooter className="bg-card sticky bottom-0 flex-row flex-wrap items-center justify-between gap-2 border-t px-5 py-3">
          <div className="flex flex-wrap items-center gap-1.5">
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
            ) : o.status === "shortlisted" ? (
              <Badge variant="info">
                <CheckIcon /> {s.statuses.shortlisted}
              </Badge>
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
            <IconButton
              label={`${s.actions.edit}: ${title}`}
              icon={<PencilIcon />}
              disabled={busy}
              onClick={onEdit}
            />
            {onRename && !renaming ? (
              <IconButton
                label={`${s.rename.action}: ${title}`}
                icon={<TypeIcon />}
                disabled={busy}
                onClick={() => {
                  setDraft(title);
                  setRenameError(null);
                  setRenaming(true);
                }}
              />
            ) : null}
            {onSplit && !promoted ? (
              <IconButton
                label={`${s.split.action}: ${title}`}
                icon={<SplitIcon />}
                disabled={busy}
                onClick={onSplit}
              />
            ) : null}
          </div>
          {!promoted && !dismissed && canPromote ? (
            <Button size="sm" disabled={busy} onClick={onPromote}>
              <RocketIcon /> {s.actions.promote}
            </Button>
          ) : null}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
