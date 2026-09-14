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
