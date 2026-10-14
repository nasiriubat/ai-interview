"use client";

import { ArrowRightIcon, CheckCircle2Icon, XIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { Flash, useAction } from "@/components/admin/Flash";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import { ONBOARDING_STEP_KEYS, type Onboarding, type OnboardingStepKey } from "@/lib/api/schemas";
import { cn } from "@/lib/utils";

/** Where each step is done. The first three are lists the admin already knows how to use. */
const HREF: Record<OnboardingStepKey, string> = {
  provider: "/admin/providers",
  template: "/admin/templates",
  campaign: "/admin/campaigns",
  invite: "/admin/campaigns",
};

function isStep(key: string): key is OnboardingStepKey {
  return (ONBOARDING_STEP_KEYS as readonly string[]).includes(key);
}

/**
 * The getting-started card (D-189, D-393). The API derives the four set-up steps from what the
 * organization has, so ticking one needs no bookkeeping here. The fifth, "see the first results",
 * is derived by the page from the interview statistics it already loaded and passed as
 * `resultsReady`. The only thing this component stores is the decision to hide it, and it goes
 * away by itself once everything is done.
 *
 * Progress is a real `progressbar` (value and text), the next step carries `aria-current="step"`,
 * and every row says done or not in words as well as an icon.
 */
export function SetupChecklist({
  state,
  resultsReady = false,
}: {
  state: Onboarding;
  resultsReady?: boolean;
}): React.JSX.Element | null {
  const s = t.admin.dashboard.setup;
  const g = t.kit.gettingStarted;
  const router = useRouter();
  const action = useAction();
  const [hidden, setHidden] = React.useState(false);

  const rows = state.steps
    .filter((st) => isStep(st.key))
    .map((st) => ({ key: st.key as OnboardingStepKey, done: st.done, source: st.source }));
  const all = [...rows.map((r) => ({ id: r.key, done: r.done })), { id: "results", done: resultsReady }];
  const total = all.length;
  const done = all.filter((r) => r.done).length;
  if (hidden || state.dismissed || done === total) return null;
  const next = all.find((r) => !r.done)?.id;

  const detail = (key: OnboardingStepKey, source: string | null | undefined): string => {
    const step = s.steps[key];
    if (key === "provider" && source === "tenant") return s.steps.provider.doneTenant;
    if (key === "provider" && source === "platform") return s.steps.provider.donePlatform;
    return step.text;
  };

  const item = (
    id: string,
    index: number,
    isDone: boolean,
    title: string,
    text: string,
    actionLabel: string,
    href: string,
  ): React.JSX.Element => {
    const isNext = next === id;
    return (
      <li
        key={id}
        aria-current={isNext ? "step" : undefined}
        className={cn(
          "flex gap-3 rounded-lg p-3.5 transition-colors",
          isNext ? "bg-accent/60 ring-primary/40 ring-1" : "bg-muted/40",
        )}
      >
        {isDone ? (
          <CheckCircle2Icon className="text-success mt-0.5 size-5 shrink-0" aria-hidden="true" />
        ) : (
          <span
            aria-hidden="true"
            className={cn(
              "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-xs font-semibold",
              isNext ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground shadow-control",
            )}
          >
            {index + 1}
          </span>
        )}
        <div className="grid min-w-0 content-start gap-1">
          <p className={cn("text-sm font-medium", isDone && "text-muted-foreground")}>
            {title}
            <span className="sr-only"> {isDone ? s.done : isNext ? s.up : ""}</span>
          </p>
          <p className="text-muted-foreground text-xs">{text}</p>
          {!isDone ? (
            <Button asChild variant={isNext ? "default" : "outline"} size="sm" className="mt-1 w-fit">
              <Link href={href}>
                {actionLabel} <ArrowRightIcon aria-hidden="true" />
              </Link>
            </Button>
          ) : null}
        </div>
      </li>
    );
  };

  return (
    <section aria-labelledby="setup-title" className="bg-card shadow-card grid gap-4 rounded-lg p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 content-start gap-1">
          <h2 id="setup-title" className="text-[15px] font-semibold tracking-tight">
            {g.title}
          </h2>
          <p className="text-muted-foreground text-[13px]">{g.description}</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={action.busy}
          onClick={() => {
            void action
              .run(async () => {
                await staffClient.onboarding.dismiss();
                router.refresh();
              })
              .then((ok) => {
                if (ok) setHidden(true);
              });
          }}
        >
          <XIcon aria-hidden="true" /> {s.dismiss}
        </Button>
      </div>
      <div className="grid gap-1.5">
        <div
          role="progressbar"
          aria-label={g.progressLabel}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
          aria-valuetext={g.progress(done, total)}
          className="bg-muted h-2 overflow-hidden rounded-full"
        >
          <div
            className="bg-primary h-full rounded-full transition-[width] duration-300"
            style={{ width: `${String(Math.round((done / total) * 100))}%` }}
          />
        </div>
        <p className="text-muted-foreground text-xs tabular-nums">{g.progress(done, total)}</p>
      </div>
      <Flash flash={action.flash} />
      <ol aria-label={s.stepsLabel} className="grid gap-2 grid-cols-[repeat(auto-fit,minmax(14rem,1fr))]">
        {rows.map((r, i) =>
          item(
            r.key,
            i,
            r.done,
            s.steps[r.key].title,
            detail(r.key, r.source),
            s.steps[r.key].action,
            HREF[r.key],
          ),
        )}
        {item(
          "results",
          rows.length,
          resultsReady,
          g.results.title,
          resultsReady ? g.results.textDone : g.results.text,
          g.results.action,
          "/admin/campaigns",
        )}
      </ol>
    </section>
  );
}
