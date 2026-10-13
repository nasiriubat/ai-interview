import { z } from "zod";

/**
 * Every staff list that can grow without bound takes the same window (contract 19) and answers
 * with `{ <list>, total, limit, offset }`, keeping the list key it already had.
 */
export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type Page = z.infer<typeof PageQuery>;

export function page(q: Page): { take: number; skip: number } {
  return { take: q.limit, skip: q.offset };
}

export type SortDir = "asc" | "desc";

/**
 * How one staff list searches, sorts and filters (D-79, contract 19).
 *
 * - `sort` maps every sortable field to the direction it takes when the caller names the field
 *   without a `dir`. Only these keys are accepted: anything else is a 400 at the schema, so no
 *   caller-supplied string ever reaches a Prisma `orderBy`.
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

/** The query schema for one list: the page window, `q`, `sort`, `dir` and the list's own filters. */
type ListShape<S extends string, F extends z.ZodRawShape> = typeof PageQuery.shape & {
  q: typeof Search;
  sort: z.ZodDefault<z.ZodEnum<{ [K in S]: K }>>;
  dir: z.ZodOptional<z.ZodEnum<{ asc: "asc"; desc: "desc" }>>;
} & F;

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

export interface ListRequest<S extends string> {
  q?: string | undefined;
  sort: S;
  dir?: SortDir | undefined;
}

/** The search term, or undefined when the caller sent none or only whitespace. */
export function searchTerm(q: string | undefined): string | undefined {
  return q === "" ? undefined : q;
}

/**
 * The Prisma `orderBy` for a request: the chosen column, then `id` in the same direction so rows
 * with equal keys keep one order from page to page. `O` is the model's order input type.
 */
export function listOrder<O, S extends string>(spec: ListSpec<S, z.ZodRawShape>, req: ListRequest<S>): O[] {
  const dir = req.dir ?? spec.sort[req.sort];
  const column = spec.columns?.[req.sort] ?? req.sort;
  const key = spec.nullable?.includes(req.sort) ? { sort: dir, nulls: "last" } : dir;
  return (column === "id" ? [{ id: dir }] : [{ [column]: key }, { id: dir }]) as O[];
}

/** Case-insensitive "contains" with LIKE wildcards escaped; see `@aidp/db`. */
export { containsInsensitive as contains, escapeLike } from "@aidp/db";
