import { FACTOR_KEYS } from "@aidp/shared";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { OverrideSheet } from "@/components/admin/results/OverrideSheet";
import { CategoryForm } from "@/components/admin/settings/CategoryForm";
import { DirtyGuardProvider } from "@/components/common/DirtyGuard";
import { OpportunitySchema, type SettingsCatalogEntry } from "@/lib/api/schemas";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/api/browser", () => ({
  staffClient: { settings: { put: vi.fn() }, opportunities: { override: vi.fn() } },
  participantClient: {},
}));

const factors = Object.fromEntries(FACTOR_KEYS.map((k) => [k, { score: 3, rationale: "" }]));
const opportunity = OpportunitySchema.parse({
  id: "o1",
  title: "Triage tickets",
  solutionClass: "ai",
  factors,
  stats: { participants: 5, facts: 9 },
});

describe("override sheet", () => {
  it("asks before closing with edits, and Stay keeps the sheet open", async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(
      <DirtyGuardProvider>
        <OverrideSheet opportunity={opportunity} open onOpenChange={onOpenChange} onSaved={vi.fn()} />
      </DirtyGuardProvider>,
    );
    await user.type(screen.getByLabelText("Title"), "Better title");
    await user.keyboard("{Escape}");
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Leave without saving?")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Stay on this page" }));
    expect(screen.getByLabelText("Title")).toHaveValue("Better title");

    await user.keyboard("{Escape}");
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Leave" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("closes straight away when nothing was changed", async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(
      <DirtyGuardProvider>
        <OverrideSheet opportunity={opportunity} open onOpenChange={onOpenChange} onSaved={vi.fn()} />
      </DirtyGuardProvider>,
    );
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});

describe("settings category form", () => {
  const entries: SettingsCatalogEntry[] = [
    {
      key: "email.from",
      category: "email",
      description: "Envelope sender",
      default: "noreply@example.com",
      scopes: ["platform", "tenant"],
      secret: false,
    },
  ];

  it("prompts on unload only once a value was edited", async () => {
    const user = userEvent.setup();
    render(
      <DirtyGuardProvider>
        <CategoryForm
          category="email"
          title="Email"
          entries={entries}
          values={{}}
          effective={{}}
          secrets={{}}
          sources={{}}
          scope="tenant"
          scopeId={undefined}
        />
      </DirtyGuardProvider>,
    );
    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    await user.type(screen.getByRole("textbox"), "x");
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });
});
