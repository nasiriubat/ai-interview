"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import * as React from "react";
import { startNavigationProgress } from "@/components/common/NavigationProgress";
import { applyChanges, hrefWith, type ParamChanges } from "@/lib/admin/table-state";

/**
 * The list's state is the URL (D-341): page, page size, search, sort and filters live in the query
 * string, the server component reads them and renders the rows, and a reload, the back button or a
 * shared link lands on the same view. `update` writes through `router.replace`, resets the page,
 * and reports `pending` while the server renders the new rows, which is what the table dims on.
 */
export function useUrlState(): {
  params: URLSearchParams;
  pathname: string;
  pending: boolean;
  update: (changes: ParamChanges) => void;
  refresh: () => void;
} {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const [pending, startTransition] = React.useTransition();
  const params = React.useMemo(() => new URLSearchParams(search.toString()), [search]);

  const update = React.useCallback(
    (changes: ParamChanges): void => {
      const next = applyChanges(params, changes);
      const href = hrefWith(pathname, next);
      if (href === hrefWith(pathname, params)) return;
      startNavigationProgress();
      startTransition(() => {
        router.replace(href, { scroll: false });
      });
    },
    [params, pathname, router],
  );

  const refresh = React.useCallback((): void => {
    startNavigationProgress();
    startTransition(() => {
      router.refresh();
    });
  }, [router]);

  return { params, pathname, pending, update, refresh };
}
