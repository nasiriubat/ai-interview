import { ArrowRightIcon, BugIcon } from "lucide-react";
import Link from "next/link";
import * as React from "react";
import { Panel } from "@/components/admin/Panel";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import type { ErrorSummary } from "@/lib/api/schemas";
import { cn, formatNumber } from "@/lib/utils";

/**
 * The error log on the operator's health page (D-477): how many failures in the last day and week,
 * how many faults are still open, and the way to the list. Quiet when there is nothing.
 */
export function ErrorsCard({ summary }: { summary: ErrorSummary }): React.JSX.Element {
  const k = t.admin.operator.errors;
  const figures = [
    { label: k.last24h, value: summary.last24h },
    { label: k.last7d, value: summary.last7d },
  ];
  return (
    <Panel
      title={k.card.title}
      description={k.card.description}
      headingLevel={2}
      actions={
        <Button asChild variant="outline" size="sm">
          <Link href="/admin/operator/errors">
            {k.card.view} <ArrowRightIcon aria-hidden="true" />
          </Link>
        </Button>
      }
    >
      <div className="flex flex-wrap items-center gap-x-10 gap-y-4 px-5 py-4">
        <dl className="flex flex-wrap gap-x-10 gap-y-3">
          {figures.map((f) => (
            <div key={f.label}>
              <dt className="text-muted-foreground text-[13px] font-medium">{f.label}</dt>
              <dd className="text-foreground mt-1 text-2xl leading-none font-semibold tracking-tight tabular-nums">
                {formatNumber(f.value)}
              </dd>
            </div>
          ))}
        </dl>
        <p
          className={cn(
            "flex items-center gap-2 text-sm",
            summary.open24h > 0 ? "text-foreground font-medium" : "text-muted-foreground",
          )}
        >
          <BugIcon
            className={cn(
              "size-4 shrink-0",
              summary.open24h > 0 ? "text-destructive" : "text-muted-foreground",
            )}
            aria-hidden="true"
          />
          {k.card.open(summary.open24h)}
        </p>
      </div>
    </Panel>
  );
}
