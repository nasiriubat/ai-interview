import { z } from "zod";

/**
 * The list contract (contract 19), shared so the API that serves a list and the web app that
 * reads one cannot drift. Prisma-specific pieces (`take`/`skip`, `orderBy`, `contains`) stay in
 * the API; nothing here knows about a database.
 *
 * Every staff list that can grow without bound takes the same window and answers with
 * `{ <list>, total, limit, offset }`, keeping the list key it already had.
 */

export const PAGE_LIMIT_MAX = 200;
export const PAGE_LIMIT_DEFAULT = 50;

export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
  offset: z.coerce.number().int().min(0).default(0),
});

/** A resolved window: what a handler holds after the query is parsed. */
export type Page = z.infer<typeof PageQuery>;

/**
 * What a caller may send: either field can be left out. Spelled out because the schema coerces,
 * so its inferred input type is `unknown`; a client should send numbers.
 */
export interface PageInput {
  limit?: number;
  offset?: number;
}

export type SortDir = "asc" | "desc";

/**
 * How one staff list searches, sorts and filters (D-79, contract 19).
 *
 * - `sort` maps every sortable field to the direction it takes when the caller names the field
 *   without a `dir`. Only these keys are accepted: anything else is a 400 at the schema, so no
 *   caller-supplied string ever reaches a database `orderBy`.
 * - `columns` renames a public sort key to the column behind it (`lastActivity` is `updatedAt`).
 * - `nullable` columns sort their nulls last in both directions, so "newest first" does not open
 *   on a page of sessions that never started.
 * - `filters` are the list's own query fields; keep them closed (enums, ids, dates) so an unknown
 *   value is a 400 rather than an empty page that reads as "nothing matched".
 */
export interface ListSpec<S extends string, F extends z.ZodRawShape> {
  sort: Record<S, SortDir>;
  defaultSort: NoInfer<S>;
  columns?: Partial<Record<NoInfer<S>, string>>;
  nullable?: readonly NoInfer<S>[];
  filters: F;
}

/** Declares a list; the identity function exists so the spec's types are inferred once. */
export function listSpec<S extends string, F extends z.ZodRawShape>(spec: ListSpec<S, F>): ListSpec<S, F> {
  return spec;
}

/** `q`: trimmed, at most 200 characters, matched case-insensitively as a substring. */
const Search = z.string().trim().max(200).optional();

type ListShape<S extends string, F extends z.ZodRawShape> = typeof PageQuery.shape & {
  q: typeof Search;
  sort: z.ZodDefault<z.ZodEnum<{ [K in S]: K }>>;
  dir: z.ZodOptional<z.ZodEnum<{ asc: "asc"; desc: "desc" }>>;
} & F;

/** The query schema for one list: the page window, `q`, `sort`, `dir` and the list's own filters. */
export function listQuery<S extends string, F extends z.ZodRawShape>(
  spec: ListSpec<S, F>,
): z.ZodObject<ListShape<S, F>> {
  const fields = Object.keys(spec.sort) as [S, ...S[]];
  const shape = {
    ...PageQuery.shape,
    q: Search,
    sort: z.enum(fields).default(spec.defaultSort as never),
    dir: z.enum(["asc", "desc"]).optional(),
    ...spec.filters,
  } as ListShape<S, F>;
  return z.object(shape);
}

/**
 * The envelope of one list: its rows under their own key, then the counters. The key is part of
 * the contract (`users`, `campaigns`, `audit`), which is why it is a parameter and not `items`.
 */
export type ListEnvelope<K extends string, T> = Record<K, T[]> & {
  total: number;
  limit: number;
  offset: number;
};

type EnvelopeShape<K extends string, T extends z.ZodType> = Record<K, z.ZodArray<T>> & {
  total: z.ZodNumber;
  limit: z.ZodNumber;
  offset: z.ZodNumber;
};

export function listEnvelope<K extends string, T extends z.ZodType>(
  key: K,
  item: T,
): z.ZodObject<EnvelopeShape<K, T>> {
  const shape = {
    [key]: z.array(item),
    total: z.number().int().min(0),
    limit: z.number().int().min(1),
    offset: z.number().int().min(0),
  } as EnvelopeShape<K, T>;
  return z.object(shape);
}

/** Builds the response of a list from its rows, the total and the window the caller asked for. */
export function toListResponse<K extends string, T>(
  key: K,
  rows: T[],
  total: number,
  page: Page,
): ListEnvelope<K, T> {
  return { [key]: rows, total, limit: page.limit, offset: page.offset } as ListEnvelope<K, T>;
}
