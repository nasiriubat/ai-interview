import type { FilterKind, FiltersOf, ListDef, ListQueryOf, SortDir, SortOf } from "@/lib/api/lists";

/** Contract 19: every paginated staff list takes `limit` (1 to 200, default 50) and `offset`. */
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export interface PageParams {
  /** 1-based, as it appears in the URL. */
  page: number;
  limit: number;
  offset: number;
}

type SearchParams = Record<string, string | string[] | undefined>;

function firstValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** Reads `?page=` (and an optional `?limit=`) out of a server component's search params. */
export function pageParams(sp: SearchParams, defaultLimit = DEFAULT_PAGE_SIZE, key = "page"): PageParams {
  const rawPage = Number(firstValue(sp[key]));
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
  const rawLimit = Number(firstValue(sp.limit));
  const limit =
    Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.min(Math.floor(rawLimit), MAX_PAGE_SIZE) : defaultLimit;
  return { page, limit, offset: (page - 1) * limit };
}

/** The longest `q` the API accepts. */
export const MAX_SEARCH_LENGTH = 200;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function validFilter(kind: FilterKind, value: string): boolean {
  if (kind === "date") {
    // `2026-02-31` parses (it rolls over), so the round trip is what proves the date exists.
    const d = new Date(`${value}T00:00:00Z`);
    return DATE.test(value) && !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
  }
  if ("pattern" in kind) return value.length <= kind.max && kind.pattern.test(value);
  return kind.includes(value);
}

/**
 * The page, search, sort and filters of one staff list, read from a server component's search
 * params (D-79). Anything the list does not accept is dropped rather than sent, so a hand-edited
 * or stale URL shows the default list instead of an error page.
 */
export interface ListParams<L extends ListDef> extends PageParams {
  q: string | undefined;
  /** The sort in effect: the URL's if valid, else the list's default. */
  sort: SortOf<L>;
  /** The direction in effect: the URL's if valid, else the sort field's default. */
  dir: SortDir;
  filters: FiltersOf<L>;
  /** Ready to hand to the matching `staffApi` list method. Omits what equals the default. */
  query: ListQueryOf<L>;
}

export function listParams<L extends ListDef>(
  sp: SearchParams,
  list: L,
  defaultLimit = DEFAULT_PAGE_SIZE,
  key = "page",
): ListParams<L> {
  const win = pageParams(sp, defaultLimit, key);
  const rawQ = firstValue(sp.q)?.trim();
  const q = list.search && rawQ ? rawQ.slice(0, MAX_SEARCH_LENGTH) : undefined;
  const rawSort = firstValue(sp.sort);
  const sortGiven = rawSort !== undefined && Object.hasOwn(list.sort, rawSort);
  const sort = (sortGiven ? rawSort : list.defaultSort) as SortOf<L>;
  const rawDir = firstValue(sp.dir);
  const dirGiven = rawDir === "asc" || rawDir === "desc";
  const dir: SortDir = dirGiven ? rawDir : (list.sort[sort] ?? "desc");

  const filters: Record<string, string> = {};
  for (const [name, kind] of Object.entries(list.filters)) {
    const value = firstValue(sp[name])?.trim();
    if (value && validFilter(kind, value)) filters[name] = value;
  }
  // A backwards date range is a 400 at the API; a reader who typed it meant the other way round.
  const { from, to } = filters;
  if (from && to && from > to) [filters.from, filters.to] = [to, from];

  const query: Record<string, string | number> = {
    limit: win.limit,
    offset: win.offset,
    ...(q ? { q } : {}),
    ...(sortGiven ? { sort } : {}),
    ...(dirGiven ? { dir } : {}),
    ...filters,
  };
  return {
    ...win,
    q,
    sort,
    dir,
    filters: filters as FiltersOf<L>,
    query: query as ListQueryOf<L>,
  };
}

/** A change to the URL of a list: `null` removes a key. */
export type ListPatch = Record<string, string | number | null | undefined>;

/**
 * The URL of the same list with some parameters changed. Changing anything but the page goes
 * back to page 1, because the old page number means nothing in a different result set.
 */
export function listHref(pathname: string, sp: SearchParams, patch: ListPatch, key = "page"): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    const value = firstValue(v);
    if (value !== undefined && value !== "") params.set(k, value);
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === "") params.delete(k);
    else params.set(k, String(v));
  }
  if (!(key in patch)) params.delete(key);
  if (params.get(key) === "1") params.delete(key);
  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

/**
 * The URL a sortable column header links to: the same field flips direction, a new field starts
 * in its own default direction.
 */
export function sortHref<L extends ListDef>(
  pathname: string,
  sp: SearchParams,
  list: L,
  current: { sort: SortOf<L>; dir: SortDir },
  field: SortOf<L>,
): string {
  const dir: SortDir =
    current.sort === field ? (current.dir === "asc" ? "desc" : "asc") : (list.sort[field] ?? "asc");
  return listHref(pathname, sp, { sort: field, dir });
}

/** The 1-based range of rows on this page, for "x to y of n". */
export function pageRange(page: number, limit: number, count: number): { from: number; to: number } {
  const from = count === 0 ? 0 : (page - 1) * limit + 1;
  return { from, to: (page - 1) * limit + count };
}

/**
 * Whether a next page exists. With a `total` it is exact; without one (an API that does not
 * send the counter yet) a full page is taken to mean "there may be more".
 */
export function hasNextPage(page: number, limit: number, count: number, total: number | null): boolean {
  return total === null ? count >= limit : page * limit < total;
}

export const PAGE_SIZES = [25, 50, 100] as const;

/**
 * Which page numbers to show: always the first and last, the current page with one neighbour on
 * each side, and a gap marker wherever pages are skipped. Seven slots at most, so the control
 * keeps its width from page 1 to page 400.
 */
export function pageWindow(page: number, pages: number): (number | "gap")[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const out: (number | "gap")[] = [1];
  const start = Math.max(2, Math.min(page - 1, pages - 4));
  const end = Math.min(pages - 1, Math.max(page + 1, 5));
  if (start > 2) out.push("gap");
  for (let p = start; p <= end; p++) out.push(p);
  if (end < pages - 1) out.push("gap");
  out.push(pages);
  return out;
}
