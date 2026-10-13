import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JobsPanel } from "@/components/admin/operator/JobsPanel";
import { DeadJobListSchema, QueueListSchema, type DeadJob, type QueueSummary } from "@/lib/api/schemas";

const retry = vi.fn<(queue: string, id: string) => Promise<void>>();
const discard = vi.fn<(queue: string, id: string) => Promise<void>>();
const runNow = vi.fn<(name: string) => Promise<void>>();
const refresh = vi.fn();

vi.mock("@/lib/api/browser", () => ({
  staffClient: {
    operator: {
      jobs: {
        retry: (q: string, id: string): Promise<void> => retry(q, id),
        discard: (q: string, id: string): Promise<void> => discard(q, id),
        runNow: (n: string): Promise<void> => runNow(n),
      },
    },
  },
  participantClient: {},
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn(), back: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }));

const queue = (over: Partial<QueueSummary> = {}): QueueSummary => ({
  name: "analysis.run",
  queued: 0,
  active: 1,
  deadLettered: 0,
  oldestQueuedAt: null,
  expireInSeconds: 3600,
  retryLimit: 2,
  lastFailure: null,
  runNow: false,
  ...over,
});

const deadJob: DeadJob = {
  id: "dead-1",
  queue: "analysis.run",
  createdAt: "2026-10-13T10:00:00.000Z",
  sourceId: "orig-1",
  retryCount: 2,
  companyId: "co1",
  data: { analysisId: "an1", companyId: "co1" },
  error: "provider timed out",
};

beforeEach(() => {
  retry.mockReset().mockResolvedValue(undefined);
  discard.mockReset().mockResolvedValue(undefined);
  runNow.mockReset().mockResolvedValue(undefined);
  refresh.mockReset();
});

describe("API schemas for the jobs page", () => {
  it("accepts what GET /operator/jobs and the dead-letter list return", () => {
    expect(QueueListSchema.parse({ queues: [queue()] }).queues).toHaveLength(1);
    const parsed = DeadJobListSchema.parse({ queue: "analysis.run", jobs: [deadJob] });
    expect(parsed.jobs[0]?.data).toEqual({ analysisId: "an1", companyId: "co1" });
  });
});

describe("JobsPanel", () => {
  it("shows each queue with its limit and a badge on the ones with dead letters", () => {
    render(
      <JobsPanel
        queues={[queue(), queue({ name: "session.extract", deadLettered: 3, expireInSeconds: 180 })]}
        selected={undefined}
        dead={[]}
      />,
    );
    const row = screen.getByRole("row", { name: /session\.extract/ });
    expect(within(row).getByText("3")).toBeInTheDocument();
    expect(row.textContent).toContain("3 min · 3 attempts");
    // Only a queue with something to look at is a link.
    expect(screen.getByRole("link", { name: "session.extract" })).toHaveAttribute(
      "href",
      "/admin/operator/jobs?queue=session.extract",
    );
    expect(screen.queryByRole("link", { name: "analysis.run" })).toBeNull();
  });

  it("offers run-now only for jobs that take no payload, and calls the route", async () => {
    render(
      <JobsPanel
        queues={[queue({ name: "ops.health-sweep", runNow: true }), queue()]}
        selected={undefined}
        dead={[]}
      />,
    );
    expect(screen.getAllByRole("button", { name: /Run now/ })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Run now: ops.health-sweep" }));
    await waitFor(() => {
      expect(runNow).toHaveBeenCalledWith("ops.health-sweep");
    });
    await waitFor(() => {
      expect(refresh).toHaveBeenCalled();
    });
  });

  it("retries a dead letter only after the confirmation", async () => {
    render(<JobsPanel queues={[queue({ deadLettered: 1 })]} selected="analysis.run" dead={[deadJob]} />);
    expect(screen.getByText("provider timed out")).toBeInTheDocument();
    expect(screen.getByText(/analysisId: an1/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Retry: orig-1" }));
    expect(retry).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(retry).toHaveBeenCalledWith("analysis.run", "dead-1");
    });
    await waitFor(() => {
      expect(refresh).toHaveBeenCalled();
    });
  });

  it("discards through its own confirmation and not before", async () => {
    render(<JobsPanel queues={[queue({ deadLettered: 1 })]} selected="analysis.run" dead={[deadJob]} />);
    await userEvent.click(screen.getByRole("button", { name: "Discard: orig-1" }));
    expect(discard).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/cannot be undone/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(discard).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Discard: orig-1" }));
    const again = await screen.findByRole("alertdialog");
    await userEvent.click(within(again).getByRole("button", { name: "Discard" }));
    await waitFor(() => {
      expect(discard).toHaveBeenCalledWith("analysis.run", "dead-1");
    });
  });

  it("says so when the chosen queue has nothing dead, and when none is chosen", () => {
    const { rerender } = render(<JobsPanel queues={[queue()]} selected="analysis.run" dead={[]} />);
    expect(screen.getByText(/Nothing is dead-lettered/)).toBeInTheDocument();
    rerender(<JobsPanel queues={[queue()]} selected={undefined} dead={[]} />);
    expect(screen.getByText(/Choose a queue with dead letters/)).toBeInTheDocument();
  });
});
