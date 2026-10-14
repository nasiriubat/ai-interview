"use client";

import { ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";
import { useCrumbLabels } from "@/components/admin/shell/crumbs";
import { t } from "@/i18n";
import { buildCrumbs } from "@/lib/admin/breadcrumbs";
import { cn } from "@/lib/utils";

/**
 * The trail in the top bar, derived from the URL (D-78). Names of id segments come from the page
 * through `CrumbLabels` (`PageHeader`'s `crumbLabels`). Below `sm` only the current page and its
 * parent are drawn, which is what a "back" affordance needs on a phone.
 */
export function Breadcrumbs({
  labels,
  className,
}: {
  labels?: Record<string, string> | undefined;
  className?: string | undefined;
}): React.JSX.Element | null {
  const pathname = usePathname();
  const fromPage = useCrumbLabels();
  const crumbs = buildCrumbs(pathname, { ...fromPage, ...labels });
  if (crumbs.length === 0) return null;
  return (
    <nav aria-label={t.admin.crumbs.label} className={cn("min-w-0 print:hidden", className)}>
      <ol className="text-muted-foreground flex min-w-0 items-center gap-1 text-[13px]">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          const nearEnd = i >= crumbs.length - 2;
          return (
            <li
              key={`${String(i)}-${c.label}`}
              className={cn(
                "flex min-w-0 items-center gap-1",
                !nearEnd && "hidden sm:flex",
                last && "shrink",
              )}
            >
              {i > 0 ? (
                <ChevronRightIcon
                  className={cn("size-3.5 shrink-0 opacity-60", i === crumbs.length - 2 && "max-sm:hidden")}
                  aria-hidden="true"
                />
              ) : null}
              {c.href ? (
                <Link
                  href={c.href}
                  className="hover:text-primary max-w-[12rem] truncate transition-colors lg:max-w-[16rem]"
                >
                  {c.label}
                </Link>
              ) : (
                <span aria-current="page" className="text-foreground max-w-[20rem] truncate font-medium">
                  {c.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
