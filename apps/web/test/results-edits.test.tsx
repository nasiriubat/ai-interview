import { FACTOR_KEYS, type DepartmentComparison } from "@aidp/shared";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DepartmentsPanel } from "@/components/admin/results/DepartmentsPanel";
import { FactorBars } from "@/components/admin/results/FactorBars";
import { MergeBar } from "@/components/admin/results/MergeBar";
import { ResultsView } from "@/components/admin/results/ResultsView";
import { SplitDialog } from "@/components/admin/results/SplitDialog";
import { editErrorText } from "@/lib/analysis/edit-errors";
import { ApiError } from "@/lib/api/errors";
import { AnalysisSchema, OpportunitySchema } from "@/lib/api/schemas";

/*
 * Cluster merge, split and rename, the "AI is not the answer" section, the department comparison
 * (FR-16a, FR-17, FR-18) and the keyboard-reachable factor rationale, as a person meets them.
 */

const staff = vi.hoisted(() => ({
  analyses: {
    start: vi.fn(),
    list: vi.fn(),
    merge: vi.fn(),
    undoClusterEdit: vi.fn(),
    clusterEdits: vi.fn(),
  },
  opportunities: { setStatus: vi.fn(), override: vi.fn(), splitProposal: vi.fn(), split: vi.fn() },
  settings: { put: vi.fn() },
}));
const toasts = vi.hoisted(() => {
  const calls: { text: string; options: { action?: { label: string; onClick: () => void } } }[] = [];
  const toast = Object.assign(
    (text: string, options: (typeof calls)[number]["options"] = {}): number => {
      calls.push({ text, options });
      return calls.length;
    },
    { success: vi.fn(), error: vi.fn() },
  );
  return { calls, toast };
});
const refresh = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/browser", () => ({ staffClient: staff, participantClient: {} }));
vi.mock("@/components/ui/sonner", () => ({ toast: toasts.toast, Toaster: () => null }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn(), back: vi.fn() }),
  usePathname: () => "/admin",
  useSearchParams: () => new URLSearchParams(),
}));

beforeEach(() => {
  toasts.calls.length = 0;
  vi.resetAllMocks();
  staff.analyses.list.mockResolvedValue({ items: [] });
});

// The page ranks from the factors, so a higher `rankScore` here is a higher factor score too.
const factorsFor = (rankScore: number) =>
  Object.fromEntries(
    FACTOR_KEYS.map((k) => [
      k,
      { score: Math.max(1, Math.min(5, Math.round(rankScore / 20))), rationale: `Because ${k}` },
    ]),
  );
const opp = (id: string, title: string, solutionClass: string, rankScore: number, extra = {}) =>
  OpportunitySchema.parse({
    id,
    title,
    solutionClass,
    factors: factorsFor(rankScore),
    rankScore,
    status: "new",
    stats: { participants: 5, facts: 9 },
    ...extra,
  });
const done = (id: string, version: number) =>
  AnalysisSchema.parse({ id, version, status: "done", stats: { thresholdMet: true } });

const OPPS = [
  opp("o1", "Single entry of notes", "automation", 80),
  opp("o2", "Chart in one system", "software", 60),
  opp("o3", "Night shift rota", "process", 50, { whyNotAi: "A staffing decision, not a data problem." }),
  opp("o4", "Leave the lab call", "none", 40, { whyNotAi: "It works." }),
];

function renderResults(
  over: Partial<React.ComponentProps<typeof ResultsView>> = {},
  analyses = [done("a2", 2)],
): void {
  render(
    <ResultsView
      campaignId="c1"
      analyses={analyses}
      selectedId={analyses[0]?.id}
      detail={{ analysis: analyses[0]!, opportunities: OPPS, report: null }}
      initialPreset="balanced"
      initialWeights={{} as never}
      canEdit
      {...over}
    />,
  );
}

describe("where AI is not the answer", () => {
  it("is one named section at the end, built with the report's predicate, reason first", () => {
    renderResults();
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings.at(-1)).toContain("Where AI is not the answer");
    const section = screen.getByRole("region", { name: /Where AI is not the answer/ });
    // Both `process` and `none` belong to it; neither is also shown as a class group.
    expect(within(section).getByText("Night shift rota")).toBeInTheDocument();
    expect(within(section).getByText("Leave the lab call")).toBeInTheDocument();
    expect(within(section).getByText("A staffing decision, not a data problem.")).toBeVisible();
    expect(screen.queryByRole("heading", { name: /^Process/ })).not.toBeInTheDocument();
    expect(screen.getAllByText("Night shift rota")).toHaveLength(1);
  });
});

describe("merge", () => {
  it("is not offered to a member, or on a version that is not the newest", () => {
    renderResults({ canEdit: false });
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Split" })).not.toBeInTheDocument();
  });

  it("needs two, asks first with the highest ranked title, sends fact-anchored ids and offers Undo", async () => {
    staff.analyses.merge.mockResolvedValue({ analysis: done("a3", 3), editId: "e1" });
    staff.analyses.undoClusterEdit.mockResolvedValue({ analysis: done("a4", 4) });
    const user = userEvent.setup();
    renderResults();
    expect(screen.queryByRole("region", { name: "Merge opportunities" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Select “Single entry of notes” to merge" }));
    const bar = screen.getByRole("region", { name: "Merge opportunities" });
    expect(within(bar).getByText("Select at least two opportunities to merge them.")).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: "Merge 1 selected" })).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: "Select “Chart in one system” to merge" }));
    await user.click(within(bar).getByRole("button", { name: "Merge 2 selected" }));
    const dialog = screen.getByRole("alertdialog");
    expect(staff.analyses.merge).not.toHaveBeenCalled();
    const title = within(dialog).getByLabelText("Title of the merged opportunity");
    expect(title).toHaveValue("Single entry of notes");
    await user.clear(title);
    await user.type(title, "One place for notes");
    await user.click(within(dialog).getByRole("button", { name: "Merge" }));

    await waitFor(() => {
      expect(staff.analyses.merge).toHaveBeenCalledWith("a2", {
        opportunityIds: ["o1", "o2"],
        title: "One place for notes",
      });
    });
    await waitFor(() => {
      expect(toasts.calls.at(-1)?.text).toBe("Merged into “One place for notes”.");
    });
    expect(refresh).toHaveBeenCalled();
    await act(async () => {
      toasts.calls.at(-1)?.options.action?.onClick();
      await Promise.resolve();
    });
    expect(staff.analyses.undoClusterEdit).toHaveBeenCalledWith("c1", "e1");
  });

  it("says why when the API refuses: an analysis from before editing existed", async () => {
    staff.analyses.merge.mockRejectedValue(
      new ApiError(409, "conflict", "Run the analysis again to enable editing", { reason: "rerun_required" }),
    );
    const user = userEvent.setup();
    renderResults();
    await user.click(screen.getByRole("checkbox", { name: "Select “Single entry of notes” to merge" }));
    await user.click(screen.getByRole("checkbox", { name: "Select “Chart in one system” to merge" }));
    await user.click(screen.getByRole("button", { name: "Merge 2 selected" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Merge" }));
    expect(
      await screen.findByText(
        "This analysis was made before merging and splitting existed. Run it again to enable editing.",
      ),
    ).toBeInTheDocument();
  });

  it("stops at six selections", async () => {
    const many = Array.from({ length: 8 }, (_, i) => opp(`m${i}`, `Cluster ${i}`, "ai", 90 - i));
    const analysis = done("a2", 2);
    render(
      <ResultsView
        campaignId="c1"
        analyses={[analysis]}
        selectedId="a2"
        detail={{ analysis, opportunities: many, report: null }}
        initialPreset="balanced"
        initialWeights={{} as never}
        canEdit
      />,
    );
    const user = userEvent.setup();
    for (let i = 0; i < 6; i++)
      await user.click(screen.getByRole("checkbox", { name: `Select “Cluster ${i}” to merge` }));
    expect(screen.getByRole("checkbox", { name: "Select “Cluster 6” to merge" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Merge 6 selected" })).toBeEnabled();
  });
});

describe("rename", () => {
  it("is an inline field with an explicit Save, sent as a title override", async () => {
    staff.opportunities.override.mockResolvedValue(opp("o1", "Notes once", "automation", 80));
    const user = userEvent.setup();
    renderResults();
    const card = screen.getByRole("heading", { name: "Single entry of notes" }).closest("[data-status]")!;
    await user.click(within(card as HTMLElement).getByRole("button", { name: "Rename" }));
    const input = screen.getByLabelText("New title");
    await user.clear(input);
    await user.type(input, "Notes once");
    expect(staff.opportunities.override).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save title" }));
    await waitFor(() => {
      expect(staff.opportunities.override).toHaveBeenCalledWith("o1", { title: "Notes once" });
    });
    expect(await screen.findByRole("heading", { name: "Notes once" })).toBeInTheDocument();
  });
});

describe("split", () => {
  const proposal = {
    parts: 2,
    facts: [
      { id: "f1", text: "Charting twice", part: 0 },
      { id: "f2", text: "Charting again", part: 0 },
      { id: "f3", text: "Ordering stock", part: 1 },
    ],
  };

  it("places each fact with a radio group and sends the partition", async () => {
    staff.opportunities.splitProposal.mockResolvedValue(proposal);
    staff.opportunities.split.mockResolvedValue({ analysis: done("a3", 3), editId: "e9" });
    const onSplit = vi.fn();
    const user = userEvent.setup();
    render(<SplitDialog opportunity={OPPS[0]!} k={3} open onOpenChange={vi.fn()} onSplit={onSplit} />);
    expect(await screen.findByText("Ordering stock")).toBeInTheDocument();
    expect(screen.getByText("A: 2 · B: 1")).toBeInTheDocument();
    // Move the second fact to part B with the keyboard-operable radio.
    const group = screen.getByRole("radiogroup", { name: "Charting again" });
    await user.click(within(group).getByRole("radio", { name: "Part B" }));
    expect(screen.getByText("A: 1 · B: 2")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Split into 2 parts" }));
    await waitFor(() => {
      expect(staff.opportunities.split).toHaveBeenCalledWith("o1", [["f1"], ["f2", "f3"]]);
    });
    expect(onSplit).toHaveBeenCalledWith("e9");
  });

  it("cannot be confirmed with an empty part", async () => {
    staff.opportunities.splitProposal.mockResolvedValue(proposal);
    const user = userEvent.setup();
    render(<SplitDialog opportunity={OPPS[0]!} k={3} open onOpenChange={vi.fn()} onSplit={vi.fn()} />);
    await screen.findByText("Ordering stock");
    await user.click(
      within(screen.getByRole("radiogroup", { name: "Ordering stock" })).getByRole("radio", {
        name: "Part A",
      }),
    );
    expect(screen.getByRole("button", { name: "Split into 2 parts" })).toBeDisabled();
    expect(screen.getByText("Put at least one fact in every part.")).toBeInTheDocument();
  });

  it("explains a cluster that is too small to show", async () => {
    staff.opportunities.splitProposal.mockRejectedValue(
      new ApiError(409, "conflict", "Fewer", { reason: "below_k" }),
    );
    render(<SplitDialog opportunity={OPPS[0]!} k={4} open onOpenChange={vi.fn()} onSplit={vi.fn()} />);
    expect(
      await screen.findByText(
        "Fewer than 4 participants are behind this opportunity, so its facts are not shown and it cannot be split.",
      ),
    ).toBeInTheDocument();
  });
});

describe("MergeBar", () => {
  it("renders nothing without a selection and explains an over-long one", () => {
    const { rerender } = render(<MergeBar count={0} max={6} onMerge={vi.fn()} onClear={vi.fn()} />);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    rerender(<MergeBar count={7} max={6} onMerge={vi.fn()} onClear={vi.fn()} />);
    expect(screen.getByText("Merge at most 6 at a time.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Merge 7 selected" })).toBeDisabled();
  });
});

describe("factor bars", () => {
  it("make every rationale reachable with the keyboard", async () => {
    const user = userEvent.setup();
    render(<FactorBars factors={opp("x", "x", "ai", 1).factors as never} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(FACTOR_KEYS.length);
    expect(buttons[0]).toHaveAccessibleName(/Because expected_impact/);
    await user.tab();
    expect(buttons[0]).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Because expected_impact");
  });
});

describe("department comparison", () => {
  const shown: DepartmentComparison = {
    shown: true,
    k: 3,
    belowK: 2,
    departments: [
      {
        name: "Ward",
        kind: "department",
        participants: 6,
        facts: 12,
        minutesPerWeek: 600,
        topOpportunities: [{ clusterKey: "c1", title: "Single entry of notes", share: 0.5 }],
        solutionClassShare: { automation: 0.67 },
      },
      {
        name: null,
        kind: "other",
        participants: 4,
        facts: 6,
        minutesPerWeek: 120,
        topOpportunities: [],
        solutionClassShare: {},
      },
    ],
  };

  it("prints every share as a number, withholds a cell, and says how many are not shown", () => {
    render(<DepartmentsPanel comparison={shown} />);
    const table = screen.getByRole("table", { name: "By department" });
    const ward = within(table).getByRole("row", { name: /Ward/ });
    expect(within(ward).getByText("67%")).toBeInTheDocument();
    expect(within(ward).getAllByText("Withheld").length).toBeGreaterThan(0);
    expect(within(table).getByRole("rowheader", { name: "Other departments" })).toBeInTheDocument();
    expect(screen.getByText("Single entry of notes (50%)")).toBeInTheDocument();
    expect(screen.getByText("2 departments with fewer than 3 people are not shown.")).toBeInTheDocument();
  });

  it("gives the reason, and k, when it is not shown", () => {
    render(
      <DepartmentsPanel
        comparison={{ shown: false, k: 5, reason: "too_few_eligible", departments: [], belowK: 3 }}
      />,
    );
    expect(screen.getByText("Not shown")).toBeInTheDocument();
    expect(
      screen.getByText("Fewer than two groups have at least 5 participants, so nothing is compared."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

describe("editErrorText", () => {
  it("names each refusal that has a remedy, and falls back to the API's words", () => {
    const err = (reason: string) => new ApiError(409, "conflict", "api words", { reason });
    expect(editErrorText(err("stale_analysis"), 3)).toMatch(/Only the newest version/);
    expect(editErrorText(err("in_progress"), 3)).toMatch(/analysis is running/);
    expect(editErrorText(err("below_k"), 7)).toMatch(/Fewer than 7 participants/);
    expect(editErrorText(new ApiError(500, "server_error", "boom"), 3)).toBe("boom");
  });
});
