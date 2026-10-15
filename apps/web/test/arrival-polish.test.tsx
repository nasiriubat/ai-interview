import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArrivalFlow, RESEND_SECONDS } from "@/components/participant/ArrivalFlow";
import { InviteArrival } from "@/components/participant/InviteArrival";
import { OtherInput } from "@/components/widgets/OtherInput";
import { WidgetVoiceProvider } from "@/components/widgets/voice-context";
import { useCooldown } from "@/hooks/useCooldown";
import { setClientLocale } from "@/i18n";
import type { ParticipantApi } from "@/lib/api/participant";
import type { InviteArrival as InviteInfo } from "@/lib/api/schemas";

/*
 * The participant arrival, finished (spec 06, D-239): explicit agreement, a wait before a second
 * code, and speech into the "Other" field. Each test is a thing a participant does.
 */

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, back: vi.fn(), refresh: vi.fn() }),
}));

const campaign = {
  name: "Acme",
  productName: "",
  welcome: "",
  expectedMinutes: 10,
  participationMode: "participant_choice" as const,
  verification: "email_code" as const,
  consentText: "We keep your answers for your organization.",
  participantFields: [],
  pathSelection: "none" as const,
};

const mocks = () => ({
  requestCode: vi.fn(() => Promise.resolve()),
  confirmCode: vi.fn(() => Promise.resolve({ sessionId: "s", resume: false })),
  open: vi.fn(() => Promise.resolve({ sessionId: "s", resume: false })),
  consent: vi.fn(() => Promise.resolve()),
});
const api = (m: ReturnType<typeof mocks> = mocks()): ParticipantApi =>
  m as Partial<ParticipantApi> as ParticipantApi;

beforeEach(() => {
  push.mockReset();
  setClientLocale("en");
});
afterEach(() => {
  vi.useRealTimers();
});

async function toConsent(user: ReturnType<typeof userEvent.setup>, a: ParticipantApi): Promise<void> {
  render(<ArrivalFlow linkToken="t" campaign={{ ...campaign, verification: "open" }} api={a} />);
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByText("A few details");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByRole("heading", { name: "Before we start" });
}

describe("consent in the arrival flow", () => {
  it("cannot be skipped: the button waits for the box, and says why", async () => {
    const user = userEvent.setup();
    const m = mocks();
    await toConsent(user, api(m));
    const start = screen.getByRole("button", { name: "Start the interview" });
    expect(start).toBeDisabled();
    expect(screen.getByText("Tick the box to start.")).toBeInTheDocument();
    await user.click(start);
    expect(m.consent).not.toHaveBeenCalled();

    await user.click(screen.getByRole("checkbox", { name: /I have read the text above/ }));
    expect(start).toBeEnabled();
    expect(screen.queryByText("Tick the box to start.")).not.toBeInTheDocument();
    await user.click(start);
    await waitFor(() => {
      expect(m.consent).toHaveBeenCalledWith(expect.objectContaining({ participationChoice: "identified" }));
    });
    expect(push).toHaveBeenCalledWith("/p/session");
  });

  it("shows the consent text in a focusable, scrollable region that is named", async () => {
    const user = userEvent.setup();
    await toConsent(user, api());
    const region = screen.getByRole("region", { name: "Consent text" });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region.className).toContain("max-h-[50dvh]");
    expect(region).toHaveTextContent("We keep your answers for your organization.");
  });

  it("presents the participation choice as tiles, each with its consequence", async () => {
    const user = userEvent.setup();
    render(<ArrivalFlow linkToken="t" campaign={{ ...campaign, verification: "open" }} api={api()} />);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("A few details");
    const tiles = document.querySelectorAll('[data-slot="choice-tile"]');
    expect(tiles).toHaveLength(2);
    const radio = screen.getByRole("radio", { name: /Anonymous/ });
    await user.click(radio);
    expect(radio).toBeChecked();
  });
});

describe("the arrival welcome (D-460)", () => {
  const objective = "Understand how this person's work is actually performed and where time goes.";

  it("shows the campaign's welcome under the campaign name, never the interviewer's objective", () => {
    render(
      <ArrivalFlow
        linkToken="t"
        campaign={{
          ...campaign,
          name: "Where does our week go?",
          welcome: "Hello from the clinic leads.",
          objective,
        }}
        api={api()}
      />,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Where does our week go?" })).toBeInTheDocument();
    expect(screen.getByText("Hello from the clinic leads.")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(objective);
    // The old heading put the campaign name where a company name belonged.
    expect(document.body.textContent).not.toMatch(/would like to hear/);
  });

  it("falls back to a friendly default when the API sends none", () => {
    render(<ArrivalFlow linkToken="t" campaign={campaign} api={api()} />);
    expect(screen.getByText(/Thank you for taking part/)).toBeInTheDocument();
  });

  it("gives an invited idea owner the requirements default", () => {
    render(
      <InviteArrival
        token="tok"
        session={{
          title: "Ward intake",
          welcome: "",
          consentText: "C.",
          consentVersion: "v1",
          pathSelection: "none",
          productName: "",
          language: "en",
        }}
        api={api()}
      />,
    );
    expect(screen.getByText(/turns your idea into a written specification/)).toBeInTheDocument();
  });
});

describe("invited requirements participant", () => {
  const session: InviteInfo["session"] = {
    title: "Ward intake",
    welcome: "",
    consentText: "Consent.",
    consentVersion: "v1",
    pathSelection: "none",
    productName: "",
  } as InviteInfo["session"];

  it("says why the start button is off, as the arrival flow does", async () => {
    const user = userEvent.setup();
    render(<InviteArrival token="tok" session={session} api={api()} />);
    await user.click(screen.getByRole("button", { name: /Start|Get started|Continue/ }));
    expect(screen.getByRole("button", { name: "Start the interview" })).toBeDisabled();
    expect(screen.getByText("Tick the box to start.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Consent text" })).toHaveAttribute("tabindex", "0");
  });
});

describe("a new sign-in code", () => {
  it("counts down in the button and is announced once, not every second", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const m = mocks();
    render(<ArrivalFlow linkToken="t" campaign={campaign} api={api(m)} />);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    await screen.findByLabelText("Six-digit code");

    // The first code started the wait.
    const resend = screen.getByRole("button", { name: `Send a new code in ${String(RESEND_SECONDS)} s` });
    expect(resend).toBeDisabled();
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByRole("button", { name: /Send a new code in (19|20) s/ })).toBeDisabled();
    // A button label that ticks is not a live region.
    expect(screen.getByRole("button", { name: /Send a new code in/ })).not.toHaveAttribute("aria-live");

    act(() => {
      vi.advanceTimersByTime(21_000);
    });
    const ready = screen.getByRole("button", { name: "Send a new code" });
    expect(ready).toBeEnabled();
    await user.click(ready);
    await waitFor(() => {
      expect(m.requestCode).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByRole("status")).toHaveTextContent("You can ask for a new code in 30 seconds.");
    expect(screen.getByRole("button", { name: /Send a new code in/ })).toBeDisabled();
  });

  it("stacks the two actions on a narrow screen instead of colliding", async () => {
    const user = userEvent.setup();
    render(<ArrivalFlow linkToken="t" campaign={campaign} api={api()} />);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    await screen.findByLabelText("Six-digit code");
    const row = screen.getByRole("button", { name: "Change email" }).parentElement!;
    expect(row.className).toContain("flex-col");
    expect(row.className).toContain("sm:flex-row");
  });

  it("useCooldown is zero until started and then falls to zero on its own", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useCooldown(5));
    expect(result.current.remaining).toBe(0);
    act(() => {
      result.current.start();
    });
    expect(result.current.remaining).toBe(5);
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(result.current.remaining).toBe(0);
  });
});

describe("the Other field takes speech", () => {
  function Field({
    voice,
  }: {
    voice: Parameters<typeof WidgetVoiceProvider>[0]["value"];
  }): React.JSX.Element {
    const [v, setV] = React.useState("");
    return (
      <WidgetVoiceProvider value={voice}>
        <OtherInput id="o" value={v} onChange={setV} />
      </WidgetVoiceProvider>
    );
  }

  it("is plain typing when the interview takes no recorded voice", () => {
    render(<Field voice={null} />);
    expect(screen.getByLabelText("Other")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Speak your answer" })).not.toBeInTheDocument();
  });

  it("records, writes the words into the field and tells the participant to check them", async () => {
    const user = userEvent.setup();
    const transcribe = vi.fn().mockResolvedValue("a whiteboard in the corridor");
    render(<Field voice={{ transcribe }} />);
    await user.type(screen.getByLabelText("Other"), "Also");
    await user.click(screen.getByRole("button", { name: "Speak your answer" }));
    const stop = await screen.findByRole("button", { name: "Stop recording" });
    expect(stop).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Recording. Press stop");
    await user.click(stop);

    await waitFor(() => {
      expect(screen.getByLabelText("Other")).toHaveValue("Also a whiteboard in the corridor");
    });
    expect(transcribe).toHaveBeenCalledWith(expect.any(Blob), expect.any(Number));
    expect(screen.getByRole("status")).toHaveTextContent("Added what you said. Check it");
    expect(screen.getByLabelText("Other")).toHaveFocus();
  });

  it("keeps what was typed and says what went wrong when the words cannot be written out", async () => {
    const user = userEvent.setup();
    const transcribe = vi.fn().mockRejectedValue(new Error("offline"));
    render(<Field voice={{ transcribe }} />);
    await user.type(screen.getByLabelText("Other"), "Kept");
    await user.click(screen.getByRole("button", { name: "Speak your answer" }));
    await user.click(await screen.findByRole("button", { name: "Stop recording" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByLabelText("Other")).toHaveValue("Kept");
    // The microphone control is back, so another try is one press away.
    expect(screen.getByRole("button", { name: "Speak your answer" })).toBeEnabled();
  });

  it("names the control in Finnish", () => {
    setClientLocale("fi");
    render(<Field voice={{ transcribe: vi.fn() }} />);
    expect(screen.getByRole("button", { name: "Sano vastauksesi" })).toBeInTheDocument();
  });
});

describe("how long the interview takes (claims B9)", () => {
  it("states minutes only when the campaign has measured them", () => {
    const { unmount } = render(
      <ArrivalFlow linkToken="t" campaign={{ ...campaign, expectedMinutes: null }} api={api()} />,
    );
    expect(screen.getByText(/As long as you need/)).toBeInTheDocument();
    expect(screen.queryByText(/minutes/)).not.toBeInTheDocument();
    unmount();
    render(<ArrivalFlow linkToken="t" campaign={{ ...campaign, expectedMinutes: 12 }} api={api()} />);
    expect(screen.getByText("About 12 minutes for most people so far")).toBeInTheDocument();
  });
});
