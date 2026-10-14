import { describe, expect, it } from "vitest";
import { LISTS, sortOf, type ListDef } from "@/lib/api/lists";

/**
 * What the server hands the list toolbar crosses the React Server Component boundary, which cannot
 * carry a RegExp (a list's filters may hold one). The production build threw on /admin/audit and
 * the tenants page until the toolbar was given only the sorts.
 */
describe("sortOf", () => {
  const containsRegExp = (value: unknown): boolean =>
    value instanceof RegExp ||
    (typeof value === "object" &&
      value !== null &&
      Object.values(value as Record<string, unknown>).some(containsRegExp));

  it("is needed: some definitions would not serialize whole", () => {
    expect(Object.values(LISTS).some((l) => containsRegExp(l))).toBe(true);
  });

  it.each(Object.entries(LISTS) as [string, ListDef][])("keeps only the sorts of %s", (_name, list) => {
    const out = sortOf(list);
    expect(Object.keys(out).sort()).toEqual(["defaultSort", "sort"]);
    expect(containsRegExp(out)).toBe(false);
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });
});
