import { describe, expect, it } from "vitest";
import { matchesQuery } from "@/components/admin/shell/nav";
import { previewEmailList, issuesCsv } from "@/lib/admin/importPreview";
import {
  activeChips,
  activeSort,
  applyChanges,
  ariaSort,
  clearAllChanges,
  hrefWith,
  parseHiddenColumns,
  sortClick,
  type FilterDef,
} from "@/lib/admin/table-state";
import { LISTS, sortOf } from "@/lib/api/lists";

const spec = sortOf(LISTS.campaigns); // createdAt desc (default), name asc, status asc
const p = (q: string): URLSearchParams => new URLSearchParams(q);

describe("sorting from the URL", () => {
  it("reads the default and a valid choice, and ignores a field the list does not sort by", () => {
    expect(activeSort(p(""), spec)).toEqual({ sort: "createdAt", dir: "desc" });
    expect(activeSort(p("sort=name"), spec)).toEqual({ sort: "name", dir: "asc" });
    expect(activeSort(p("sort=name&dir=desc"), spec)).toEqual({ sort: "name", dir: "desc" });
    expect(activeSort(p("sort=password"), spec).sort).toBe("createdAt");
  });

  it("a header click cycles natural, reversed, then back to the default", () => {
    expect(sortClick(p(""), spec, "name")).toEqual({ sort: "name", dir: null });
    expect(sortClick(p("sort=name"), spec, "name")).toEqual({ sort: "name", dir: "desc" });
    expect(sortClick(p("sort=name&dir=desc"), spec, "name")).toEqual({ sort: null, dir: null });
  });

  it("the default column flips and flips back without leaving the clean address", () => {
    expect(sortClick(p(""), spec, "createdAt")).toEqual({ sort: null, dir: "asc" });
    expect(sortClick(p("dir=asc"), spec, "createdAt")).toEqual({ sort: null, dir: null });
  });

  it("refuses to sort by a field the list does not know", () => {
    expect(sortClick(p(""), spec, "secret")).toEqual({});
  });

  it("names aria-sort for the active column only", () => {
    expect(ariaSort(p("sort=name"), spec, "name")).toBe("ascending");
    expect(ariaSort(p("sort=name&dir=desc"), spec, "name")).toBe("descending");
    expect(ariaSort(p("sort=name"), spec, "status")).toBe("none");
    expect(ariaSort(p(""), spec, "invited")).toBeUndefined();
  });
});

describe("filters and chips", () => {
  const filters: FilterDef[] = [
    { type: "select", key: "status", label: "Status", options: [{ value: "open", label: "Open" }] },
    { type: "date-range", label: "Dates", fromKey: "from", toKey: "to" },
  ];
  const format = {
    search: (q: string) => `“${q}”`,
    range: (l: string, a: string, b: string) => `${l}: ${a || "…"} – ${b || "…"}`,
  };

  it("makes one chip per active control, with what clears it", () => {
    const chips = activeChips(p("q=ward&status=open&from=2026-10-01"), filters, "Search", format);
    expect(chips.map((c) => c.text)).toEqual(["“ward”", "Status: Open", "Dates: 2026-10-01 – …"]);
    expect(chips[2]?.clear).toEqual({ from: null, to: null });
  });

  it("says a value it has no label for as it is", () => {
    expect(activeChips(p("status=weird"), filters, undefined, format)[0]?.text).toBe("Status: weird");
  });

  it("clear all removes search and filters and leaves sort and size", () => {
    const next = applyChanges(p("q=a&status=open&sort=name&limit=25&page=3"), clearAllChanges(filters));
    expect(next.toString()).toBe("sort=name&limit=25");
  });
});

describe("applying changes", () => {
  it("returns to the first page on any change except the page itself", () => {
    expect(applyChanges(p("page=4&status=open"), { status: "closed" }).toString()).toBe("status=closed");
    expect(applyChanges(p("page=4"), { page: "5" }).toString()).toBe("page=5");
  });

  it("builds a clean href", () => {
    expect(hrefWith("/admin/users", p(""))).toBe("/admin/users");
    expect(hrefWith("/admin/users", p("q=a"))).toBe("/admin/users?q=a");
  });
});

describe("remembered columns", () => {
  it("keeps only known ids and falls back on junk", () => {
    expect(parseHiddenColumns('["a","zzz"]', ["a", "b"])).toEqual(["a"]);
    expect(parseHiddenColumns("{", ["a"])).toBeNull();
    expect(parseHiddenColumns(null, ["a"])).toBeNull();
    expect(parseHiddenColumns('"a"', ["a"])).toBeNull();
  });
});

describe("palette matching", () => {
  it("matches each typed word against the start of a word of the label", () => {
    expect(matchesQuery("Model assignment", "mod ass")).toBe(true);
    expect(matchesQuery("Audit log", "log")).toBe(true);
    expect(matchesQuery("Audit log", "udit")).toBe(false);
    expect(matchesQuery("Anything", "")).toBe(true);
  });
});

describe("import preview", () => {
  it("separates ready rows from invalid and repeated ones, with line numbers", () => {
    const out = previewEmailList("email\nAda@X.test, bad\nada@x.test\n\nben@x.test;kim@x.test");
    expect(out.valid).toEqual(["ada@x.test", "ben@x.test", "kim@x.test"]);
    expect(out.issues).toEqual([
      { line: 2, value: "bad", reason: "invalid" },
      { line: 3, value: "ada@x.test", reason: "duplicate" },
    ]);
  });

  it("writes the error report as CSV with quoting", () => {
    expect(issuesCsv([{ line: 4, value: 'a"b', reason: "invalid" }])).toBe(
      'line,value,problem\r\n4,"a""b",invalid\r\n',
    );
  });
});
