import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SummaryView, SUMMARY_POLL_MS, uniqueFactLines } from "@/components/participant/SummaryView";
import type { ParticipantApi } from "@/lib/api/participant";
import type { Summary } from "@/lib/api/schemas";

/*
 * D-325. The end screen showed an empty, editable box when the summary was not there, and the demo
 * driver's last answer was typed into it and read as "the summary". The box is only ever the
 * written summary; before that the page says it is being written, and when none is coming it says
 * that instead of offering an empty field.
 */

const apiWith = (...answers: Summary[]): { api: ParticipantApi; calls: () => number } => {
  let n = 0;
  const getSummary = vi.fn(() => Promise.resolve(answers[Math.min(n++, answers.length - 1)]!));
  return { api: { getSummary, putSummary: vi.fn() } as never, calls: () => n };
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("SummaryView", () => {
  it("shows the written summary in an editable box", async () => {
    const { api } = apiWith({ summary: "You described double entry of notes.", facts: [], status: "ready" });
    render(<SummaryView api={api} available onDelete={vi.fn()} />);
    expect(await screen.findByLabelText("Your summary")).toHaveValue("You described double entry of notes.");
  });

  it("says the summary is being written, and shows it when it arrives", async () => {
    const { api, calls } = apiWith(
      { summary: "", facts: [], status: "pending" },
      { summary: "Here is what I took from this.", facts: [], status: "ready" },
    );
    render(<SummaryView api={api} available onDelete={vi.fn()} />);
    expect(await screen.findByText(/summary is being written/i)).toBeInTheDocument();
    // No empty box to type into while it is not there.
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUMMARY_POLL_MS + 50);
    });
    expect(await screen.findByLabelText("Your summary")).toHaveValue("Here is what I took from this.");
    expect(calls()).toBe(2);
  });

  it("says none was made, and offers no box, when none is coming", async () => {
    const { api } = apiWith({ summary: "", facts: [], status: "unavailable" });
    render(<SummaryView api={api} available onDelete={vi.fn()} />);
    expect(await screen.findByText(/No written summary was made/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("does not treat an empty 'ready' answer as a summary", async () => {
    const { api } = apiWith({ summary: "  ", facts: [], status: "ready" });
    render(<SummaryView api={api} available onDelete={vi.fn()} />);
    expect(await screen.findByText(/No written summary was made/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("says so when the summary cannot be loaded", async () => {
    const api = {
      getSummary: vi.fn(() => Promise.reject(new Error("down"))),
      putSummary: vi.fn(),
    } as never;
    render(<SummaryView api={api} available onDelete={vi.fn()} />);
    expect(await screen.findByText(/could not be loaded/)).toBeInTheDocument();
  });
});

describe("what was noted (simulation 2026-10-15)", () => {
  it("lists each item once, however often extraction saw it", () => {
    const task = (name: string, frequency: string) => ({ kind: "task", name, frequency }) as never;
    const lines = uniqueFactLines([
      task("Calling no-shows", "daily"),
      task("Re-keying appointments", "daily"),
      task("Calling no-shows", "daily"),
      task("calling no-shows ", "daily"),
      { kind: "process", name: "Calling no-shows" } as never,
    ]);
    expect(lines).toEqual(["Calling no-shows (daily)", "Re-keying appointments (daily)", "Calling no-shows"]);
  });
});
