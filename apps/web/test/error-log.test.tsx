import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as f from "../e2e/fixtures";
import { ErrorActions, OccurrenceList, occurrenceText } from "@/components/admin/operator/ErrorDetail";
import { ErrorsCard } from "@/components/admin/operator/ErrorsCard";
import { ErrorsPanel } from "@/components/admin/operator/ErrorsPanel";
import { navFor } from "@/components/admin/shell/nav";
import { SideNav } from "@/components/admin/shell/Sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { sortOf, LISTS } from "@/lib/api/lists";
import { ErrorGroupDetailSchema, ErrorGroupPageSchema, ErrorSummarySchema } from "@/lib/api/schemas";

/*
 * The error log's pages (D-477): the list in each of its states, a group's verbs, the occurrence a
 * person copies into a bug report, the health card and the sidebar badge.
 */

const resolve = vi.fn<(id: string) => Promise<unknown>>();
const remove = vi.fn<(id: string) => Promise<void>>();
const refresh = vi.fn();
const push = vi.fn();

vi.mock("@/lib/api/browser", () => ({
  staffClient: {
    operator: {
      errors: {
        resolve: (id: string): Promise<unknown> => resolve(id),
        remove: (id: string): Promise<void> => remove(id),
      },
    },
  },
  participantClient: {},
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push, back: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/admin/operator/errors",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}));

const groups = ErrorGroupPageSchema.parse({ groups: f.errorGroups, total: 4, limit: 50, offset: 0 }).items;
const page = (n: number) => ({ page: 1, limit: 50, count: n, total: n });

beforeEach(() => {
  resolve.mockReset().mockResolvedValue(groups[0]);
  remove.mockReset().mockResolvedValue(undefined);
  refresh.mockReset();
  push.mockReset();
});

describe("the fixtures are what the API answers", () => {
  it("parses the list, a group and the summary", () => {
    expect(groups).toHaveLength(4);
    const detail = ErrorGroupDetailSchema.parse({
      group: f.errorGroups[0],
      occurrences: f.errorOccurrences,
      elsewhere: 2,
    });
    expect(detail.occurrences[0]?.stack).toContain("TurnRunner");
    expect(ErrorSummarySchema.parse(f.errorSummary).open24h).toBe(2);
  });
});

describe("the error list", () => {
  it("shows each group with its source, where, tenant, count and status", () => {
    render(
      <ErrorsPanel
        groups={groups}
        page={page(groups.length)}
        filters={[]}
        sort={sortOf(LISTS.errors)}
        nothingThisWeek={false}
      />,
    );
    const link = screen.getAllByRole("link", {
      name: "Cannot read properties of undefined (reading 'coverage')",
    });
    expect(link[0]).toHaveAttribute("href", "/admin/operator/errors/eg1");
    expect(screen.getAllByText("ProviderError · analysis.run").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Platform").length).toBeGreaterThan(0);
    expect(screen.getAllByText("12 in 24 h").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Resolved").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Worker").length).toBeGreaterThan(0);
  });

  it("says there were no errors this week when nothing was recorded at all", () => {
    render(
      <ErrorsPanel groups={[]} page={page(0)} filters={[]} sort={sortOf(LISTS.errors)} nothingThisWeek />,
    );
    expect(screen.getByText("No errors in the last 7 days")).toBeInTheDocument();
  });

  it("says nothing is open when errors were seen but all are resolved", () => {
    render(
      <ErrorsPanel
        groups={[]}
        page={page(0)}
        filters={[]}
        sort={sortOf(LISTS.errors)}
        nothingThisWeek={false}
      />,
    );
    expect(screen.getByText("No open errors in the last 7 days")).toBeInTheDocument();
  });

  it("shows a load failure instead of an empty list", () => {
    render(
      <ErrorsPanel
        groups={[]}
        page={page(0)}
        filters={[]}
        sort={sortOf(LISTS.errors)}
        nothingThisWeek={false}
        error="The API is unreachable"
      />,
    );
    expect(screen.getByText("The API is unreachable")).toBeInTheDocument();
    expect(screen.queryByText("No open errors in the last 7 days")).not.toBeInTheDocument();
  });
});

describe("one group", () => {
  const open = groups[0]!;

  it("marks an open group resolved and refreshes", async () => {
    render(<ErrorActions group={open} />);
    await userEvent.click(screen.getByRole("button", { name: "Mark resolved" }));
    await waitFor(() => {
      expect(resolve).toHaveBeenCalledWith("eg1");
    });
    expect(refresh).toHaveBeenCalled();
  });

  it("offers no resolve for a resolved group, and deletes only after confirming", async () => {
    render(<ErrorActions group={{ id: "eg4", status: "resolved" }} />);
    expect(screen.queryByRole("button", { name: "Mark resolved" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Delete group" }));
    expect(remove).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      Array.from(dialog.querySelectorAll("button")).find(
        (b) => b.textContent === "Delete group",
      ) as HTMLElement,
    );
    await waitFor(() => {
      expect(remove).toHaveBeenCalledWith("eg4");
    });
    expect(push).toHaveBeenCalledWith("/admin/operator/errors");
  });

  it("lists occurrences with their ids and a collapsible stack, and copies the details", () => {
    const occurrences = ErrorGroupDetailSchema.parse({
      group: f.errorGroups[0],
      occurrences: f.errorOccurrences,
    }).occurrences;
    render(<OccurrenceList group={open} occurrences={occurrences} tenantName="Acme Care" />);
    expect(screen.getByText("req-7f3a2c")).toBeInTheDocument();
    expect(screen.getAllByText("Stack trace")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Copy details" })).toHaveLength(2);
    const text = occurrenceText(open, occurrences[0]!);
    expect(text).toContain("request: POST /api/v1/p/session/turns 500");
    expect(text).toContain("request id: req-7f3a2c");
    expect(text).toContain("at TurnRunner.nextQuestion");
  });

  it("says when no occurrence is stored", () => {
    render(<OccurrenceList group={open} occurrences={[]} tenantName={null} />);
    expect(screen.getByText(/No occurrence is stored for this group yet/)).toBeInTheDocument();
  });
});

describe("the health card and the sidebar badge", () => {
  it("shows the day's and the week's counts and links to the list", () => {
    render(<ErrorsCard summary={{ open24h: 2, last24h: 16, last7d: 44, groups7d: 3 }} />);
    expect(screen.getByText("16")).toBeInTheDocument();
    expect(screen.getByText("44")).toBeInTheDocument();
    expect(screen.getByText("2 open in the last 24 hours")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View errors/ })).toHaveAttribute(
      "href",
      "/admin/operator/errors",
    );
  });

  it("puts Errors under Platform for the operator only, with the open count in its name", () => {
    expect(
      navFor("admin", { openErrors: 3 })
        .flatMap((g) => g.items)
        .some((i) => i.href.includes("errors")),
    ).toBe(false);
    render(
      <TooltipProvider>
        <SideNav groups={navFor("platform_operator", { openErrors: 3 })} pathname="/admin" />
      </TooltipProvider>,
    );
    const link = screen.getByRole("link", { name: "Errors, 3 open" });
    expect(link).toHaveAttribute("href", "/admin/operator/errors");
    expect(link.querySelector("[data-nav-badge]")?.textContent).toBe("3");
  });

  it("draws no badge when nothing is open", () => {
    render(
      <TooltipProvider>
        <SideNav groups={navFor("platform_operator", { openErrors: 0 })} pathname="/admin" />
      </TooltipProvider>,
    );
    const link = screen.getByRole("link", { name: "Errors" });
    expect(link.querySelector("[data-nav-badge]")).toBeNull();
  });

  it("keeps a dot on the collapsed rail", () => {
    render(
      <TooltipProvider>
        <SideNav groups={navFor("platform_operator", { openErrors: 120 })} pathname="/admin" collapsed />
      </TooltipProvider>,
    );
    const link = screen.getByRole("link", { name: "Errors, 120 open" });
    expect(link.querySelector("[data-nav-badge]")).not.toBeNull();
  });
});
