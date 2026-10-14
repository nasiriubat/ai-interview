import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionMenu } from "@/components/participant/SessionMenu";
import { en } from "@/i18n/en";
import { fi } from "@/i18n/fi";

/** "Download my data" on the participant session menu (GDPR Art. 15 and 20, D-162). */
describe("download my data", () => {
  const originalFetch = globalThis.fetch;
  const created: string[] = [];

  beforeEach(() => {
    created.length = 0;
    URL.createObjectURL = vi.fn(() => {
      created.push("blob:test");
      return "blob:test";
    });
    URL.revokeObjectURL = vi.fn();
    // jsdom cannot navigate to a blob; the click is what the browser would turn into a save.
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const open = async (user: ReturnType<typeof userEvent.setup>): Promise<void> => {
    render(<SessionMenu onPause={vi.fn()} onDone={vi.fn()} onDelete={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Interview options" }));
  };

  it("fetches the readable copy through the proxy, saves it, and says so", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response("# Your data", { status: 200 })));
    globalThis.fetch = fetchMock;
    const user = userEvent.setup();
    await open(user);
    await user.click(screen.getByRole("button", { name: "Download my data (readable)" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/participant/p/session/export?format=md",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Your data was downloaded."));
    expect(created).toHaveLength(1);
  });

  it("asks for JSON when that is chosen", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })));
    globalThis.fetch = fetchMock;
    const user = userEvent.setup();
    await open(user);
    await user.click(screen.getByRole("button", { name: "Download my data (JSON)" }));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/participant/p/session/export?format=json",
      expect.anything(),
    );
  });

  it("says plainly when the copy could not be prepared, and saves nothing", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response("{}", { status: 429 })),
    );
    const user = userEvent.setup();
    await open(user);
    await user.click(screen.getByRole("button", { name: "Download my data (readable)" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/could not prepare/));
    expect(created).toHaveLength(0);
  });

  it("has the strings in both languages", () => {
    for (const s of [en.participant.session, fi.participant.session]) {
      expect(s.downloadReadable.length).toBeGreaterThan(0);
      expect(s.downloadJson.length).toBeGreaterThan(0);
      expect(s.downloadFailed.length).toBeGreaterThan(0);
    }
  });
});
