import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DiagramViewer, nextZoom } from "@/components/report/DiagramViewer";

/*
 * The diagram viewer (D-381): zoom, source toggle, full screen. The drawing itself is Mermaid's
 * sanitized SVG, so the test hands it a plain one.
 */

const svg = '<svg viewBox="0 0 400 200"><text x="10" y="20">Nurse</text></svg>';
const view = (): ReturnType<typeof render> =>
  render(<DiagramViewer html={svg} natural={400} code={"graph TD\n A-->B"} label="Handover flow" />);

describe("nextZoom", () => {
  it("steps by a quarter, stays inside 50% to 400%, and resets to a whole", () => {
    expect(nextZoom(1, "in")).toBe(1.25);
    expect(nextZoom(1, "out")).toBe(0.8);
    expect(nextZoom(4, "in")).toBe(4);
    expect(nextZoom(0.5, "out")).toBe(0.5);
    expect(nextZoom(2.5, "reset")).toBe(1);
  });
});

describe("DiagramViewer", () => {
  it("names the drawing and shows it", () => {
    view();
    expect(screen.getByRole("img", { name: "Handover flow" })).toBeInTheDocument();
    expect(screen.getByText("Nurse")).toBeInTheDocument();
  });

  it("zooms with the buttons and with the keyboard, and fits to width again", async () => {
    const user = userEvent.setup();
    view();
    expect(screen.getByText("100%")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByText("125%")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("group"), { key: "+" });
    expect(screen.getByText("156%")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Fit to width" }));
    expect(screen.getByText("100%")).toBeInTheDocument();
  });

  it("swaps the drawing for its source and back", async () => {
    const user = userEvent.setup();
    view();
    await user.click(screen.getByRole("button", { name: "Show source" }));
    expect(screen.getByText(/A-->B/)).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show drawing" }));
    expect(screen.getByRole("img", { name: "Handover flow" })).toBeInTheDocument();
  });

  it("opens the same drawing full screen in a dialog that closes again", async () => {
    const user = userEvent.setup();
    view();
    await user.click(screen.getByRole("button", { name: "Open full screen" }));
    expect(screen.getByRole("dialog", { name: "Handover flow" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
