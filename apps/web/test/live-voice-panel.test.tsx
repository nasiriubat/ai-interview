import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LiveVoicePanel } from "@/components/admin/settings/LiveVoicePanel";
import { ApiError } from "@/lib/api/errors";
import type { VoiceReadiness } from "@/lib/api/schemas";

const readiness = vi.fn();
const connectOpenAI = vi.fn();
const setLive = vi.fn();
const refresh = vi.fn();

const toastSuccess = vi.fn<(text: string) => void>();
// Completed actions are confirmed with a toast (D-78), not an inline status line.
vi.mock("sonner", () => ({
  toast: {
    success: (text: string) => {
      toastSuccess(text);
    },
  },
  Toaster: () => null,
}));

vi.mock("@/lib/api/browser", () => ({
  staffClient: {
    voice: {
      readiness: (...a: unknown[]): unknown => readiness(...a),
      connectOpenAI: (...a: unknown[]): unknown => connectOpenAI(...a),
      setLive: (...a: unknown[]): unknown => setLive(...a),
    },
  },
  participantClient: {},
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn(), back: vi.fn() }),
}));

const notReady: VoiceReadiness = {
  liveVoiceEnabled: false,
  recordedVoiceEnabled: true,
  purposes: {
    transcription: { ready: true, providerName: "OpenAI (platform)", model: "whisper-1", scope: "platform" },
    stt_stream: { ready: false },
    tts: { ready: false },
  },
  canEnableLive: false,
  missing: ["tts"],
};

const ready = (liveVoiceEnabled: boolean): VoiceReadiness => ({
  ...notReady,
  liveVoiceEnabled,
  purposes: {
    transcription: notReady.purposes.transcription,
    stt_stream: {
      ready: true,
      providerName: "OpenAI (live voice)",
      model: "gpt-live-transcribe",
      scope: "tenant",
    },
    tts: { ready: true, providerName: "OpenAI (live voice)", model: "tts-1", scope: "tenant" },
  },
  canEnableLive: true,
  missing: [],
});

beforeEach(() => {
  readiness.mockReset();
  toastSuccess.mockReset();
  connectOpenAI.mockReset();
  setLive.mockReset();
  refresh.mockReset();
});

describe("LiveVoicePanel (D-77)", () => {
  it("shows what live voice needs, what is in place and where it comes from", async () => {
    readiness.mockResolvedValue(notReady);
    render(<LiveVoicePanel />);

    const item = await screen.findByText("Speech-to-text");
    expect(item.closest("li")).toHaveTextContent(
      "Ready · OpenAI (platform), whisper-1 · provided by the platform",
    );
    expect(screen.getByText("Interviewer's voice").closest("li")).toHaveTextContent("Not set up");
    expect(screen.getByText("Streaming captions").closest("li")).toHaveTextContent("(optional)");
    expect(screen.getByRole("switch", { name: "Live voice calls" })).not.toBeChecked();
  });

  it("asks for an OpenAI key when switched on without the routes, then connects and turns it on", async () => {
    readiness.mockResolvedValue(notReady);
    connectOpenAI.mockResolvedValue(ready(false));
    setLive.mockResolvedValue(ready(true));
    const user = userEvent.setup();
    render(<LiveVoicePanel />);

    await user.click(await screen.findByRole("switch", { name: "Live voice calls" }));

    const dialog = await screen.findByRole("dialog", { name: "Connect OpenAI for live voice" });
    expect(dialog).toHaveTextContent("$0.017 per minute");
    const key = screen.getByLabelText("OpenAI API key");
    expect(key).toHaveAttribute("type", "password");
    // Nothing is switched on before a key has been checked.
    expect(setLive).not.toHaveBeenCalled();

    await user.type(key, "sk-test-0123456789abcdefghij");
    await user.click(screen.getByRole("button", { name: "Check and connect" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(connectOpenAI).toHaveBeenCalledWith("sk-test-0123456789abcdefghij");
    expect(setLive).toHaveBeenCalledWith(true);
    expect(screen.getByRole("switch", { name: "Live voice calls" })).toBeChecked();
    expect(toastSuccess).toHaveBeenCalledWith("OpenAI is connected and live voice is on.");
    expect(refresh).toHaveBeenCalled();
  });

  it("shows a refused key inline, next to the field, and keeps the dialog open", async () => {
    readiness.mockResolvedValue(notReady);
    connectOpenAI.mockRejectedValue(
      new ApiError(422, "invalid_api_key", "OpenAI did not accept this API key"),
    );
    const user = userEvent.setup();
    render(<LiveVoicePanel />);

    await user.click(await screen.findByRole("switch", { name: "Live voice calls" }));
    const key = await screen.findByLabelText("OpenAI API key");
    await user.type(key, "sk-bad-0123456789abcdefghij");
    await user.click(screen.getByRole("button", { name: "Check and connect" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("OpenAI did not accept this key");
    expect(key).toHaveAttribute("aria-invalid", "true");
    expect(key.getAttribute("aria-describedby")).toContain(alert.id);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(setLive).not.toHaveBeenCalled();
  });

  it("switches straight on and off when everything is in place", async () => {
    readiness.mockResolvedValue(ready(false));
    setLive.mockResolvedValueOnce(ready(true)).mockResolvedValueOnce(ready(false));
    const user = userEvent.setup();
    render(<LiveVoicePanel />);
    const toggle = await screen.findByRole("switch", { name: "Live voice calls" });

    await user.click(toggle);
    await waitFor(() => {
      expect(toggle).toBeChecked();
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(toastSuccess).toHaveBeenCalledWith("Live voice is on.");

    await user.click(toggle);
    await waitFor(() => {
      expect(toggle).not.toBeChecked();
    });
    expect(setLive).toHaveBeenLastCalledWith(false);
  });

  it("opens the key dialog when the server says a route went missing since the page loaded", async () => {
    readiness.mockResolvedValue(ready(false));
    setLive.mockRejectedValue(new ApiError(409, "voice_not_ready", "missing", { missing: ["tts"] }));
    const user = userEvent.setup();
    render(<LiveVoicePanel />);

    await user.click(await screen.findByRole("switch", { name: "Live voice calls" }));

    expect(await screen.findByRole("dialog", { name: "Connect OpenAI for live voice" })).toBeInTheDocument();
    expect(screen.queryByText("Live voice is on.")).not.toBeInTheDocument();
  });

  it("offers streaming captions on their own, without turning anything on", async () => {
    readiness.mockResolvedValue({
      ...ready(true),
      purposes: { ...ready(true).purposes, stt_stream: { ready: false } },
    });
    connectOpenAI.mockResolvedValue(ready(true));
    const user = userEvent.setup();
    render(<LiveVoicePanel />);

    await user.click(await screen.findByRole("button", { name: "Add streaming captions" }));
    await user.type(await screen.findByLabelText("OpenAI API key"), "sk-test-0123456789abcdefghij");
    await user.click(screen.getByRole("button", { name: "Check and connect" }));

    await waitFor(() => {
      expect(connectOpenAI).toHaveBeenCalled();
    });
    expect(setLive).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith("OpenAI is connected.");
    });
  });

  it("warns when live voice is on but a required piece has gone, and offers to connect", async () => {
    readiness.mockResolvedValue({ ...notReady, liveVoiceEnabled: true });
    render(<LiveVoicePanel />);
    expect(await screen.findByText(/calls fall back to captions and recording/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect OpenAI" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add streaming captions" })).toBeNull();
  });

  it("does not warn while live voice is off", async () => {
    readiness.mockResolvedValue(notReady);
    render(<LiveVoicePanel />);
    expect(await screen.findByRole("button", { name: "Connect OpenAI" })).toBeInTheDocument();
    expect(screen.queryByText(/calls fall back to captions and recording/)).toBeNull();
  });

  it("says so when the status cannot be loaded", async () => {
    readiness.mockRejectedValue(new Error("down"));
    render(<LiveVoicePanel />);

    expect(await screen.findByText("The live voice status could not be loaded.")).toBeInTheDocument();
  });
});
