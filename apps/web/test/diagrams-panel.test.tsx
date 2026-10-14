import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiagramsPanel } from "@/components/admin/requirements/DiagramsPanel";
import { ApiError } from "@/lib/api/errors";
import type { LiveDiagram, LiveSpec } from "@/lib/api/schemas";

/*
 * The diagram editor (FR-23): Mermaid source with a live preview, a required caption that doubles as
 * the alt text, errors that say which line, and the owner's text kept apart from the generated one.
 * The drawing itself is mocked: it loads Mermaid, which is not what is under test.
 */

const save = vi.fn();
const reset = vi.fn();

vi.mock("@/lib/api/browser", () => ({
  staffClient: {
    requirements: {
      diagrams: {
        save: (...a: unknown[]): unknown => save(...a),
        reset: (...a: unknown[]): unknown => reset(...a),
      },
    },
  },
  participantClient: {},
}));
vi.mock("@/components/report/MermaidDiagram", () => ({
  MermaidDiagram: ({ code, label }: { code: string; label?: string }) => (
    <figure role="img" aria-label={label ?? "diagram"} data-code={code} />
  ),
}));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }));
vi.mock("@/components/ui/sonner", () => ({ toast: toastMock, Toaster: () => null }));

const diagram = (over: Partial<LiveDiagram> = {}): LiveDiagram => ({
  key: "ctx",
  title: "Context",
  type: "context",
  mermaid: "flowchart LR\n  A --> B",
  description: "Who uses the system",
  status: "generated",
  verified: true,
  ...over,
});

const spec = (diagrams: LiveDiagram[]): LiveSpec => ({
  title: "T",
  context: {},
  sections: [],
  diagrams,
  findings: [],
  decisions: [],
  mvpChallenge: { started: false, done: false, asked: [] },
  stats: { fields: 0, sectionsWithContent: 0, openFindings: 0 },
});

beforeEach(() => {
  save.mockReset();
  reset.mockReset();
  toastMock.success.mockReset();
  toastMock.warning.mockReset();
});

describe("DiagramsPanel", () => {
  it("lists each diagram with where it came from, its caption and an accessible drawing", () => {
    render(
      <DiagramsPanel
        sessionId="s1"
        onSpec={vi.fn()}
        diagrams={[
          diagram(),
          diagram({ key: "deploy", title: "Deployment", status: "added", description: "Where it runs" }),
        ]}
      />,
    );
    const ctx = screen.getByRole("region", { name: "Context" });
    expect(within(ctx).getByText("Generated")).toBeInTheDocument();
    expect(within(ctx).getByText("Who uses the system")).toBeInTheDocument();
    expect(within(ctx).getByRole("img", { name: "Who uses the system" })).toBeInTheDocument();
    const deploy = screen.getByRole("region", { name: "Deployment" });
    expect(within(deploy).getByText("Added by owner")).toBeInTheDocument();
  });

  it("says so when there are none", () => {
    render(<DiagramsPanel sessionId="s1" onSpec={vi.fn()} diagrams={[]} />);
    expect(screen.getByText(/No diagrams yet/)).toBeInTheDocument();
  });

  it("warns that a diagram saved while the renderer was down is not checked", () => {
    render(
      <DiagramsPanel
        sessionId="s1"
        onSpec={vi.fn()}
        diagrams={[diagram({ status: "edited", verified: false })]}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/Not checked/);
  });

  it("edits one: labelled fields, a preview of what is typed, and the save goes to its key", async () => {
    const onSpec = vi.fn();
    const next = spec([diagram({ status: "edited", mermaid: "flowchart LR\n  A --> C" })]);
    save.mockResolvedValue({ spec: next, key: "ctx", verified: true });
    const user = userEvent.setup();
    render(<DiagramsPanel sessionId="s1" onSpec={onSpec} diagrams={[diagram()]} />);

    await user.click(screen.getByRole("button", { name: "Edit diagram Context" }));
    const source = screen.getByRole("textbox", { name: /Mermaid source/ });
    expect(source).toHaveValue("flowchart LR\n  A --> B");
    expect(screen.getByRole("textbox", { name: /Description/ })).toHaveValue("Who uses the system");
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Context");

    await user.clear(source);
    await user.type(source, "flowchart LR{enter}  A --> C");
    // the preview redraws a beat after typing stops
    await waitFor(
      () => {
        const preview = screen.getByRole("img", { name: /Preview of Context/ });
        expect(preview).toHaveAttribute("data-code", "flowchart LR\n  A --> C");
      },
      { timeout: 2000 },
    );

    await user.click(screen.getByRole("button", { name: "Save diagram" }));
    expect(save).toHaveBeenCalledWith("s1", "ctx", {
      mermaid: "flowchart LR\n  A --> C",
      description: "Who uses the system",
      title: "Context",
      type: "context",
    });
    await waitFor(() => {
      expect(onSpec).toHaveBeenCalledWith(next);
    });
    expect(toastMock.success).toHaveBeenCalledWith("Diagram saved");
  });

  it("will not send a diagram without a description or source, and says why next to the field", async () => {
    const user = userEvent.setup();
    render(<DiagramsPanel sessionId="s1" onSpec={vi.fn()} diagrams={[diagram({ description: "" })]} />);
    await user.click(screen.getByRole("button", { name: "Edit diagram Context" }));
    await user.clear(screen.getByRole("textbox", { name: /Mermaid source/ }));
    await user.click(screen.getByRole("button", { name: "Save diagram" }));
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByText("Add a description of what the diagram shows.")).toBeInTheDocument();
    expect(screen.getByText("Write the diagram's Mermaid source.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /Description/ })).toBeInvalid();
  });

  it("lists what the server refused, with the line, and keeps the editor open", async () => {
    save.mockRejectedValue(
      new ApiError(400, "validation", "Parse error", {
        issues: [
          { message: "click statements are not allowed.", line: 3 },
          { message: "HTML in labels is not allowed, except <br>." },
        ],
      }),
    );
    const user = userEvent.setup();
    render(<DiagramsPanel sessionId="s1" onSpec={vi.fn()} diagrams={[diagram()]} />);
    await user.click(screen.getByRole("button", { name: "Edit diagram Context" }));
    await user.click(screen.getByRole("button", { name: "Save diagram" }));
    const alert = await screen.findByText("The diagram was not saved:");
    const list = alert.closest<HTMLElement>("[role=alert]")!;
    expect(within(list).getByText(/line 3: click statements are not allowed/)).toBeInTheDocument();
    expect(within(list).getByText(/HTML in labels is not allowed/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /Mermaid source/ })).toBeInTheDocument();
  });

  it("adds a diagram with a null key and tells the person when it could not be checked", async () => {
    save.mockResolvedValue({
      spec: spec([diagram({ key: "custom-x", status: "added" })]),
      key: "custom-x",
      verified: false,
    });
    const onSpec = vi.fn();
    const user = userEvent.setup();
    render(<DiagramsPanel sessionId="s1" onSpec={onSpec} diagrams={[]} />);
    await user.click(screen.getByRole("button", { name: "Add a diagram" }));
    await user.type(screen.getByRole("textbox", { name: "Title" }), "Hosting");
    await user.type(screen.getByRole("textbox", { name: /Description/ }), "Where it runs");
    await user.click(screen.getByRole("button", { name: "Save diagram" }));
    expect(save).toHaveBeenCalledWith(
      "s1",
      null,
      expect.objectContaining({ description: "Where it runs", title: "Hosting", type: "context" }),
    );
    await waitFor(() => {
      expect(onSpec).toHaveBeenCalled();
    });
    expect(toastMock.warning).toHaveBeenCalledWith(expect.stringMatching(/could not be checked/));
  });

  it("puts a generated diagram back, and removes one the owner added", async () => {
    reset.mockResolvedValue(spec([]));
    const onSpec = vi.fn();
    const user = userEvent.setup();
    render(
      <DiagramsPanel
        sessionId="s1"
        onSpec={onSpec}
        diagrams={[
          diagram({ status: "edited", original: "flowchart LR\n  X --> Y" }),
          diagram({ key: "deploy", title: "Deployment", status: "added" }),
        ]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Edit diagram Context" }));
    // the generated source can be looked at before deciding
    await user.click(screen.getByText("Show the generated version"));
    expect(screen.getByLabelText("Generated version")).toHaveTextContent("X --> Y");
    await user.click(screen.getByRole("button", { name: "Put back the generated diagram" }));
    expect(reset).toHaveBeenCalledWith("s1", "ctx");
    await waitFor(() => {
      expect(onSpec).toHaveBeenCalled();
    });

    await user.click(screen.getByRole("button", { name: "Edit diagram Deployment" }));
    expect(screen.getByRole("button", { name: "Remove this diagram" })).toBeInTheDocument();
  });

  it("offers no reset for a diagram that has not been touched", async () => {
    const user = userEvent.setup();
    render(<DiagramsPanel sessionId="s1" onSpec={vi.fn()} diagrams={[diagram()]} />);
    await user.click(screen.getByRole("button", { name: "Edit diagram Context" }));
    expect(screen.queryByRole("button", { name: /Put back|Remove/ })).toBeNull();
  });
});
