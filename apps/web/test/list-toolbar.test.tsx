import { act, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ListToolbar } from "@/components/admin/ListToolbar";
import { LISTS } from "@/lib/api/lists";

let search = "";
const replace = vi.fn<(href: string, opts?: unknown) => void>();

vi.mock("next/navigation", () => ({
  usePathname: (): string => "/admin/campaigns",
  useSearchParams: (): URLSearchParams => new URLSearchParams(search),
  useRouter: () => ({ replace, push: vi.fn() }),
}));

beforeEach(() => {
  vi.useFakeTimers();
  replace.mockReset();
  search = "";
});
afterEach(() => {
  vi.useRealTimers();
});

describe("ListToolbar", () => {
  it("writes the search to the URL after a pause and goes back to page 1", () => {
    search = "page=3&status=open";
    render(<ListToolbar searchLabel="Search campaigns" />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search campaigns" }), {
      target: { value: "  payroll " },
    });
    expect(replace).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(350);
    });
    expect(replace).toHaveBeenCalledWith("/admin/campaigns?status=open&q=payroll", { scroll: false });
  });

  it("does not navigate when the query did not change", () => {
    search = "q=payroll";
    render(<ListToolbar />);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(replace).not.toHaveBeenCalled();
  });

  it("clears the search and every filter, keeping the sort", () => {
    search = "q=pay&status=open&sort=name";
    render(
      <ListToolbar
        filters={[
          { key: "status", label: "Status", allLabel: "All", options: [{ value: "open", label: "Open" }] },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(replace).toHaveBeenCalledWith("/admin/campaigns?sort=name", { scroll: false });
  });

  it("offers no clear button while nothing is filtered", () => {
    render(<ListToolbar />);
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });

  it("flips a field's natural direction, and drops dir from the URL when back at it", () => {
    search = "sort=name";
    render(<ListToolbar sort={{ list: LISTS.campaigns, labels: { createdAt: "Created", name: "Name" } }} />);
    // Names sort A to Z by default, so the first flip is to descending.
    fireEvent.click(screen.getByRole("button", { name: "Ascending" }));
    expect(replace).toHaveBeenCalledWith("/admin/campaigns?sort=name&dir=desc", { scroll: false });
  });

  it("flips the sort direction and drops it from the URL at the default", () => {
    search = "dir=asc";
    render(<ListToolbar sort={{ list: LISTS.campaigns, labels: { createdAt: "Created", name: "Name" } }} />);
    fireEvent.click(screen.getByRole("button", { name: "Ascending" }));
    expect(replace).toHaveBeenCalledWith("/admin/campaigns", { scroll: false });
  });
});
