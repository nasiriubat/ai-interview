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
