"use client";

import { CheckCircle2Icon, CircleIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { Flash, useAction } from "@/components/admin/Flash";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import { ONBOARDING_STEP_KEYS, type Onboarding, type OnboardingStepKey } from "@/lib/api/schemas";

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
 * The getting-started card (D-189). The steps are derived by the API from what the organization
 * has, so ticking one needs no bookkeeping here; the only thing this component stores is the
 * decision to hide it. It disappears by itself once everything is done.
 *
 * The next step carries `aria-current="step"`, every row says done or not in words as well as an
 * icon, and the whole card is a labelled region that a screen reader can jump to.
 */
export function SetupChecklist({ state }: { state: Onboarding }): React.JSX.Element | null {
  const s = t.admin.dashboard.setup;
  const router = useRouter();
  const action = useAction();
  const [hidden, setHidden] = React.useState(false);
  if (hidden || state.dismissed || state.complete) return null;

  const detail = (key: OnboardingStepKey, source: string | null | undefined): string => {
    const step = s.steps[key];
    if (key === "provider" && source === "tenant") return s.steps.provider.doneTenant;
    if (key === "provider" && source === "platform") return s.steps.provider.donePlatform;
    return step.text;
  };

  return (
    <section
      aria-labelledby="setup-title"
      className="bg-card shadow-card grid gap-4 rounded-lg border-l-4 border-l-[var(--primary)] p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h2 id="setup-title" className="text-[15px] font-semibold tracking-tight">
            {s.title}
          </h2>
          <p className="text-muted-foreground text-[13px]">{s.description}</p>
        </div>
        <div className="flex items-center gap-2">
          <p className="text-muted-foreground text-xs tabular-nums" role="status">
            {s.progress(state.done, state.total)}
          </p>
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
      </div>
      <Flash flash={action.flash} />
      <ol aria-label={s.stepsLabel} className="grid gap-2 md:grid-cols-2">
        {state.steps
          .filter((st) => isStep(st.key))
          .map((st) => {
            const key = st.key as OnboardingStepKey;
            const text = s.steps[key];
            const isNext = state.next === key;
            return (
              <li
                key={key}
                aria-current={isNext ? "step" : undefined}
                className={
                  isNext
                    ? "border-primary bg-accent/40 flex gap-3 rounded-md border p-3"
                    : "flex gap-3 rounded-md border p-3"
                }
              >
                {st.done ? (
                  <CheckCircle2Icon className="text-success mt-0.5 size-5 shrink-0" aria-hidden="true" />
                ) : (
                  <CircleIcon className="text-muted-foreground mt-0.5 size-5 shrink-0" aria-hidden="true" />
                )}
                <div className="grid min-w-0 gap-1">
                  <p className="text-sm font-medium">
                    {text.title} <span className="sr-only"> {st.done ? s.done : isNext ? s.up : ""}</span>
                  </p>
                  <p className="text-muted-foreground text-xs">{detail(key, st.source)}</p>
                  {!st.done ? (
                    <Button asChild variant={isNext ? "default" : "outline"} size="sm" className="w-fit">
                      <Link href={HREF[key]}>{text.action}</Link>
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
      </ol>
    </section>
  );
}
