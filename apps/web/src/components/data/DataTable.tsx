"use client";

import {
  AlertTriangleIcon,
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  CalendarRangeIcon,
  Columns3Icon,
  InboxIcon,
  SearchIcon,
  SearchXIcon,
  XIcon,
} from "lucide-react";
import * as React from "react";
import { Pagination } from "@/components/admin/Pagination";
import { useUrlState } from "@/components/data/useUrlState";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { t } from "@/i18n";
import {
  activeChips,
  activeSort,
  ariaSort,
  clearAllChanges,
  parseHiddenColumns,
  sortClick,
  type FilterDef,
  type SortSpec,
} from "@/lib/admin/table-state";
import { cn } from "@/lib/utils";

export type { FilterDef, SortSpec };

/**
 * A column. Everything here is data, so a server component can declare a whole table: the cells
 * themselves are elements the page renders (`row.cells`), never functions.
 */
export interface DataColumn {
  id: string;
  header: string;
  /** The list's sort key for this column; without one the header is not clickable. */
  sortKey?: string;
  align?: "start" | "end";
  /** The first line of a row's card on a phone, shown without a label. One per table. */
  primary?: boolean;
  /** Hidden until chosen in the Columns menu. */
  defaultHidden?: boolean;
  /** Always shown, not in the Columns menu. */
  locked?: boolean;
  className?: string;
}

export interface DataRow {
  id: string;
  /** What names the row to assistive technology: "Select <label>" on its checkbox. */
  label: string;
  cells: Record<string, React.ReactNode>;
  /** Icon-only buttons (`IconButton` inside `RowActions`) shown at the end of the row. */
  actions?: React.ReactNode;
}

export interface DataTableEmpty {
  title?: string;
  description?: string;
  /** What gets the first row in: a link or button. */
  action?: React.ReactNode;
  icon?: React.ReactNode;
}

interface SelectionApi {
  ids: string[];
  clear: () => void;
}
const SelectionContext = React.createContext<SelectionApi>({ ids: [], clear: () => undefined });

/** For bulk-action buttons rendered inside the table's `bulkActions`: who is selected, and how to let go. */
export function useTableSelection(): SelectionApi {
  return React.useContext(SelectionContext);
}

const ALL = "__all__";
const SEARCH_DEBOUNCE_MS = 300;

export interface DataTableProps {
  /** Names the table for assistive technology and keys the stored column choice. */
  id: string;
  label: string;
  columns: DataColumn[];
  rows: DataRow[];
  /** From `listParams`: current page, size, rows on it, and the server's total (null if unknown). */
  page: { page: number; limit: number; count: number; total: number | null };
  /** `sortOf(LISTS.x)`: makes headers sortable. */
  sort?: SortSpec | undefined;
  /** Accessible name of the search box. Without it the table has no search. */
  searchLabel?: string | undefined;
  filters?: FilterDef[];
  selectable?: boolean;
  /** Buttons for the selected rows; read the selection with `useTableSelection`. */
  bulkActions?: React.ReactNode;
  /** Beside the Columns menu: an export menu, an import button. */
  toolbarActions?: React.ReactNode;
  empty?: DataTableEmpty;
  /** The rows could not be loaded: shows the message with a retry instead of the rows. */
  error?: string | undefined;
  /** Render the skeleton (a route's `loading.tsx`). */
  loading?: boolean;
  className?: string;
}

/**
 * The one table of the admin (D-341). Server-paginated and server-sorted: the URL holds page, page
 * size, search, sort and filters; this component reads and writes it and shows what the server
 * sent. Search, select and date-range filters with removable chips, sortable headers, a column
 * menu (remembered in this browser), row selection with bulk actions, icon-only row actions,
 * loading, empty and error states, and below `md` every row collapses to a card.
 */
export function DataTable({
  id,
  label,
  columns,
  rows,
  page,
  sort,
  searchLabel,
  filters = [],
  selectable = false,
  bulkActions,
  toolbarActions,
  empty,
  error,
  loading = false,
  className,
}: DataTableProps): React.JSX.Element {
  const k = t.kit.table;
  const { params, pending, update, refresh } = useUrlState();

  // --- search -----------------------------------------------------------------------------------
  const urlQuery = params.get("q") ?? "";
  const [query, setQuery] = React.useState(urlQuery);
  React.useEffect(() => {
    setQuery(urlQuery);
  }, [urlQuery]);
  React.useEffect(() => {
    if (query.trim() === urlQuery) return;
    const timer = window.setTimeout(() => {
      update({ q: query.trim() === "" ? null : query.trim() });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [query, urlQuery, update]);

  // --- column visibility (a per-viewer convenience, so storage may fail) --------------------------
  const storageKey = `aidp.cols.${id}`;
  const known = columns.map((c) => c.id);
  const [hidden, setHidden] = React.useState<string[]>(() =>
    columns.filter((c) => c.defaultHidden && !c.locked).map((c) => c.id),
  );
  React.useEffect(() => {
    try {
      const stored = parseHiddenColumns(window.localStorage.getItem(storageKey), known);
      if (stored) setHidden(stored);
    } catch {
      // Storage blocked: the defaults stay.
    }
    // `known` is derived from `columns`, which is stable per table.
  }, [storageKey]);
  const toggleColumn = (columnId: string, visible: boolean): void => {
    const next = visible ? hidden.filter((h) => h !== columnId) : [...hidden, columnId];
    setHidden(next);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // Not remembered; the table still changed.
    }
  };
  const visible = columns.filter((c) => c.locked === true || !hidden.includes(c.id));
  const hideable = columns.filter((c) => !c.locked);

  // --- selection --------------------------------------------------------------------------------
  const [selected, setSelected] = React.useState<string[]>([]);
  const rowIds = rows.map((r) => r.id).join("|");
  React.useEffect(() => {
    // A new page (or new filter) is a new set of rows: what was ticked is not on screen any more.
    setSelected([]);
  }, [rowIds]);
  const allSelected = rows.length > 0 && selected.length === rows.length;
  const selection = React.useMemo<SelectionApi>(
    () => ({
      ids: selected,
      clear: () => {
        setSelected([]);
      },
    }),
    [selected],
  );

  // --- chips --------------------------------------------------------------------------------------
  const chips = activeChips(params, filters, searchLabel, {
    search: (q) => `“${q}”`,
    range: (lbl, from, to) => `${lbl}: ${from || "…"} – ${to || "…"}`,
  });
  const filtered = chips.length > 0;
  const current = sort ? activeSort(params, sort) : null;
  const sortable = sort
    ? columns.filter((c) => c.sortKey !== undefined && Object.hasOwn(sort.sort, c.sortKey))
    : [];
  const searchId = React.useId();

  const showToolbar =
    Boolean(searchLabel) ||
    filters.length > 0 ||
    Boolean(toolbarActions) ||
    (hideable.length > 0 && rows.length > 0 && !error);

  return (
    <SelectionContext.Provider value={selection}>
      <section
        aria-label={k.region(label)}
        aria-busy={pending || loading}
        className={cn("bg-card shadow-card min-w-0 rounded-lg", className)}
      >
        {/* Sticky: search and filters stay in reach while a long page scrolls. */}
        {showToolbar || selected.length > 0 ? (
          <div className="bg-card sticky top-14 z-20 rounded-t-lg border-b lg:top-16">
            {selected.length > 0 ? (
              <div
                role="status"
                className="bg-accent text-accent-foreground flex min-h-14 flex-wrap items-center gap-2 rounded-t-lg px-3 py-2"
              >
                <p className="text-sm font-medium">{k.selected(selected.length)}</p>
                <div className="flex flex-wrap items-center gap-1.5">{bulkActions}</div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  onClick={() => {
                    setSelected([]);
                  }}
                >
                  <XIcon aria-hidden="true" />
                  {k.clearSelection}
                </Button>
              </div>
            ) : (
              <div role="search" className="flex min-h-14 flex-wrap items-center gap-2 px-3 py-2">
                {searchLabel ? (
                  <div className="relative w-full sm:w-64 lg:w-72">
                    <label htmlFor={searchId} className="sr-only">
                      {searchLabel}
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
                      placeholder={k.searchPlaceholder}
                      onChange={(e) => {
                        setQuery(e.target.value);
                      }}
                      className="pr-8 pl-8 [&::-webkit-search-cancel-button]:hidden"
                    />
                    {query ? (
                      <button
                        type="button"
                        aria-label={k.clearSearch}
                        onClick={() => {
                          setQuery("");
                        }}
                        className="text-muted-foreground hover:text-foreground absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 place-items-center rounded"
                      >
                        <XIcon className="size-3.5" aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                ) : null}

                {filters.map((f) =>
                  f.type === "select" ? (
                    <Select
                      key={f.key}
                      value={params.get(f.key) ?? ALL}
                      onValueChange={(v) => {
                        update({ [f.key]: v === ALL ? null : v });
                      }}
                    >
                      <SelectTrigger aria-label={k.filterBy(f.label)} className="min-w-32">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={ALL}>
                          {f.label}: {k.any}
                        </SelectItem>
                        {f.options.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <DateRangeFilter
                      key={`${f.fromKey}-${f.toKey}`}
                      def={f}
                      from={params.get(f.fromKey) ?? ""}
                      to={params.get(f.toKey) ?? ""}
                      onChange={(from, to) => {
                        update({ [f.fromKey]: from || null, [f.toKey]: to || null });
                      }}
                    />
                  ),
                )}

                <div className="ml-auto flex items-center gap-1.5">
                  {sort && sortable.length > 0 && current ? (
                    <div className="md:hidden">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="outline" size="icon" aria-label={t.admin.list.sortBy}>
                            <ArrowUpDownIcon aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          <DropdownMenuLabel>{t.admin.list.sortBy}</DropdownMenuLabel>
                          <DropdownMenuRadioGroup
                            value={current.sort}
                            onValueChange={(v) => {
                              if (v === current.sort) update(sortClick(params, sort, v));
                              else {
                                const c = new URLSearchParams(params.toString());
                                c.delete("sort");
                                c.delete("dir");
                                update(sortClick(c, sort, v));
                              }
                            }}
                          >
                            {sortable.map((c) => (
                              <DropdownMenuRadioItem
                                key={c.id}
                                value={c.sortKey ?? c.id}
                                onSelect={(e) => {
                                  e.preventDefault();
                                }}
                              >
                                {c.header}
                                {current.sort === c.sortKey ? (
                                  <span className="text-muted-foreground ml-auto text-xs">
                                    {current.dir === "asc" ? "↑" : "↓"}
                                  </span>
                                ) : null}
                              </DropdownMenuRadioItem>
                            ))}
                          </DropdownMenuRadioGroup>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  ) : null}
                  {hideable.length > 0 ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="icon" aria-label={k.columns} title={k.columnsHelp}>
                          <Columns3Icon aria-hidden="true" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        <DropdownMenuLabel>{k.columns}</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        {hideable.map((c) => (
                          <DropdownMenuCheckboxItem
                            key={c.id}
                            checked={!hidden.includes(c.id)}
                            onCheckedChange={(v) => {
                              toggleColumn(c.id, v);
                            }}
                            onSelect={(e) => {
                              e.preventDefault();
                            }}
                          >
                            {c.header}
                          </DropdownMenuCheckboxItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                  {toolbarActions}
                </div>
              </div>
            )}
            {filtered && selected.length === 0 ? (
              <div
                className="flex flex-wrap items-center gap-1.5 px-3 pb-2.5"
                aria-label={k.activeFilters}
                role="group"
              >
                {chips.map((chip) => (
                  <span
                    key={chip.id}
                    className="bg-accent text-accent-foreground inline-flex h-7 max-w-full items-center gap-1 rounded-full pr-1 pl-2.5 text-xs font-medium"
                  >
                    <span className="truncate">{chip.text}</span>
                    <button
                      type="button"
                      aria-label={k.removeFilter(chip.text)}
                      onClick={() => {
                        update(chip.clear);
                      }}
                      className="hover:bg-card/70 grid size-5 place-items-center rounded-full"
                    >
                      <XIcon className="size-3" aria-hidden="true" />
                    </button>
                  </span>
                ))}
                {chips.length > 1 ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7"
                    onClick={() => {
                      setQuery("");
                      update(clearAllChanges(filters));
                    }}
                  >
                    {k.clearAll}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className={cn("transition-opacity", pending && "opacity-60")}>
          {error ? (
            <div role="alert" className="flex flex-col items-center gap-3 px-6 py-14 text-center">
              <span className="bg-destructive-soft text-destructive-soft-foreground grid size-10 place-items-center rounded-full">
                <AlertTriangleIcon className="size-5" aria-hidden="true" />
              </span>
              <div>
                <p className="text-foreground text-sm font-medium">{k.errorTitle}</p>
                <p className="text-muted-foreground mt-1 max-w-md text-sm">{error}</p>
              </div>
              <Button variant="outline" size="sm" onClick={refresh} loading={pending}>
                {k.retry}
              </Button>
            </div>
          ) : loading ? (
            <TableSkeleton columns={visible.length} selectable={selectable} />
          ) : rows.length === 0 ? (
            <EmptyBody
              filtered={filtered}
              empty={empty}
              onClear={() => {
                setQuery("");
                update(clearAllChanges(filters));
              }}
            />
          ) : (
            <div className="relative overflow-x-auto" tabIndex={0} aria-label={k.region(label)} role="region">
              <table role="table" className="w-full text-sm tabular-nums max-md:block">
                <thead role="rowgroup" className="max-md:sr-only">
                  <tr role="row" className="bg-muted/50 border-b">
                    {selectable ? (
                      <th role="columnheader" scope="col" className="w-10 py-2 pr-0 pl-3 text-left">
                        <Checkbox
                          aria-label={k.selectAll}
                          checked={allSelected ? true : selected.length > 0 ? "indeterminate" : false}
                          onCheckedChange={(v) => {
                            setSelected(v === true ? rows.map((r) => r.id) : []);
                          }}
                        />
                      </th>
                    ) : null}
                    {visible.map((c) => {
                      const dir = ariaSort(params, sort, c.sortKey);
                      return (
                        <th
                          key={c.id}
                          role="columnheader"
                          scope="col"
                          aria-sort={dir}
                          className={cn(
                            "text-muted-foreground h-10 px-3 text-xs font-medium tracking-wide whitespace-nowrap uppercase",
                            c.align === "end" ? "text-right" : "text-left",
                            c.className,
                          )}
                        >
                          {sort && c.sortKey && dir !== undefined ? (
                            <button
                              type="button"
                              aria-label={k.sortBy(c.header)}
                              onClick={() => {
                                update(sortClick(params, sort, c.sortKey ?? ""));
                              }}
                              className={cn(
                                "hover:text-foreground -mx-1.5 inline-flex items-center gap-1 rounded px-1.5 py-1 uppercase transition-colors",
                                dir !== "none" && "text-foreground",
                              )}
                            >
                              {c.header}
                              {dir === "ascending" ? (
                                <ArrowUpIcon className="size-3.5" aria-hidden="true" />
                              ) : dir === "descending" ? (
                                <ArrowDownIcon className="size-3.5" aria-hidden="true" />
                              ) : (
                                <ArrowUpDownIcon className="size-3.5 opacity-40" aria-hidden="true" />
                              )}
                            </button>
                          ) : (
                            c.header
                          )}
                        </th>
                      );
                    })}
                    <th role="columnheader" scope="col" className="w-px px-3">
                      <span className="sr-only">{k.actions}</span>
                    </th>
                  </tr>
                </thead>
                <tbody role="rowgroup" className="max-md:grid max-md:gap-2 max-md:p-2">
                  {rows.map((row) => {
                    const isSelected = selected.includes(row.id);
                    return (
                      <tr
                        key={row.id}
                        role="row"
                        data-state={isSelected ? "selected" : undefined}
                        className="hover:bg-muted/50 data-[state=selected]:bg-accent/60 border-b transition-colors last:border-b-0 max-md:relative max-md:grid max-md:gap-1.5 max-md:rounded-lg max-md:border max-md:p-3 max-md:pr-12 max-md:last:border-b"
                      >
                        {selectable ? (
                          <td
                            role="cell"
                            className="w-10 py-2.5 pr-0 pl-3 max-md:absolute max-md:top-3 max-md:right-3 max-md:w-auto max-md:p-0"
                          >
                            <Checkbox
                              aria-label={k.selectRow(row.label)}
                              checked={isSelected}
                              onCheckedChange={(v) => {
                                setSelected((s) =>
                                  v === true ? [...s, row.id] : s.filter((x) => x !== row.id),
                                );
                              }}
                            />
                          </td>
                        ) : null}
                        {visible.map((c) => (
                          <td
                            key={c.id}
                            role="cell"
                            data-label={c.primary ? undefined : c.header}
                            className={cn(
                              "px-3 py-2.5 align-middle",
                              c.align === "end" && "text-right",
                              "max-md:flex max-md:items-baseline max-md:justify-between max-md:gap-3 max-md:p-0 max-md:text-left",
                              !c.primary &&
                                "max-md:before:text-muted-foreground max-md:before:shrink-0 max-md:before:text-xs max-md:before:content-[attr(data-label)]",
                              c.primary &&
                                "max-md:text-foreground max-md:order-first max-md:text-[15px] max-md:font-medium max-md:[&>div]:text-left",
                              c.className,
                            )}
                          >
                            <div className="max-md:min-w-0 max-md:text-right">
                              {row.cells[c.id] ?? t.admin.common.dash}
                            </div>
                          </td>
                        ))}
                        <td
                          role="cell"
                          className="px-3 py-1.5 text-right align-middle whitespace-nowrap max-md:p-0 max-md:pt-1 max-md:empty:hidden"
                        >
                          {row.actions}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {!error && !loading && rows.length > 0 ? (
          <div className="border-t px-3 py-2.5 empty:hidden">
            <Pagination
              page={page.page}
              limit={page.limit}
              count={page.count}
              total={page.total}
              className="mt-0"
            />
          </div>
        ) : null}
        <p role="status" className="sr-only">
          {pending ? k.refreshing : error || loading ? "" : k.loaded(page.count)}
        </p>
      </section>
    </SelectionContext.Provider>
  );
}

function EmptyBody({
  filtered,
  empty,
  onClear,
}: {
  filtered: boolean;
  empty: DataTableEmpty | undefined;
  onClear: () => void;
}): React.JSX.Element {
  const k = t.kit.table;
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
      <span className="bg-accent text-accent-foreground grid size-10 place-items-center rounded-full">
        {filtered ? (
          <SearchXIcon className="size-5" aria-hidden="true" />
        ) : (
          (empty?.icon ?? <InboxIcon className="size-5" aria-hidden="true" />)
        )}
      </span>
      <div>
        <p className="text-foreground text-sm font-medium">
          {filtered ? k.noMatchesTitle : (empty?.title ?? k.emptyTitle)}
        </p>
        <p className="text-muted-foreground mx-auto mt-1 max-w-sm text-sm">
          {filtered ? k.noMatches : empty?.description}
        </p>
      </div>
      {filtered ? (
        <Button variant="outline" size="sm" onClick={onClear}>
          {k.clearAll}
        </Button>
      ) : (
        empty?.action
      )}
    </div>
  );
}

/** The loading state of a table: the toolbar's height and a handful of rows. */
export function TableSkeleton({
  columns = 5,
  rows = 6,
  selectable = false,
}: {
  columns?: number;
  rows?: number;
  selectable?: boolean;
}): React.JSX.Element {
  return (
    <div role="status" aria-label={t.kit.table.loading} className="divide-y">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex items-center gap-4 px-3 py-3.5">
          {selectable ? <Skeleton className="size-4 shrink-0" /> : null}
          {Array.from({ length: Math.max(2, columns) }, (_, c) => (
            <Skeleton
              key={c}
              className={cn("h-4", c === 0 ? "w-1/4 min-w-24" : "w-1/6 min-w-12", c > 2 && "max-md:hidden")}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** A whole table page while its data loads: the card, a toolbar and rows. For `loading.tsx`. */
export function DataTableSkeleton({
  columns = 5,
  rows = 8,
}: {
  columns?: number;
  rows?: number;
}): React.JSX.Element {
  return (
    <div className="bg-card shadow-card rounded-lg" aria-busy="true">
      <div className="flex items-center gap-2 border-b p-3">
        <Skeleton className="h-9 w-64 max-w-full" />
        <Skeleton className="h-9 w-32" />
      </div>
      <TableSkeleton columns={columns} rows={rows} />
    </div>
  );
}

function DateRangeFilter({
  def,
  from,
  to,
  onChange,
}: {
  def: Extract<FilterDef, { type: "date-range" }>;
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
}): React.JSX.Element {
  const k = t.kit.table;
  const fromId = React.useId();
  const toId = React.useId();
  const active = from !== "" || to !== "";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          aria-label={def.label}
          className={cn("font-normal", active && "text-primary")}
        >
          <CalendarRangeIcon aria-hidden="true" className="text-muted-foreground" />
          {active ? `${from || "…"} – ${to || "…"}` : def.label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="grid w-64 gap-3">
        <div className="grid gap-1.5">
          <label htmlFor={fromId} className="text-sm font-medium">
            {k.from}
          </label>
          <Input
            id={fromId}
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => {
              onChange(e.target.value, to);
            }}
          />
        </div>
        <div className="grid gap-1.5">
          <label htmlFor={toId} className="text-sm font-medium">
            {k.to}
          </label>
          <Input
            id={toId}
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => {
              onChange(from, e.target.value);
            }}
          />
        </div>
        {active ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onChange("", "");
            }}
          >
            {k.clearAll}
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
