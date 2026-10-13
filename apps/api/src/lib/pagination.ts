import { type ListSpec, type Page, type SortDir } from "@aidp/shared";
import type { z } from "zod";

// The contract itself (window, envelope, list specs) lives in @aidp/shared so the web app reads
// the same definitions. What stays here is Prisma-specific: take/skip, orderBy and `contains`.
export { PageQuery, listQuery, listSpec, toListResponse } from "@aidp/shared";
export type { ListSpec, Page, SortDir } from "@aidp/shared";

export function page(q: Page): { take: number; skip: number } {
  return { take: q.limit, skip: q.offset };
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
