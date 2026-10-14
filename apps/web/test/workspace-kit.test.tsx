import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { StatementView } from "@/components/admin/billing/StatementView";
import { ChartPanel } from "@/components/admin/charts/ChartPanel";
import { HeatMatrix } from "@/components/admin/charts/HeatMatrix";
import { StackedBar } from "@/components/admin/charts/StackedBar";
import { Withheld } from "@/components/admin/charts/Withheld";
import { QuoteBlock } from "@/components/admin/QuoteBlock";
import { StatementSchema } from "@/lib/api/schemas";
import { formatMonth, previousMonth } from "@/lib/format";

/*
 * The analysis workspace's own primitives (D-371, D-372): a chart is a labelled picture with its
 * numbers beside it, a withheld number says so, a quote says where it came from.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/admin",
  useSearchParams: () => new URLSearchParams(),
}));

describe("StackedBar", () => {
  it("labels the picture with its numbers and lists every part with its share, even a part of zero", () => {
    render(
      <StackedBar
        label="Opportunities by class"
        segments={[
          { key: "ai", label: "AI", value: 3, color: "var(--chart-1)" },
          { key: "process", label: "Process", value: 1, color: "var(--chart-4)" },
          { key: "none", label: "Leave as is", value: 0, color: "var(--muted-foreground)" },
        ]}
      />,
    );
    expect(screen.getByRole("img")).toHaveAccessibleName(
      "Opportunities by class: AI 3, Process 1, Leave as is 0",
    );
    const list = screen.getByRole("list", { name: "Opportunities by class" });
    expect(within(list).getByText("75 %")).toBeInTheDocument();
    expect(within(list).getByText("25 %")).toBeInTheDocument();
    expect(within(list).getByText("Leave as is")).toBeInTheDocument();
  });
});

describe("HeatMatrix", () => {
  it("is a table whose cells print their numbers, with a withheld cell that is not a zero", () => {
    render(
      <HeatMatrix
        caption="Share by department"
        corner="Department"
        columns={[
          { key: "ai", label: "AI" },
          { key: "process", label: "Process" },
        ]}
        rows={[
          {
            key: "ward",
            label: "Ward",
            detail: "6 people",
            cells: [
              { value: 0.67, display: "67%" },
              { value: null, withheld: true },
            ],
          },
        ]}
        max={1}
        withheldReason="Fewer than 3 people"
      />,
    );
    const table = screen.getByRole("table", { name: "Share by department" });
    expect(within(table).getByRole("rowheader", { name: /Ward/ })).toBeInTheDocument();
    expect(within(table).getByText("67%")).toBeInTheDocument();
    const withheld = within(table).getByText("Withheld");
    expect(withheld.closest("[data-withheld]")).not.toBeNull();
    expect(table).toHaveTextContent("Fewer than 3 people");
  });
});

describe("Withheld", () => {
  it("says what it is in words, so it is never read as zero or as a failure", () => {
    render(<Withheld reason="Fewer than 3 people answered" />);
    expect(screen.getByText("Withheld")).toBeInTheDocument();
    expect(screen.getByText(/Fewer than 3 people answered/)).toHaveClass("sr-only");
  });
});

describe("QuoteBlock", () => {
  it("is a quote with a caption that says where it came from and whether it was anonymised", () => {
    render(<QuoteBlock text="We type everything twice." source="fact f1" />);
    const figure = screen.getByRole("figure");
    expect(within(figure).getByText("We type everything twice.").tagName).toBe("BLOCKQUOTE");
    expect(figure).toHaveTextContent("Interview excerpt");
    expect(figure).toHaveTextContent("Anonymised");
    expect(figure).toHaveTextContent("fact f1");
  });
});

describe("ChartPanel", () => {
  it("offers the same numbers as a table and goes back", async () => {
    const user = userEvent.setup();
    render(
      <ChartPanel
        id="c"
        title="By class"
        chart={<div>the chart</div>}
        table={
          <table aria-label="numbers">
            <tbody>
              <tr>
                <td>3</td>
              </tr>
            </tbody>
          </table>
        }
      />,
    );
    expect(screen.getByText("the chart")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Table" }));
    expect(screen.getByRole("table", { name: "numbers" })).toBeInTheDocument();
    // The chart stays in the document for print, hidden on screen.
    expect(screen.getByText("the chart").closest(".hidden")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Table" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Chart" }));
    expect(screen.getByText("the chart")).toBeInTheDocument();
  });

  it("draws no switch for a chart that is already a table", () => {
    render(<ChartPanel id="c" title="Matrix" chart={<div>matrix</div>} />);
    expect(screen.queryByRole("button", { name: "Table" })).not.toBeInTheDocument();
  });
});

describe("StatementView", () => {
  const statement = StatementSchema.parse({
    companyId: "c1",
    month: "2026-09",
    currency: "EUR",
    lines: [
      {
        providerName: "Anthropic",
        model: "claude-sonnet",
        purpose: "interview_turn",
        calls: 640,
        inputTokens: 900,
        outputTokens: 100,
        costCents: 13500,
        estimatedCents: 0,
      },
      {
        providerName: "OpenRouter",
        model: "gpt-mini",
        purpose: "extraction",
        calls: 10,
        costCents: 2300,
        estimatedCents: 600,
      },
    ],
    totals: {
      costCents: 15800,
      estimatedCents: 600,
      calls: 650,
      byPurpose: { interview_turn: 13500, extraction: 2300 },
      byProvider: { Anthropic: 13500, OpenRouter: 2300 },
      budgets: [
        {
          scope: "campaign",
          scopeId: "camp2",
          name: "Pharmacy 2025",
          period: "total",
          limitCents: 5000,
          spentCents: 5200,
          hit: true,
        },
      ],
    },
    counts: { sessionsStarted: 24, sessionsCompleted: 19, participants: 22, storageBytes: 1024 * 1024 * 400 },
  });

  it("marks what is an estimate and what reached its limit", () => {
    render(<StatementView statement={statement} />);
    expect(screen.getByText("$6.00 estimated", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByText("includes estimate")).toBeInTheDocument();
    expect(screen.getByText("Reached")).toBeInTheDocument();
    expect(screen.getByText("19 / 24")).toBeInTheDocument();
    expect(screen.getByText("400 MB")).toBeInTheDocument();
  });
});

describe("month helpers", () => {
  it("names a month in words and finds the one that has just been frozen", () => {
    expect(formatMonth("2026-09")).toBe("September 2026");
    expect(previousMonth(new Date(Date.UTC(2026, 0, 15)))).toBe("2025-12");
    expect(previousMonth(new Date(Date.UTC(2026, 9, 1)))).toBe("2026-09");
  });
});
