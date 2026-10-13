import { render, screen } from "@testing-library/react";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Pagination } from "@/components/admin/Pagination";
import { hasNextPage, pageParams, pageRange, pageWindow } from "@/lib/admin/pagination";

let search = "";

vi.mock("next/navigation", () => ({
  usePathname: (): string => "/admin/audit",
  useSearchParams: (): URLSearchParams => new URLSearchParams(search),
  useRouter: () => ({ push: vi.fn() }),
}));

beforeEach(() => {
  search = "";
});

function href(name: string): string | null {
  return screen.getByRole("link", { name }).getAttribute("href");
}

describe("pageParams", () => {
  it("defaults to the first page and a 50-row limit", () => {
    expect(pageParams({})).toEqual({ page: 1, limit: 50, offset: 0 });
  });

  it("reads the page from the URL and turns it into an offset", () => {
    expect(pageParams({ page: "3" })).toEqual({ page: 3, limit: 50, offset: 100 });
  });

  it("clamps nonsense and caps the limit at the contract maximum", () => {
    expect(pageParams({ page: "0" }).page).toBe(1);
    expect(pageParams({ page: "-2" }).page).toBe(1);
    expect(pageParams({ page: "abc" }).page).toBe(1);
    expect(pageParams({ limit: "1000" }).limit).toBe(200);
    expect(pageParams({ page: ["2", "9"] }).page).toBe(2);
  });
});

describe("pageRange and hasNextPage", () => {
  it("numbers the rows of the current page", () => {
    expect(pageRange(1, 50, 50)).toEqual({ from: 1, to: 50 });
    expect(pageRange(3, 50, 7)).toEqual({ from: 101, to: 107 });
    expect(pageRange(1, 50, 0)).toEqual({ from: 0, to: 0 });
  });

  it("uses the total when there is one and a full page when there is not", () => {
    expect(hasNextPage(1, 50, 50, 120)).toBe(true);
    expect(hasNextPage(3, 50, 20, 120)).toBe(false);
    expect(hasNextPage(1, 50, 50, null)).toBe(true);
    expect(hasNextPage(1, 50, 12, null)).toBe(false);
  });
});

describe("Pagination", () => {
  it("renders x to y of n and links to the next page", () => {
    render(<Pagination page={1} limit={50} count={50} total={120} />);
    expect(screen.getByRole("navigation", { name: "Pagination" })).toBeInTheDocument();
    expect(screen.getByText("1 to 50 of 120")).toBeInTheDocument();
    expect(href("Next")).toBe("/admin/audit?page=2");
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
  });

  it("keeps the other query parameters and drops page=1 on the way back", () => {
    search = "from=2026-01-01&page=2";
    render(<Pagination page={2} limit={50} count={50} total={120} />);
    expect(href("Previous")).toBe("/admin/audit?from=2026-01-01");
    expect(href("Next")).toBe("/admin/audit?from=2026-01-01&page=3");
  });

  it("disables next on the last page", () => {
    search = "page=3";
    render(<Pagination page={3} limit={50} count={20} total={120} />);
    expect(screen.getByText("101 to 120 of 120")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(href("Previous")).toBe("/admin/audit?page=2");
  });

  it("hides the count and keeps next while a full page comes back without a total", () => {
    render(<Pagination page={1} limit={50} count={50} total={null} />);
    expect(screen.getByText("1 to 50")).toBeInTheDocument();
    expect(screen.queryByText(/of/)).not.toBeInTheDocument();
    expect(href("Next")).toBe("/admin/audit?page=2");
  });

  it("renders nothing when a single short page is all there is", () => {
    const { container } = render(<Pagination page={1} limit={50} count={12} total={12} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("pageWindow", () => {
  it("lists every page when there are few", () => {
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("keeps first, last and the neighbourhood of the current page, with gaps", () => {
    expect(pageWindow(1, 20)).toEqual([1, 2, 3, 4, 5, "gap", 20]);
    expect(pageWindow(10, 20)).toEqual([1, "gap", 9, 10, 11, "gap", 20]);
    expect(pageWindow(20, 20)).toEqual([1, "gap", 16, 17, 18, 19, 20]);
  });

  it("never exceeds seven slots", () => {
    for (let p = 1; p <= 50; p++) expect(pageWindow(p, 50).length).toBeLessThanOrEqual(7);
  });
});

describe("Pagination page numbers", () => {
  it("links each page by its accessible name and marks the current one", () => {
    search = "page=2";
    render(<Pagination page={2} limit={50} count={50} total={120} />);
    expect(href("Page 3")).toBe("/admin/audit?page=3");
    expect(screen.getByRole("link", { name: "Page 2" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByLabelText("Rows per page")).toHaveValue("50");
  });
});
