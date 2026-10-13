import * as React from "react";
import { Breadcrumbs } from "./Breadcrumbs";

/**
 * Title block of every admin page: the breadcrumb trail, the title, one line of context, and the
 * page's primary actions on the right. `crumbLabels` names the id segments of the URL
 * (`{ [campaign.id]: campaign.name }`), so the trail reads as names, not ids.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  crumbLabels,
}: {
  title: string;
  subtitle?: string | undefined;
  actions?: React.ReactNode;
  crumbLabels?: Record<string, string> | undefined;
}): React.JSX.Element {
  return (
    <header className="mb-6">
      <Breadcrumbs labels={crumbLabels} />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-foreground text-2xl leading-tight font-semibold tracking-tight text-balance">
            {title}
          </h1>
          {subtitle ? <p className="text-muted-foreground mt-1 max-w-prose text-sm">{subtitle}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}
