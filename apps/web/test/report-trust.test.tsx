import { FACTOR_KEYS } from "@aidp/shared";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OpportunityPanel } from "@/components/admin/results/OpportunityPanel";
import { OpportunityRow } from "@/components/admin/results/OpportunityRow";
import { ResultsView } from "@/components/admin/results/ResultsView";
import { ReportView } from "@/components/report/ReportView";
import { confidenceOf, parseSmallSample } from "@/lib/analysis/confidence";
import { AnalysisSchema, OpportunitySchema, ReportSchema } from "@/lib/api/schemas";

/*
 * Trust in the report (D-478): how many interviews are behind each opportunity, a calm note when
 * that is one or two, quotes that are only quotes when they were verified, and the review step
 * before a report is shared.
 */

const staff = vi.hoisted(() => ({
  analyses: { review: vi.fn(), start: vi.fn(), list: vi.fn() },
  opportunities: { setStatus: vi.fn(), override: vi.fn() },
  settings: { put: vi.fn() },
}));
const saved = vi.hoisted(() => ({ files: [] as { text: string; name: string }[] }));
const refresh = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/browser", () => ({ staffClient: staff, participantClient: {} }));
vi.mock("@/components/ui/sonner", () => ({
  toast: Object.assign(() => 1, { success: vi.fn(), error: vi.fn() }),
  Toaster: () => null,
}));
vi.mock("@/lib/exports/download", () => ({
  saveText: (text: string, name: string) => {
    saved.files.push({ text, name });
    return { filename: name };
  },
  saveFromUrl: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn(), back: vi.fn() }),
  usePathname: () => "/admin",
  useSearchParams: () => new URLSearchParams(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  saved.files.length = 0;
  staff.analyses.list.mockResolvedValue({ items: [] });
});

const factors = Object.fromEntries(FACTOR_KEYS.map((k) => [k, { score: 3, rationale: "r" }]));
const opp = (id: string, stats: object, extra: object = {}) =>
  OpportunitySchema.parse({
    id,
    title: `Opportunity ${id}`,
    solutionClass: "automation",
    factors,
    rankScore: 60,
    status: "new",
    stats: { facts: 4, ...stats },
    ...extra,
  });
const analysis = (extra: object = {}) =>
  AnalysisSchema.parse({
    id: "a1",
    version: 3,
    status: "done",
    stats: { sessions: 12, thresholdMet: true },
    ...extra,
  });

describe("confidence", () => {
  it("counts interviews, falls back to participants on older analyses, and marks a small sample", () => {
    expect(confidenceOf({ participants: 5, sessions: 4 }, 12, 2)).toEqual({
      interviews: 4,
      total: 12,
      small: false,
    });
    expect(confidenceOf({ participants: 2 }, 12, 2)).toEqual({ interviews: 2, total: 12, small: true });
    expect(parseSmallSample(3)).toBe(3);
    expect(parseSmallSample("x")).toBe(2);
  });

  it("shows 'In N of M interviews' on a row, and a calm small-sample badge only when it applies", () => {
    const { rerender } = render(
      <ul>
        <OpportunityRow
          opportunity={opp("o1", { participants: 5, sessions: 5 })}
          busy={false}
          active={false}
          onOpen={() => undefined}
          onStatus={() => undefined}
          interviewsTotal={12}
          smallSample={2}
        />
      </ul>,
    );
    expect(screen.getByText("In 5 of 12 interviews")).toBeInTheDocument();
    expect(screen.queryAllByText("Small sample")).toHaveLength(0);
    rerender(
      <ul>
        <OpportunityRow
          opportunity={opp("o2", { participants: 2, sessions: 2 })}
          busy={false}
          active={false}
          onOpen={() => undefined}
          onStatus={() => undefined}
          interviewsTotal={12}
          smallSample={2}
        />
      </ul>,
    );
    expect(screen.getByText("In 2 of 12 interviews")).toBeInTheDocument();
    expect(screen.getAllByText("Small sample").length).toBeGreaterThan(0);
  });

  it("explains a small sample in the detail panel and sets only verified quotes as quotes", () => {
    render(
      <OpportunityPanel
        opportunity={opp(
          "o3",
          { participants: 3, sessions: 2 },
          {
            evidence: [
              { factId: "f_paraphrase", snippet: "Re-keying orders (daily, 20 min)", kind: "paraphrase" },
              { factId: "f_quote", snippet: "I retype the whole order sheet", kind: "quote" },
            ],
          },
        )}
        open
        onOpenChange={() => undefined}
        busy={false}
        canPromote={false}
        k={3}
        onStatus={() => undefined}
        onEdit={() => undefined}
        onPromote={() => undefined}
        interviewsTotal={12}
        smallSample={2}
      />,
    );
    const panel = screen.getByTestId("opportunity-panel");
    expect(within(panel).getAllByText("Mentioned in 2 of 12 interviews").length).toBeGreaterThan(0);
    expect(within(panel).getByTestId("small-sample")).toHaveTextContent("This rests on 2 interviews");
    const quotes = panel.querySelectorAll("blockquote");
    expect([...quotes].map((q) => q.textContent)).toEqual(["I retype the whole order sheet"]);
    expect(within(panel).getByText("Re-keying orders (daily, 20 min)").tagName).toBe("P");
    expect(within(panel).getByText("Summary, not a quote")).toBeInTheDocument();
  });
});

describe("evidence checks on the results page", () => {
  it("says how many quotes were left out, and the threshold when the sample is small", () => {
    render(
      <ResultsView
        campaignId="c1"
        analyses={[
          analysis({
            preliminary: true,
            stats: {
              sessions: 4,
              thresholdMet: false,
              needed: 10,
              verification: {
                quotesChecked: 9,
                quotesVerified: 7,
                quotesDropped: 2,
                figuresChecked: 5,
                figuresRemoved: 1,
              },
            },
          }),
        ]}
        selectedId="a1"
        detail={null}
        initialPreset="balanced"
        initialWeights={Object.fromEntries(FACTOR_KEYS.map((k) => [k, 1])) as never}
      />,
    );
    expect(screen.getByTestId("evidence-checks")).toHaveTextContent(
      "2 quotes could not be verified against the interviews and were left out.",
    );
    expect(screen.getByTestId("evidence-checks")).toHaveTextContent("1 sentence with a figure");
    expect(screen.getByText(/Based on 4 completed interviews; the campaign aims for 10/)).toBeInTheDocument();
  });
});

describe("review before sharing", () => {
  const report = (review: object) =>
    ReportSchema.parse({ id: "r1", analysisId: "a1", version: 3, markdown: "# Report\n\nBody", review });

  it("offers one primary action to an administrator, marks the paper as a draft, and downloads with the status", async () => {
    staff.analyses.review.mockResolvedValue({
      status: "reviewed",
      reviewedBy: "Anna Admin",
      reviewedAt: "2026-10-21T10:00:00.000Z",
    });
    const user = userEvent.setup();
    render(
      <ReportView
        campaignId="c1"
        campaignName="Ward"
        analyses={[analysis()]}
        selected={analysis()}
        report={report({ status: "draft", reviewedBy: null, reviewedAt: null })}
        initialSections={[]}
        canReview
      />,
    );
    expect(screen.getByTestId("report-banner")).toHaveTextContent("Draft – not yet reviewed");
    const mark = screen.getByRole("button", { name: /Mark as reviewed/ });
    // While a review is due, exporting is not the primary action.
    expect(screen.getByRole("button", { name: /Export/ }).className).not.toMatch(/bg-primary/);
    expect(mark.className).toMatch(/bg-primary/);

    await user.click(screen.getByRole("button", { name: /Export/ }));
    await user.click(await screen.findByRole("menuitem", { name: /Markdown/ }));
    expect(saved.files[0]?.text.startsWith("> **Draft – not yet reviewed.**")).toBe(true);

    await user.click(mark);
    expect(staff.analyses.review).toHaveBeenCalledWith("a1", "reviewed");
    await waitFor(() => {
      expect(screen.getByTestId("report-banner")).toHaveTextContent("Reviewed by Anna Admin");
    });
    expect(screen.queryByRole("button", { name: /Mark as reviewed/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Return to draft/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Export/ }));
    await user.click(await screen.findByRole("menuitem", { name: /Markdown/ }));
    expect(saved.files[1]?.text.startsWith("> **Reviewed by Anna Admin on 2026-10-21.**")).toBe(true);
  });

  it("shows a member the state without the action", () => {
    render(
      <ReportView
        campaignId="c1"
        campaignName="Ward"
        analyses={[analysis()]}
        selected={analysis()}
        report={report({ status: "draft", reviewedBy: null, reviewedAt: null })}
        initialSections={[]}
      />,
    );
    expect(screen.getByTestId("report-review")).toHaveTextContent(
      "An administrator has not reviewed this report yet",
    );
    expect(screen.queryByRole("button", { name: /Mark as reviewed/ })).not.toBeInTheDocument();
  });
});
