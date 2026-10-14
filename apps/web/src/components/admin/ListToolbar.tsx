"use client";

import { ArrowDownIcon, ArrowUpIcon, SearchIcon, XIcon } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import * as React from "react";
import { startNavigationProgress } from "@/components/common/NavigationProgress";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { t } from "@/i18n";
import type { ListDef, SortDir } from "@/lib/api/lists";

export interface ToolbarFilter {
  /** The query parameter, e.g. `status`. */
  key: string;
  label: string;
  /** Label of the "no filter" choice. */
  allLabel: string;
  options: { value: string; label: string }[];
}

export interface ToolbarSort {
  /** The list's definition from `lib/api/lists.ts`: its fields, default, and each field's direction. */
  list: Pick<ListDef, "sort" | "defaultSort">;
  /** A label for each sort field offered; fields without one are not offered. */
  labels: Record<string, string>;
}

const ALL = "__all__";
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Search, filters and sort above a server-paginated list (D-79). Every control writes to the URL
 * (`q`, `sort`, `dir`, one key per filter) and the server component re-renders with the new query,
 * so a reload or a shared link lands on the same rows. Changing any of them resets `page`, because
 * page 4 of the old result says nothing about the new one.
 */
export function ListToolbar({
  searchLabel,
  filters = [],
  sort,
}: {
  /** Accessible name of the search box, e.g. "Search campaigns". */
  searchLabel?: string | undefined;
  filters?: ToolbarFilter[];
  sort?: ToolbarSort | undefined;
}): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const s = t.admin.list;
  const urlQuery = params.get("q") ?? "";
  const [query, setQuery] = React.useState(urlQuery);

  // Back and forward change the URL under us; the box follows.
  React.useEffect(() => {
    setQuery(urlQuery);
  }, [urlQuery]);

  const navigate = React.useCallback(
    (change: (q: URLSearchParams) => void) => {
      const q = new URLSearchParams(params.toString());
      change(q);
      q.delete("page");
      const qs = q.toString();
      const next = qs ? `${pathname}?${qs}` : pathname;
      if (next === `${pathname}${params.toString() ? `?${params.toString()}` : ""}`) return;
      startNavigationProgress();
      router.replace(next, { scroll: false });
    },
    [params, pathname, router],
  );

  React.useEffect(() => {
    if (query.trim() === urlQuery) return;
    const timer = window.setTimeout(() => {
      navigate((q) => {
        if (query.trim()) q.set("q", query.trim());
        else q.delete("q");
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [query, urlQuery, navigate]);

  const activeFilters = filters.filter((f) => params.get(f.key));
  const filtered = urlQuery !== "" || activeFilters.length > 0;
  const urlSort = params.get("sort");
  const sortValue = sort ? (urlSort && urlSort in sort.list.sort ? urlSort : sort.list.defaultSort) : "";
  // Each field has its own natural direction (names A to Z, dates newest first); the URL only
  // carries `dir` when the reader flipped it.
  const fieldDir: SortDir = sort ? (sort.list.sort[sortValue] ?? "asc") : "desc";
  const urlDir = params.get("dir");
  const dir: SortDir = urlDir === "asc" || urlDir === "desc" ? urlDir : fieldDir;
  const searchId = React.useId();

  return (
    <div role="search" className="mb-4 flex flex-wrap items-center gap-2">
      <div className="relative w-full sm:w-72">
        <label htmlFor={searchId} className="sr-only">
          {searchLabel ?? s.search}
        </label>
        <SearchIcon
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
          aria-hidden="true"
        />
        <Input
          id={searchId}
          type="search"
          value={query}
          maxLength={200}
          placeholder={s.searchPlaceholder}
          onChange={(e) => {
            setQuery(e.target.value);
          }}
          className="pr-8 pl-8 [&::-webkit-search-cancel-button]:hidden"
        />
        {query ? (
          <button
            type="button"
            aria-label={s.clearSearch}
            onClick={() => {
              setQuery("");
            }}
            className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 grid size-5 -translate-y-1/2 place-items-center rounded"
          >
            <XIcon className="size-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {filters.map((f) => (
        <Select
          key={f.key}
          value={params.get(f.key) ?? ALL}
          onValueChange={(v) => {
            navigate((q) => {
              if (v === ALL) q.delete(f.key);
              else q.set(f.key, v);
            });
          }}
        >
          <SelectTrigger aria-label={f.label} className="min-w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{f.allLabel}</SelectItem>
            {f.options.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ))}

      {sort ? (
        <div className="flex items-center gap-1 sm:ml-auto">
          <Select
            value={sortValue}
            onValueChange={(v) => {
              navigate((q) => {
                if (v === sort.list.defaultSort) q.delete("sort");
                else q.set("sort", v);
                q.delete("dir");
              });
            }}
          >
            <SelectTrigger aria-label={s.sortBy} className="min-w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.keys(sort.list.sort)
                .filter((field) => sort.labels[field] !== undefined)
                .map((field) => (
                  <SelectItem key={field} value={field}>
                    {sort.labels[field]}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={dir === "asc" ? s.ascending : s.descending}
            title={dir === "asc" ? s.ascending : s.descending}
            onClick={() => {
              const next = dir === "asc" ? "desc" : "asc";
              navigate((q) => {
                if (next === fieldDir) q.delete("dir");
                else q.set("dir", next);
              });
            }}
          >
            {dir === "asc" ? <ArrowUpIcon aria-hidden="true" /> : <ArrowDownIcon aria-hidden="true" />}
          </Button>
        </div>
      ) : null}

      {filtered ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setQuery("");
            navigate((q) => {
              q.delete("q");
              for (const f of filters) q.delete(f.key);
            });
          }}
        >
          {s.clearFilters}
        </Button>
      ) : null}
    </div>
  );
}
