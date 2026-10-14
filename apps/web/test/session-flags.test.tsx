import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FlagCallout } from "@/components/admin/campaigns/FlagCallout";
import { SessionsTable } from "@/components/admin/campaigns/SessionsTable";
import { enumFilter } from "@/lib/admin/toolbar";
import { LISTS } from "@/lib/api/lists";
import { SessionListItemSchema } from "@/lib/api/schemas";

/*
 * Hostility and distress flags in the admin screens (D-173): visible in the list and filterable,
 * a callout with the one action on the interview, and the reason only when the API sent it.
 */

const staff = vi.hoisted(() => ({ sessions: { acknowledgeFlag: vi.fn() } }));
const refresh = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/browser", () => ({ staffClient: staff, participantClient: {} }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn(), back: vi.fn() }),
  usePathname: () => "/admin",
  useSearchParams: () => new URLSearchParams(),
}));

beforeEach(() => {
  vi.resetAllMocks();
});

const row = (over: object) => SessionListItemSchema.parse({ id: "abcdef123456", status: "active", ...over });

describe("sessions table", () => {
  it("marks a flagged interview with words and an icon, and leaves the others alone", () => {
    render(<SessionsTable sessions={[row({ id: "aaaaaaaa1", flagged: true }), row({ id: "bbbbbbbb2" })]} />);

    expect(screen.getAllByText("Needs attention")).toHaveLength(1);
    const flaggedRow = screen.getByText("aaaaaaaa").closest("tr");
    expect(flaggedRow).toHaveTextContent("Needs attention");
    expect(screen.getByText("bbbbbbbb").closest("tr")).not.toHaveTextContent("Needs attention");
  });

  it("says an acknowledged flag was looked at, without removing it", () => {
    render(<SessionsTable sessions={[row({ flagged: true, flagAckedAt: "2026-10-14T10:00:00.000Z" })]} />);

    expect(screen.getByText("Looked at")).toBeInTheDocument();
    expect(screen.queryByText("Needs attention")).not.toBeInTheDocument();
  });
});

describe("the flagged filter", () => {
  it("offers exactly the values the list accepts, in words", () => {
    const f = enumFilter(LISTS.campaignSessions, "flagged", "Attention", "All interviews", (v) =>
      v === "true" ? "Needs attention" : "Not flagged",
    );

    expect(f.options).toEqual([
      { value: "true", label: "Needs attention" },
      { value: "false", label: "Not flagged" },
    ]);
  });
});

describe("flag callout", () => {
  it("shows the reason it was given and acknowledges once, then refreshes", async () => {
    staff.sessions.acknowledgeFlag.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <FlagCallout
        sessionId="s1"
        reason="Sounded distressed about a lay-off"
        acknowledgedAt={null}
        canAcknowledge
      />,
    );

    expect(screen.getByText("This interview was flagged")).toBeInTheDocument();
    expect(screen.getByText(/Sounded distressed about a lay-off/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Mark as looked at" }));

    await waitFor(() => {
      expect(staff.sessions.acknowledgeFlag).toHaveBeenCalledWith("s1");
    });
    await waitFor(() => {
      expect(refresh).toHaveBeenCalled();
    });
  });

  it("says the reason is hidden rather than showing nothing when the API sent none", () => {
    render(<FlagCallout sessionId="s1" reason={null} acknowledgedAt={null} canAcknowledge />);

    expect(screen.getByText(/hidden because transcripts are hidden/)).toBeInTheDocument();
  });

  it("gives a member the flag without the button, and an acknowledged one no button at all", () => {
    const { unmount } = render(
      <FlagCallout sessionId="s1" reason="r" acknowledgedAt={null} canAcknowledge={false} />,
    );
    expect(screen.queryByRole("button", { name: "Mark as looked at" })).not.toBeInTheDocument();
    unmount();

    render(
      <FlagCallout sessionId="s1" reason="r" acknowledgedAt="2026-10-14T10:00:00.000Z" canAcknowledge />,
    );
    expect(screen.queryByRole("button", { name: "Mark as looked at" })).not.toBeInTheDocument();
    expect(screen.getByText(/Looked at/)).toBeInTheDocument();
  });

  it("tells the admin when saving failed, and lets them try again", async () => {
    staff.sessions.acknowledgeFlag.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    render(<FlagCallout sessionId="s1" reason="r" acknowledgedAt={null} canAcknowledge />);

    await user.click(screen.getByRole("button", { name: "Mark as looked at" }));
    expect(await screen.findByText(/could not be saved/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Mark as looked at" }));
    await waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(1);
    });
  });
});
