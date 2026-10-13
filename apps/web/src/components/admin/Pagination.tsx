"use client";

import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import * as React from "react";
import { startNavigationProgress } from "@/components/common/NavigationProgress";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { DEFAULT_PAGE_SIZE, hasNextPage, PAGE_SIZES, pageRange, pageWindow } from "@/lib/admin/pagination";
import { cn } from "@/lib/utils";

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
  const router = useRouter();
  const s = t.admin.pagination;
  const { from, to } = pageRange(page, limit, count);
  const next = hasNextPage(page, limit, count, total);
  const prev = page > 1;
  const pages = total === null ? null : Math.max(1, Math.ceil(total / limit));

  // One page that could not be split any smaller: nothing to navigate, nothing to resize.
  if (!prev && !next && (total === null || total <= PAGE_SIZES[0])) return null;

  const href = (p: number): string => {
    const q = new URLSearchParams(params.toString());
    if (p <= 1) q.delete(paramName);
    else q.set(paramName, String(p));
    const qs = q.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  };

  const setSize = (size: number): void => {
    const q = new URLSearchParams(params.toString());
    // A new page size re-flows every page, so the reader goes back to the first one.
    q.delete(paramName);
    if (size === DEFAULT_PAGE_SIZE) q.delete("limit");
    else q.set("limit", String(size));
    const qs = q.toString();
    startNavigationProgress();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  };

  const sizeId = `${paramName}-size`;
  return (
    <nav aria-label={label ?? s.label} className="mt-4 flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-4">
        <p className="text-muted-foreground text-[13px] tabular-nums" role="status">
          {total === null ? s.range(from, to) : s.rangeOf(from, to, total)}
        </p>
        <div className="flex items-center gap-2">
          <label htmlFor={sizeId} className="text-muted-foreground text-[13px]">
            {t.admin.list.rowsPerPage}
          </label>
          <select
            id={sizeId}
            value={limit}
            onChange={(e) => {
              setSize(Number(e.target.value));
            }}
            className="bg-card text-foreground shadow-control focus-visible:ring-ring/40 h-8 rounded-md border-0 px-2 text-[13px] outline-none focus-visible:ring-[3px]"
          >
            {(PAGE_SIZES as readonly number[]).includes(limit) ? null : (
              <option value={limit}>{limit}</option>
            )}
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex items-center gap-1">
        <PageLink href={href(page - 1)} enabled={prev} label={s.previous}>
          <ChevronLeftIcon aria-hidden="true" /> <span className="hidden sm:inline">{s.previous}</span>
        </PageLink>
        {pages !== null && pages > 1 ? (
          <ol className="hidden items-center gap-1 sm:flex">
            {pageWindow(page, pages).map((p, i) =>
              p === "gap" ? (
                <li
                  key={`gap-${String(i)}`}
                  aria-hidden="true"
                  className="text-muted-foreground px-1 text-[13px]"
                >
                  …
                </li>
              ) : (
                <li key={p}>
                  <Link
                    href={href(p)}
                    aria-label={t.admin.list.page(p)}
                    aria-current={p === page ? "page" : undefined}
                    className={cn(
                      "grid h-8 min-w-8 place-items-center rounded-md px-2 text-[13px] font-medium tabular-nums transition-colors",
                      p === page
                        ? "bg-primary text-primary-foreground"
                        : "text-body hover:bg-card hover:shadow-control",
                    )}
                  >
                    {p}
                  </Link>
                </li>
              ),
            )}
          </ol>
        ) : null}
        <PageLink href={href(page + 1)} enabled={next} label={s.next}>
          <span className="hidden sm:inline">{s.next}</span> <ChevronRightIcon aria-hidden="true" />
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
