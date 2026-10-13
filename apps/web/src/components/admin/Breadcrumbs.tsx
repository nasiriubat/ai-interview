"use client";

import { ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";
import { t } from "@/i18n";
import { buildCrumbs } from "@/lib/admin/breadcrumbs";

/** The trail above every admin page title. Hidden on the dashboard, where it would be one word. */
export function Breadcrumbs({
  labels,
}: {
  labels?: Record<string, string> | undefined;
}): React.JSX.Element | null {
  const pathname = usePathname();
  const crumbs = buildCrumbs(pathname, labels);
  if (crumbs.length < 2) return null;
  return (
    <nav aria-label={t.admin.crumbs.label} className="mb-2 print:hidden">
      <ol className="text-muted-foreground flex flex-wrap items-center gap-1 text-[13px]">
        {crumbs.map((c, i) => (
          <li key={`${String(i)}-${c.label}`} className="flex min-w-0 items-center gap-1">
            {i > 0 ? <ChevronRightIcon className="size-3.5 shrink-0 opacity-60" aria-hidden="true" /> : null}
            {c.href ? (
              <Link href={c.href} className="hover:text-primary max-w-[16rem] truncate transition-colors">
                {c.label}
              </Link>
            ) : (
              <span aria-current="page" className="text-foreground max-w-[20rem] truncate font-medium">
                {c.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
