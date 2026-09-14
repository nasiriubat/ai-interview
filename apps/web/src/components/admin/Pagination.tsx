"use client";

import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { hasNextPage, pageRange } from "@/lib/admin/pagination";

/**
 * "x to y of n" with previous and next. The page lives in the URL (`?page=2`) so a reload
 * and a shared link land on the same rows. Without a `total` (an API that does not send the
 * counter) the count is hidden and "next" is offered only while a full page came back.
 */
export function Pagination({
  page,
  limit,
  count,
  total,
  paramName = "page",
  label,
}: {
  page: number;
  limit: number;
  /** Rows on the current page. */
  count: number;
  total: number | null;
  paramName?: string;
  label?: string;
}): React.JSX.Element | null {
  const pathname = usePathname();
  const params = useSearchParams();
  const s = t.admin.pagination;
  const { from, to } = pageRange(page, limit, count);
  const next = hasNextPage(page, limit, count, total);
  const prev = page > 1;

  if (!prev && !next) return null;

  const href = (p: number): string => {
    const q = new URLSearchParams(params.toString());
    if (p <= 1) q.delete(paramName);
    else q.set(paramName, String(p));
    const qs = q.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  };

  return (
    <nav aria-label={label ?? s.label} className="mt-4 flex flex-wrap items-center justify-between gap-3">
      <p className="text-muted-foreground text-xs" role="status">
        {total === null ? s.range(from, to) : s.rangeOf(from, to, total)}
      </p>
      <div className="flex items-center gap-2">
        <PageLink href={href(page - 1)} enabled={prev} label={s.previous}>
          <ChevronLeftIcon aria-hidden="true" /> {s.previous}
        </PageLink>
        <PageLink href={href(page + 1)} enabled={next} label={s.next}>
          {s.next} <ChevronRightIcon aria-hidden="true" />
        </PageLink>
      </div>
    </nav>
  );
}

function PageLink({
  href,
  enabled,
  label,
  children,
}: {
  href: string;
  enabled: boolean;
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  if (!enabled) {
    return (
      <Button variant="outline" size="sm" disabled aria-label={label}>
        {children}
      </Button>
    );
  }
  return (
    <Button asChild variant="outline" size="sm">
      <Link href={href} aria-label={label}>
        {children}
      </Link>
    </Button>
  );
}
