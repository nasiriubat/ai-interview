import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FindingsList } from "@/components/admin/requirements/FindingsList";
import { SpecSections } from "@/components/admin/requirements/SpecSections";
import type { FindingRecord, LiveSpec } from "@/lib/api/schemas";

const editSection = vi.fn();
const settleFinding = vi.fn();

vi.mock("@/lib/api/browser", () => ({
  staffClient: {
    requirements: {
      editSection: (...args: unknown[]): unknown => editSection(...args),
      settleFinding: (...args: unknown[]): unknown => settleFinding(...args),
    },
  },
  participantClient: {},
}));

const finding: FindingRecord = {
  id: "f1",
  type: "contradiction",
  section: "rules",
  path: "cancellation",
  description: "Free cancellation contradicts the no-show fee.",
  resolution: "Charge only after the cutoff.",
  default: "24 h cutoff",
  confidence: "high",
  status: "raised",
  pushedBack: false,
};

const spec: LiveSpec = {
  title: "Clinic booking",
  path: "technical",
  context: { users: "Front desk" },
  sections: [
    {
      key: "overview",
      title: "Overview",
      status: "draft",
      markdown: "Bookings by **phone** are slow.",
      fields: [],
    },
    { key: "users", title: "Users", status: "empty", markdown: "", fields: [] },
  ],
  diagrams: [],
  findings: [finding],
  decisions: [],
  mvpChallenge: { started: true, done: false, asked: ["FR-1", "FR-2"] },
  stats: { fields: 3, sectionsWithContent: 1, openFindings: 1 },
};

beforeEach(() => {
  editSection.mockReset();
  settleFinding.mockReset();
});

describe("SpecSections", () => {
  it("renders sections with their status, context and the MVP challenge state", () => {
    render(<SpecSections sessionId="s1" spec={spec} onSpec={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Product overview and problem" })).toBeInTheDocument();
    expect(screen.getByText("phone")).toBeInTheDocument();
    expect(screen.getByText("Nothing captured yet.")).toBeInTheDocument();
    expect(screen.getByText("Front desk")).toBeInTheDocument();
    expect(screen.getByText("In progress · 2 items asked")).toBeInTheDocument();
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.getByText("Empty")).toBeInTheDocument();
  });

  it("edits a section inline, sends the Markdown and hands the returned spec up", async () => {
    const updated: LiveSpec = {
      ...spec,
      sections: [{ ...spec.sections[0]!, status: "edited", markdown: "Edited text" }, spec.sections[1]!],
    };
    editSection.mockResolvedValue(updated);
    const onSpec = vi.fn();
    const user = userEvent.setup();
    render(<SpecSections sessionId="s1" spec={spec} onSpec={onSpec} />);

    await user.click(screen.getByRole("button", { name: "Edit Product overview and problem" }));
    const editor = screen.getByLabelText("Markdown for Product overview and problem");
    expect(editor).toHaveValue("Bookings by **phone** are slow.");
    await user.clear(editor);
    await user.type(editor, "Edited text");
    await user.click(screen.getByRole("button", { name: "Save section" }));

    await waitFor(() => {
      expect(onSpec).toHaveBeenCalledWith(updated);
    });
    expect(editSection).toHaveBeenCalledWith("s1", "overview", "Edited text");
    expect(screen.queryByLabelText("Markdown for Product overview and problem")).not.toBeInTheDocument();
  });

  it("offers to clear an owner edit and sends an empty string", async () => {
    const edited: LiveSpec = {
      ...spec,
      sections: [{ ...spec.sections[0]!, status: "edited", markdown: "Mine" }],
    };
    editSection.mockResolvedValue(spec);
    const onSpec = vi.fn();
    const user = userEvent.setup();
    render(<SpecSections sessionId="s1" spec={edited} onSpec={onSpec} />);
    expect(screen.getByText("Edited by owner")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit Product overview and problem" }));
    await user.click(screen.getByRole("button", { name: "Clear edit" }));
    await waitFor(() => {
      expect(editSection).toHaveBeenCalledWith("s1", "overview", "");
    });
    expect(onSpec).toHaveBeenCalledWith(spec);
  });
});

describe("FindingsList", () => {
  it("shows an empty state without findings", () => {
    render(<FindingsList sessionId="s1" findings={[]} onSpec={vi.fn()} />);
    expect(screen.getByText(/No findings yet/)).toBeInTheDocument();
  });

  it("settles an open finding with an outcome and note, and collapses settled ones", async () => {
    const settledSpec: LiveSpec = {
      ...spec,
      findings: [{ ...finding, status: "deferred", note: "Revisit in phase 2" }],
    };
    settleFinding.mockResolvedValue(settledSpec);
    const onSpec = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<FindingsList sessionId="s1" findings={[finding]} onSpec={onSpec} />);

    expect(screen.getByText("Contradiction")).toBeInTheDocument();
    expect(screen.getByText("Business rules · cancellation")).toBeInTheDocument();
    expect(screen.getByText("Charge only after the cutoff.")).toBeInTheDocument();
    await user.type(screen.getByLabelText(`Note for: ${finding.description}`), "Revisit in phase 2");
    await user.click(screen.getByRole("button", { name: "Defer" }));
    await waitFor(() => {
      expect(onSpec).toHaveBeenCalledWith(settledSpec);
    });
    expect(settleFinding).toHaveBeenCalledWith("s1", "f1", "deferred", "Revisit in phase 2");

    rerender(<FindingsList sessionId="s1" findings={settledSpec.findings} onSpec={onSpec} />);
    expect(screen.queryByRole("button", { name: "Defer" })).not.toBeInTheDocument();
    expect(screen.getByText("Settled (1)")).toBeInTheDocument();
    expect(screen.getByText("Revisit in phase 2")).toBeInTheDocument();
  });

  it("sends resolve and accept without a note", async () => {
    settleFinding.mockResolvedValue(spec);
    const user = userEvent.setup();
    render(<FindingsList sessionId="s1" findings={[finding]} onSpec={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Resolve" }));
    await waitFor(() => {
      expect(settleFinding).toHaveBeenCalledWith("s1", "f1", "resolved", undefined);
    });
    await user.click(screen.getByRole("button", { name: "Accept as is" }));
    await waitFor(() => {
      expect(settleFinding).toHaveBeenCalledWith("s1", "f1", "accepted", undefined);
    });
  });
});
