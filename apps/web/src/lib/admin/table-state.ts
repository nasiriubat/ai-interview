import type { ListDef, SortDir } from "@/lib/api/lists";

/*
 * The pure half of the data table (D-341): what the URL means. The component only reads and writes
 * the query string through these functions, so the rules (what a sort click does, what a chip says,
 * which parameters a change resets) are unit tested without a DOM.
 */

/** A change to the query string: a value sets it, `null` removes it. */
export type ParamChanges = Record<string, string | null>;

export type FilterDef =
  | {
      type: "select";
      /** The query parameter, e.g. `status`. */
      key: string;
      label: string;
      options: readonly { value: string; label: string }[];
    }
  | {
      type: "date-range";
      label: string;
      fromKey: string;
      toKey: string;
    };

export type SortSpec = Pick<ListDef, "sort" | "defaultSort">;

export interface ActiveSort {
  sort: string;
  dir: SortDir;
}

/** The sort in effect: the URL's when it names a sortable field, else the list's default. */
export function activeSort(params: URLSearchParams, spec: SortSpec): ActiveSort {
  const raw = params.get("sort");
  const sort = raw !== null && Object.hasOwn(spec.sort, raw) ? raw : spec.defaultSort;
  const natural: SortDir = spec.sort[sort] ?? "desc";
  const rawDir = params.get("dir");
  const dir: SortDir = rawDir === "asc" || rawDir === "desc" ? rawDir : natural;
  return { sort, dir };
}

const flip = (d: SortDir): SortDir => (d === "asc" ? "desc" : "asc");

/**
 * What clicking a column header does. A new column sorts by its natural direction (names A to Z,
 * dates newest first); clicking it again flips; a third click returns to the list's default order.
 * The URL carries `sort` and `dir` only where they differ from the defaults, so a default list has a
 * clean address.
 */
export function sortClick(params: URLSearchParams, spec: SortSpec, key: string): ParamChanges {
  if (!Object.hasOwn(spec.sort, key)) return {};
  const current = activeSort(params, spec);
  const natural: SortDir = spec.sort[key] ?? "desc";
  let next: ActiveSort;
  if (current.sort !== key) next = { sort: key, dir: natural };
  else if (current.dir === natural) next = { sort: key, dir: flip(natural) };
  else next = { sort: spec.defaultSort, dir: spec.sort[spec.defaultSort] ?? "desc" };
  const nextNatural: SortDir = spec.sort[next.sort] ?? "desc";
  return {
    sort: next.sort === spec.defaultSort ? null : next.sort,
    dir: next.dir === nextNatural ? null : next.dir,
  };
}

/** `aria-sort` for a header cell. */
export function ariaSort(
  params: URLSearchParams,
  spec: SortSpec | undefined,
  key: string | undefined,
): "ascending" | "descending" | "none" | undefined {
  if (!spec || !key || !Object.hasOwn(spec.sort, key)) return undefined;
  const current = activeSort(params, spec);
  if (current.sort !== key) return "none";
  return current.dir === "asc" ? "ascending" : "descending";
}

export interface Chip {
  /** Stable id for React keys and tests. */
  id: string;
  /** "Status: Open" */
  text: string;
  /** What removing the chip changes in the URL. */
  clear: ParamChanges;
}

/** The chips under the toolbar: one per active search, select or date range. */
export function activeChips(
  params: URLSearchParams,
  filters: readonly FilterDef[],
  searchLabel: string | undefined,
  format: { search: (q: string) => string; range: (label: string, from: string, to: string) => string },
): Chip[] {
  const chips: Chip[] = [];
  const q = params.get("q");
  if (q && searchLabel !== undefined) chips.push({ id: "q", text: format.search(q), clear: { q: null } });
  for (const f of filters) {
    if (f.type === "select") {
      const v = params.get(f.key);
      if (!v) continue;
      const option = f.options.find((o) => o.value === v);
      chips.push({ id: f.key, text: `${f.label}: ${option?.label ?? v}`, clear: { [f.key]: null } });
    } else {
      const from = params.get(f.fromKey) ?? "";
      const to = params.get(f.toKey) ?? "";
      if (!from && !to) continue;
      chips.push({
        id: `${f.fromKey}-${f.toKey}`,
        text: format.range(f.label, from, to),
        clear: { [f.fromKey]: null, [f.toKey]: null },
      });
    }
  }
  return chips;
}

/** Every parameter a "clear all" removes. Sort and page size are layout, not filters, and stay. */
export function clearAllChanges(filters: readonly FilterDef[]): ParamChanges {
  const out: ParamChanges = { q: null };
  for (const f of filters) {
    if (f.type === "select") out[f.key] = null;
    else {
      out[f.fromKey] = null;
      out[f.toKey] = null;
    }
  }
  return out;
}

/**
 * Applies changes to a query string. Any change except the page itself returns to page 1: page 4
 * of the old result says nothing about the new one.
 */
export function applyChanges(params: URLSearchParams, changes: ParamChanges): URLSearchParams {
  const next = new URLSearchParams(params.toString());
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === "") next.delete(key);
    else next.set(key, value);
  }
  if (!Object.hasOwn(changes, "page")) next.delete("page");
  return next;
}

export function hrefWith(pathname: string, params: URLSearchParams): string {
  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

/** Column ids hidden by choice, from the stored JSON; anything malformed means "defaults". */
export function parseHiddenColumns(raw: string | null, known: readonly string[]): string[] | null {
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return null;
    return v.filter((x): x is string => typeof x === "string" && known.includes(x));
  } catch {
    return null;
  }
}
