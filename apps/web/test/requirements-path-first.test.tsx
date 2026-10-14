import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { ConversationPane } from "@/components/admin/requirements/ConversationPane";
import { setClientLocale } from "@/i18n";
import type { ParticipantApi } from "@/lib/api/participant";
import { ParticipantSessionSchema } from "@/lib/api/schemas";

/*
 * Simulation 2026-10-15: a requirements interview started from a discovery opportunity has no
 * path, and the workspace started the first turn anyway, so the owner read "Something went wrong:
 * Choose a path before the first turn". The pane now asks for the path first.
 */
describe("a requirements interview without a path", () => {
  it("asks how technical to be before the first turn, then starts with the chosen path", async () => {
    setClientLocale("en");
    const never = (): Promise<never> => new Promise<never>(() => undefined);
    const api = { sendTurn: vi.fn(never), sendControl: vi.fn(never), sendVoice: vi.fn(never) };
    const onSetPath = vi.fn(() => Promise.resolve());
    const initial = ParticipantSessionSchema.parse({ id: "s1", status: "created", path: null, messages: [] });
    render(
      <ConversationPane
        api={api as unknown as ParticipantApi}
        initial={initial}
        title="No-show calls"
        onSpec={vi.fn()}
        onSetPath={onSetPath}
        onReopen={vi.fn(() => Promise.resolve())}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "How technical should this conversation be?" }),
    ).toBeInTheDocument();
    expect(api.sendTurn).not.toHaveBeenCalled();
    await userEvent.setup().click(screen.getByRole("button", { name: /I'm not technical/ }));
    expect(onSetPath).toHaveBeenCalledWith("nontechnical");
    await waitFor(() => {
      expect(screen.getByRole("group", { name: "Interview path" })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Nontechnical" })).toHaveAttribute("aria-pressed", "true");
  });
});
