import * as React from "react";
import { CrumbLabels } from "@/components/admin/shell/crumbs";
import { cn } from "@/lib/utils";

/**
 * Title block of every admin page: the title, one line of context, and the page's actions on the
 * right. The breadcrumb trail lives in the top bar (D-340); `crumbLabels` names the id segments of
 * the URL (`{ [campaign.id]: campaign.name }`) so that trail reads as names, not ids.
 *
 * Actions: `actions` is the primary action (one, filled). `secondaryActions` are the quieter ones
 * next to it (export menu, icon buttons). On a phone they wrap under the title.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  secondaryActions,
  meta,
  crumbLabels,
  className,
}: {
  title: string;
  subtitle?: string | undefined;
  actions?: React.ReactNode;
  secondaryActions?: React.ReactNode;
  /** Badges or a status line under the title (a campaign's status, a version). */
  meta?: React.ReactNode;
  crumbLabels?: Record<string, string> | undefined;
  className?: string | undefined;
}): React.JSX.Element {
  const hasActions = Boolean(actions) || Boolean(secondaryActions);
  return (
    <header className={cn("mb-6 flex flex-wrap items-start justify-between gap-x-4 gap-y-3", className)}>
      <CrumbLabels labels={crumbLabels} />
      <div className="min-w-0 flex-1 basis-72">
        <h1 className="text-foreground text-xl leading-tight font-semibold tracking-tight text-balance md:text-2xl">
          {title}
        </h1>
        {subtitle ? <p className="text-muted-foreground mt-1 max-w-prose text-sm">{subtitle}</p> : null}
        {meta ? <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div> : null}
      </div>
      {hasActions ? (
        <div className="flex flex-wrap items-center gap-2">
          {secondaryActions}
          {actions}
        </div>
      ) : null}
    </header>
  );
}
