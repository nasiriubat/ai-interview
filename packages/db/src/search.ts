/**
 * A case-insensitive "contains" filter for Prisma (D-79). `\`, `%` and `_` are escaped so they
 * match themselves: Prisma hands the value to ILIKE as it is, and a search for `50%` or `a_b`
 * must not turn into a wildcard that matches every row.
 */
export function containsInsensitive(q: string): { contains: string; mode: "insensitive" } {
  return { contains: escapeLike(q), mode: "insensitive" };
}

/** The same escaping for a JSON path filter (`string_contains`), which also compiles to ILIKE. */
export function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}
