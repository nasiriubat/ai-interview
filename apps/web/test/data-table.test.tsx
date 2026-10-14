import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DataTable, useTableSelection, type DataRow } from "@/components/data/DataTable";
import { sortOf, LISTS } from "@/lib/api/lists";

let search = "";
const replace = vi.fn();
const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: (): string => "/admin/campaigns",
  useSearchParams: (): URLSearchParams => new URLSearchParams(search),
  useRouter: () => ({ replace, push: vi.fn(), refresh }),
}));

beforeEach(() => {
  search = "";
  replace.mockReset();
  refresh.mockReset();
  window.localStorage.clear();
});

const columns = [
  { id: "name", header: "Name", sortKey: "name", primary: true, locked: true },
  { id: "status", header: "Status", sortKey: "status" },
  { id: "created", header: "Created", defaultHidden: true },
];
const rows: DataRow[] = [
  { id: "a", label: "Alpha", cells: { name: "Alpha", status: "Open", created: "Oct 1" } },
  { id: "b", label: "Beta", cells: { name: "Beta", status: "Closed", created: "Oct 2" } },
];
const page = { page: 1, limit: 50, count: 2, total: 2 };
const sort = sortOf(LISTS.campaigns);

function Bulk(): React.JSX.Element {
  const s = useTableSelection();
  return <button onClick={s.clear}>Bulk on {s.ids.join(",")}</button>;
}

describe("DataTable", () => {
  it("renders rows with column headers and a row count for assistive technology", () => {
    render(<DataTable id="t" label="Campaigns" columns={columns} rows={rows} page={page} />);
    expect(screen.getByRole("columnheader", { name: "Name" })).toBeInTheDocument();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("2 rows")).toBeInTheDocument();
  });

  it("hides a default-hidden column and shows it from the column menu, remembering the choice", async () => {
    const user = userEvent.setup();
    render(<DataTable id="t" label="Campaigns" columns={columns} rows={rows} page={page} />);
    expect(screen.queryByRole("columnheader", { name: "Created" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Columns" }));
    const item = await screen.findByRole("menuitemcheckbox", { name: "Created" });
    expect(item).toHaveAttribute("aria-checked", "false");
    await user.click(item);
    // The open menu hides the page from assistive technology; close it to read the table.
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.getByRole("columnheader", { name: "Created" })).toBeInTheDocument();
    });
    expect(window.localStorage.getItem("aidp.cols.t")).toBe("[]");
  });

  it("sorts through the URL when a header is clicked, and marks the active one", async () => {
    const user = userEvent.setup();
    search = "sort=name";
    render(<DataTable id="t" label="Campaigns" columns={columns} rows={rows} page={page} sort={sort} />);
    expect(screen.getByRole("columnheader", { name: /Name/ })).toHaveAttribute("aria-sort", "ascending");
    await user.click(screen.getByRole("button", { name: "Sort by Name" }));
    expect(replace).toHaveBeenCalledWith("/admin/campaigns?sort=name&dir=desc", { scroll: false });
  });

  it("shows filters as chips that clear one at a time or all at once", async () => {
    const user = userEvent.setup();
    search = "q=ward&status=open&page=3";
    render(
      <DataTable
        id="t"
        label="Campaigns"
        columns={columns}
        rows={rows}
        page={page}
        searchLabel="Search campaigns"
        filters={[
          { type: "select", key: "status", label: "Status", options: [{ value: "open", label: "Open" }] },
        ]}
      />,
    );
    const chips = screen.getByRole("group", { name: "Active filters" });
    expect(within(chips).getByText("Status: Open")).toBeInTheDocument();
    await user.click(within(chips).getByRole("button", { name: "Remove filter: Status: Open" }));
    expect(replace).toHaveBeenLastCalledWith("/admin/campaigns?q=ward", { scroll: false });
    await user.click(within(chips).getByRole("button", { name: "Clear all filters" }));
    expect(replace).toHaveBeenLastCalledWith("/admin/campaigns", { scroll: false });
  });

  it("debounces the search into the URL and resets the page", async () => {
    const user = userEvent.setup();
    search = "page=2";
    render(
      <DataTable
        id="t"
        label="Campaigns"
        columns={columns}
        rows={rows}
        page={page}
        searchLabel="Search campaigns"
      />,
    );
    await user.type(screen.getByRole("searchbox", { name: "Search campaigns" }), "ab");
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/admin/campaigns?q=ab", { scroll: false });
    });
  });

  it("selects rows, offers bulk actions with the selection, and clears it", async () => {
    const user = userEvent.setup();
    render(
      <DataTable
        id="t"
        label="Campaigns"
        columns={columns}
        rows={rows}
        page={page}
        selectable
        bulkActions={<Bulk />}
      />,
    );
    await user.click(screen.getByRole("checkbox", { name: "Select Alpha" }));
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bulk on a" })).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Select all rows on this page" }));
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
  });

  it("says no rows match when filtered, and offers the way out", async () => {
    const user = userEvent.setup();
    search = "q=zzz";
    render(
      <DataTable
        id="t"
        label="Campaigns"
        columns={columns}
        rows={[]}
        page={{ page: 1, limit: 50, count: 0, total: 0 }}
        searchLabel="Search"
      />,
    );
    expect(screen.getByText("No results")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Clear all filters" })[0]!);
    expect(replace).toHaveBeenCalledWith("/admin/campaigns", { scroll: false });
  });

  it("shows the empty state's action when nothing exists yet", () => {
    render(
      <DataTable
        id="t"
        label="Campaigns"
        columns={columns}
        rows={[]}
        page={{ page: 1, limit: 50, count: 0, total: 0 }}
        empty={{ title: "No campaigns yet", description: "Create one.", action: <button>Create</button> }}
      />,
    );
    expect(screen.getByText("No campaigns yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create" })).toBeInTheDocument();
  });

  it("shows an error with a retry that refreshes the server data", async () => {
    const user = userEvent.setup();
    render(
      <DataTable
        id="t"
        label="Campaigns"
        columns={columns}
        rows={[]}
        error="The API did not answer."
        page={{ page: 1, limit: 50, count: 0, total: null }}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("The API did not answer.");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(refresh).toHaveBeenCalled();
  });

  it("renders a skeleton instead of rows while loading", () => {
    render(<DataTable id="t" label="Campaigns" columns={columns} rows={[]} page={page} loading />);
    expect(screen.getByRole("status", { name: "Loading rows" })).toBeInTheDocument();
  });
});
