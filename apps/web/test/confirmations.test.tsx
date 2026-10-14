import { FACTOR_KEYS } from "@aidp/shared";
import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CampaignActions } from "@/components/admin/campaigns/CampaignActions";
import { InvitationsPanel } from "@/components/admin/campaigns/InvitationsPanel";
import { TenantsPanel } from "@/components/admin/operator/TenantsPanel";
import { RoutesForm } from "@/components/admin/providers/RoutesForm";
import { InvitationsSection } from "@/components/admin/requirements/InvitationsSection";
import { ResultsView } from "@/components/admin/results/ResultsView";
import { UsersPanel } from "@/components/admin/users/UsersPanel";
import { SessionMenu } from "@/components/participant/SessionMenu";
import { useAttachments } from "@/hooks/useAttachments";
import type { ParticipantApi } from "@/lib/api/participant";
import {
  AnalysisSchema,
  CampaignSchema,
  InvitationSchema,
  OpportunitySchema,
  SessionInvitationSchema,
  TenantSchema,
  UserSchema,
  type Attachment,
  type Provider,
  type RouteRecord,
  type SessionCapabilities,
} from "@/lib/api/schemas";

/*
 * The confirmation policy (D-111): an action that affects another person, destroys data or cannot
 * be undone on the same screen asks first; one that is reversible in a click takes effect and
 * offers Undo. Each test names which of the two it is.
 */

const staff = vi.hoisted(() => ({
  campaigns: { close: vi.fn(), open: vi.fn(), invite: vi.fn(), revoke: vi.fn(), remind: vi.fn() },
  requirements: { invitations: { create: vi.fn(), revoke: vi.fn() } },
  operator: { tenants: { create: vi.fn(), update: vi.fn() }, routes: { put: vi.fn() }, providers: {} },
  users: { create: vi.fn(), update: vi.fn(), remove: vi.fn() },
  opportunities: { setStatus: vi.fn() },
  routes: { put: vi.fn() },
  providers: { models: vi.fn() },
  settings: { put: vi.fn() },
  analyses: { start: vi.fn() },
}));

const toasts = vi.hoisted(() => {
  const calls: {
    text: string;
    options: {
      action?: { label: string; onClick: () => void };
      onDismiss?: () => void;
      onAutoClose?: () => void;
    };
  }[] = [];
  const toast = Object.assign(
    (text: string, options: (typeof calls)[number]["options"] = {}): number => {
      calls.push({ text, options });
      return calls.length;
    },
    { success: vi.fn(), error: vi.fn() },
  );
  return { calls, toast };
});

vi.mock("@/lib/api/browser", () => ({ staffClient: staff, participantClient: {} }));
vi.mock("@/components/ui/sonner", () => ({ toast: toasts.toast, Toaster: () => null }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), back: vi.fn() }),
  usePathname: () => "/admin",
  useSearchParams: () => new URLSearchParams(),
}));

beforeEach(() => {
  toasts.calls.length = 0;
  vi.resetAllMocks();
  staff.providers.models.mockResolvedValue({ models: [] });
});

const dialog = (): HTMLElement => screen.getByRole("alertdialog");

describe("close campaign: asks first", () => {
  const campaign = CampaignSchema.parse({
    id: "c1",
    name: "Q3",
    status: "open",
    link: { url: "https://x/p/a" },
  });

  it("does nothing until confirmed, and Cancel leaves the campaign open", async () => {
    staff.campaigns.close.mockResolvedValue(campaign);
    const user = userEvent.setup();
    render(<CampaignActions campaign={campaign} />);
    await user.click(screen.getByRole("button", { name: "Close campaign" }));
    expect(within(dialog()).getByText("Close this campaign?")).toBeInTheDocument();
    expect(staff.campaigns.close).not.toHaveBeenCalled();

    await user.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(staff.campaigns.close).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Close campaign" }));
    await user.click(within(dialog()).getByRole("button", { name: "Close campaign" }));
    expect(staff.campaigns.close).toHaveBeenCalledWith("c1");
  });

  it("opening a closed campaign needs no confirmation", async () => {
    staff.campaigns.open.mockResolvedValue(campaign);
    const user = userEvent.setup();
    render(<CampaignActions campaign={{ ...campaign, status: "closed" }} />);
    await user.click(screen.getByRole("button", { name: "Open campaign" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(staff.campaigns.open).toHaveBeenCalledWith("c1");
  });
});

describe("invitations: revoke and bulk send ask first", () => {
  const inv = InvitationSchema.parse({ id: "i1", email: "ada@example.com", status: "sent" });

  it("revoking a campaign invitation names the person and waits", async () => {
    staff.campaigns.revoke.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<InvitationsPanel campaignId="c1" invitations={[inv]} />);
    await user.click(screen.getByRole("button", { name: "Revoke: ada@example.com" }));
    expect(
      within(dialog()).getByText(/ada@example\.com will no longer be able to use this invitation/),
    ).toBeInTheDocument();
    expect(staff.campaigns.revoke).not.toHaveBeenCalled();
    await user.click(within(dialog()).getByRole("button", { name: "Revoke invitation" }));
    expect(staff.campaigns.revoke).toHaveBeenCalledWith("c1", "i1");
  });

  it("revoking a requirements invitation asks too", async () => {
    staff.requirements.invitations.revoke.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <InvitationsSection
        sessionId="r1"
        initial={[SessionInvitationSchema.parse({ id: "si1", email: "bo@example.com", status: "sent" })]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Revoke: bo@example.com" }));
    expect(staff.requirements.invitations.revoke).not.toHaveBeenCalled();
    await user.click(within(dialog()).getByRole("button", { name: "Revoke invitation" }));
    expect(staff.requirements.invitations.revoke).toHaveBeenCalledWith("r1", "si1");
  });

  it("more than 50 addresses ask with the count; 50 or fewer send straight away", async () => {
    staff.campaigns.invite.mockResolvedValue({ created: 1, skipped: 0 });
    const user = userEvent.setup();
    render(<InvitationsPanel campaignId="c1" invitations={[]} />);
    const box = screen.getByLabelText("Email");

    await user.click(box);
    await user.paste(Array.from({ length: 50 }, (_, i) => `p${i}@example.com`).join("\n"));
    await user.click(screen.getByRole("button", { name: /Send invitations/ }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(staff.campaigns.invite).toHaveBeenCalledTimes(1);
    });

    await user.click(box);
    await user.paste(Array.from({ length: 51 }, (_, i) => `q${i}@example.com`).join("\n"));
    await user.click(screen.getByRole("button", { name: /Send invitations/ }));
    expect(within(dialog()).getByText("Send 51 invitations?")).toBeInTheDocument();
    expect(staff.campaigns.invite).toHaveBeenCalledTimes(1);
    await user.click(within(dialog()).getByRole("button", { name: "Send 51 invitations" }));
    await waitFor(() => {
      expect(staff.campaigns.invite).toHaveBeenCalledTimes(2);
    });
    expect(staff.campaigns.invite.mock.calls[1]?.[1]).toHaveLength(51);
  });
});

describe("tenants and roles: ask first", () => {
  it("suspending names the tenant; activating does not ask", async () => {
    staff.operator.tenants.update.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <TenantsPanel
        tenants={[
          TenantSchema.parse({ id: "t1", name: "Acme", status: "active" }),
          TenantSchema.parse({ id: "t2", name: "Beta", status: "suspended" }),
        ]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Suspend: Acme" }));
    expect(within(dialog()).getByText("Suspend Acme?")).toBeInTheDocument();
    expect(staff.operator.tenants.update).not.toHaveBeenCalled();
    await user.click(within(dialog()).getByRole("button", { name: "Suspend tenant" }));
    expect(staff.operator.tenants.update).toHaveBeenCalledWith("t1", { status: "suspended" });

    await user.click(screen.getByRole("button", { name: "Activate: Beta" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(staff.operator.tenants.update).toHaveBeenLastCalledWith("t2", { status: "active" });
  });

  it("a role change shows the consequence and keeps the saved role until confirmed", async () => {
    staff.users.update.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <UsersPanel
        users={[UserSchema.parse({ id: "u1", email: "kim@example.com", role: "member" })]}
        canEdit
      />,
    );
    await user.click(screen.getByRole("button", { name: "Change role: kim@example.com" }));
    const role = await screen.findByRole("dialog");
    expect(within(role).getByText("Change the role of kim@example.com?")).toBeInTheDocument();
    expect(within(role).getByText(/Admins can change settings/)).toBeInTheDocument();
    expect(staff.users.update).not.toHaveBeenCalled();
    await user.click(within(role).getByRole("button", { name: "Change to Admin" }));
    expect(staff.users.update).toHaveBeenCalledWith("u1", { role: "admin" });
  });

  it("disabling a user asks first, says they are signed out at once, and offers no button for yourself", async () => {
    staff.users.update.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <UsersPanel
        users={[
          UserSchema.parse({ id: "me", email: "boss@example.com", role: "admin" }),
          UserSchema.parse({ id: "u1", email: "kim@example.com", role: "member" }),
        ]}
        canEdit
        currentUserId="me"
      />,
    );
    expect(screen.queryByRole("button", { name: "Disable: boss@example.com" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete: boss@example.com" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Disable: kim@example.com" }));
    expect(within(dialog()).getByText("Disable kim@example.com?")).toBeInTheDocument();
    expect(within(dialog()).getByText(/signed out of every device at once/)).toBeInTheDocument();
    expect(staff.users.update).not.toHaveBeenCalled();
    await user.click(within(dialog()).getByRole("button", { name: "Disable user" }));
    expect(staff.users.update).toHaveBeenCalledWith("u1", { disabled: true });
  });

  it("deleting a user asks first and says what happens to what they owned", async () => {
    staff.users.remove.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <UsersPanel
        users={[UserSchema.parse({ id: "u1", email: "kim@example.com", role: "member" })]}
        canEdit
        currentUserId="me"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Delete: kim@example.com" }));
    expect(within(dialog()).getByText("Delete kim@example.com?")).toBeInTheDocument();
    expect(within(dialog()).getByText(/become yours/)).toBeInTheDocument();
    expect(staff.users.remove).not.toHaveBeenCalled();
    await user.click(within(dialog()).getByRole("button", { name: "Delete user" }));
    expect(staff.users.remove).toHaveBeenCalledWith("u1");
  });

  it("a disabled user is marked, and can be enabled again", async () => {
    staff.users.update.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <UsersPanel
        users={[
          UserSchema.parse({
            id: "u1",
            email: "kim@example.com",
            role: "member",
            disabledAt: "2026-10-01T10:00:00Z",
          }),
        ]}
        canEdit
        currentUserId="me"
      />,
    );
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Enable: kim@example.com" }));
    await user.click(within(dialog()).getByRole("button", { name: "Enable user" }));
    expect(staff.users.update).toHaveBeenCalledWith("u1", { disabled: false });
  });
});

describe("reversible actions take effect and offer Undo", () => {
  const factors = Object.fromEntries(FACTOR_KEYS.map((k) => [k, { score: 3, rationale: "" }]));
  const opportunity = (status: string) =>
    OpportunitySchema.parse({
      id: "o1",
      title: "Triage tickets",
      solutionClass: "ai",
      factors,
      status,
      stats: { participants: 5, facts: 9 },
    });
  const analysis = AnalysisSchema.parse({ id: "a1", status: "done", stats: { thresholdMet: true } });

  function renderResults(status: string): void {
    render(
      <ResultsView
        campaignId="c1"
        analyses={[analysis]}
        selectedId="a1"
        detail={{ analysis, opportunities: [opportunity(status)], report: null }}
        initialPreset="balanced"
        initialWeights={{} as never}
        initialTab="opportunities"
      />,
    );
  }

  it("shortlist is sent at once, and Undo sends the status the card had", async () => {
    staff.opportunities.setStatus.mockImplementation((_id: string, status: string) =>
      Promise.resolve(opportunity(status)),
    );
    const user = userEvent.setup();
    renderResults("new");
    await user.click(screen.getByRole("button", { name: "Shortlist: Triage tickets" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(staff.opportunities.setStatus).toHaveBeenLastCalledWith("o1", "shortlisted");
    await waitFor(() => {
      expect(toasts.calls).toHaveLength(1);
    });
    expect(toasts.calls[0]?.text).toBe("Shortlisted “Triage tickets”.");
    expect(toasts.calls[0]?.options.action?.label).toBe("Undo");

    await act(async () => {
      toasts.calls[0]?.options.action?.onClick();
      await Promise.resolve();
    });
    expect(staff.opportunities.setStatus).toHaveBeenLastCalledWith("o1", "new");
    // Undoing is not itself undoable: no second toast.
    await waitFor(() => {
      expect(staff.opportunities.setStatus).toHaveBeenCalledTimes(2);
    });
    expect(toasts.calls).toHaveLength(1);
  });

  it("dismiss and restore offer Undo as well", async () => {
    staff.opportunities.setStatus.mockImplementation((_id: string, status: string) =>
      Promise.resolve(opportunity(status)),
    );
    const user = userEvent.setup();
    renderResults("new");
    await user.click(screen.getByRole("button", { name: "Dismiss: Triage tickets" }));
    await waitFor(() => {
      expect(toasts.calls.at(-1)?.text).toBe("Dismissed “Triage tickets”.");
    });
    await user.click(await screen.findByRole("button", { name: "Restore: Triage tickets" }));
    await waitFor(() => {
      expect(toasts.calls.at(-1)?.text).toBe("Restored “Triage tickets”.");
    });
    expect(staff.opportunities.setStatus).toHaveBeenLastCalledWith("o1", "new");
  });

  it("clearing a route override is sent at once, and Undo puts the row back", async () => {
    staff.routes.put.mockResolvedValue(undefined);
    const provider: Provider = {
      id: "p1",
      kind: "openai",
      name: "OpenAI",
      enabled: true,
      hasKey: true,
    };
    const routes = [
      {
        companyId: "co1",
        purpose: "interview_turn",
        providerId: "p1",
        model: "gpt-x",
        maxOutputTokens: 800,
        batchAllowed: false,
      },
    ] as RouteRecord[];
    const user = userEvent.setup();
    render(<RoutesForm routes={routes} providers={[provider]} scope="tenant" companyId="co1" />);
    await user.click(screen.getByRole("button", { name: /Use the platform default: / }));
    await waitFor(() => {
      expect(staff.routes.put).toHaveBeenCalledTimes(1);
    });
    const cleared = (staff.routes.put.mock.calls[0]?.[0] as { purpose: string; providerId: string }[]).find(
      (r) => r.purpose === "interview_turn",
    );
    expect(cleared?.providerId).toBe("");
    await waitFor(() => {
      expect(toasts.calls.at(-1)?.options.action?.label).toBe("Undo");
    });

    await act(async () => {
      toasts.calls.at(-1)?.options.action?.onClick();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(staff.routes.put).toHaveBeenCalledTimes(2);
    });
    const restored = (
      staff.routes.put.mock.calls[1]?.[0] as { purpose: string; providerId: string; model: string }[]
    ).find((r) => r.purpose === "interview_turn");
    expect(restored).toMatchObject({ providerId: "p1", model: "gpt-x" });
  });
});

describe("removing an attachment is deferred until the Undo offer lapses", () => {
  const capabilities: SessionCapabilities = {
    recordedVoice: true,
    liveVoice: false,
    captions: true,
    fileUpload: true,
    maxSizeMb: 20,
    allowedTypes: ["application/pdf"],
  };
  const file = (id: string): Attachment =>
    ({
      id,
      kind: "document",
      filename: `${id}.pdf`,
      sizeBytes: 100,
      status: "ready",
    }) as Attachment;

  function setup(): {
    deleteAttachment: ReturnType<typeof vi.fn>;
    result: { current: ReturnType<typeof useAttachments> };
    unmount: () => void;
  } {
    const deleteAttachment = vi.fn(() => Promise.resolve());
    const api = { deleteAttachment, listAttachments: () => Promise.resolve([]) } as unknown as ParticipantApi;
    const { result, unmount } = renderHook(() =>
      useAttachments(api, { initial: [file("a"), file("b"), file("c")], capabilities, enabled: true }),
    );
    return { deleteAttachment, result, unmount };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("hides the row, does not delete, and Undo brings it back in place", () => {
    const { deleteAttachment, result } = setup();
    act(() => {
      result.current.remove("b");
    });
    expect(result.current.items.map((a) => a.id)).toEqual(["a", "c"]);
    expect(deleteAttachment).not.toHaveBeenCalled();
    expect(toasts.calls[0]?.text).toBe("Removed b.pdf.");

    act(() => {
      toasts.calls[0]?.options.action?.onClick();
    });
    expect(result.current.items.map((a) => a.id)).toEqual(["a", "b", "c"]);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(deleteAttachment).not.toHaveBeenCalled();
  });

  it("sends the DELETE once, when the offer lapses", () => {
    const { deleteAttachment, result } = setup();
    act(() => {
      result.current.remove("a");
    });
    act(() => {
      vi.advanceTimersByTime(5_900);
    });
    expect(deleteAttachment).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(deleteAttachment).toHaveBeenCalledTimes(1);
    expect(deleteAttachment).toHaveBeenCalledWith("a");
    // The toast closing afterwards does not send it a second time.
    act(() => {
      toasts.calls[0]?.options.onAutoClose?.();
    });
    expect(deleteAttachment).toHaveBeenCalledTimes(1);
  });

  it("closing the toast sends the DELETE at once, and leaving the screen flushes a waiting one", () => {
    const first = setup();
    act(() => {
      first.result.current.remove("a");
      toasts.calls[0]?.options.onDismiss?.();
    });
    expect(first.deleteAttachment).toHaveBeenCalledWith("a");

    const second = setup();
    act(() => {
      second.result.current.remove("c");
    });
    expect(second.deleteAttachment).not.toHaveBeenCalled();
    second.unmount();
    expect(second.deleteAttachment).toHaveBeenCalledWith("c");
  });
});

describe("participant: finishing the interview asks first", () => {
  it("I'm done opens a question, Cancel changes nothing, Finish ends it", async () => {
    const onDone = vi.fn();
    const user = userEvent.setup();
    render(<SessionMenu onPause={vi.fn()} onDone={onDone} onDelete={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Interview options" }));
    await user.click(screen.getByRole("button", { name: "I'm done" }));
    expect(within(dialog()).getByText("Finish the interview?")).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    await user.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    expect(onDone).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Interview options" }));
    await user.click(screen.getByRole("button", { name: "I'm done" }));
    await user.click(within(dialog()).getByRole("button", { name: "Finish" }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("pausing does not ask, because reopening the link undoes it", async () => {
    const onPause = vi.fn();
    const user = userEvent.setup();
    render(<SessionMenu onPause={onPause} onDone={vi.fn()} onDelete={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Interview options" }));
    await user.click(screen.getByRole("button", { name: "Pause" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(onPause).toHaveBeenCalledTimes(1);
  });
});
