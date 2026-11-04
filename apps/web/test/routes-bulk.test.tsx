import { NON_TEXT_PURPOSES, ROUTABLE_PURPOSES, type Route } from "@aidp/shared";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RoutesForm } from "@/components/admin/providers/RoutesForm";
import { setClientLocale } from "@/i18n";
import type { Provider, RouteRecord } from "@/lib/api/schemas";

/*
 * D-495: moving every text task to another provider is one step in Model assignment, and the step
 * knows nothing about which providers exist. Speech and similarity search keep their own routes,
 * and nothing is saved until the admin saves.
 */

const toastSuccess = vi.hoisted(() => vi.fn());
const staff = vi.hoisted(() => ({
  providers: { models: vi.fn() },
  operator: { providers: { models: vi.fn() }, routes: { put: vi.fn() } },
  routes: { put: vi.fn() },
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: Object.assign(vi.fn(), { success: toastSuccess, error: vi.fn() }),
  Toaster: () => null,
}));
vi.mock("@/lib/api/browser", () => ({ staffClient: staff, participantClient: {} }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), back: vi.fn() }),
  usePathname: () => "/admin/routes",
  useSearchParams: () => new URLSearchParams(),
}));

const provider = (over: Partial<Provider>): Provider => ({
  id: "p1",
  kind: "openrouter",
  name: "OpenRouter",
  enabled: true,
  hasKey: true,
  companyId: "c1",
  ...over,
});

const providers = [
  provider({ id: "p-or", kind: "openrouter", name: "OpenRouter" }),
  provider({ id: "p-meta", kind: "meta", name: "Meta Muse" }),
  provider({ id: "p-local", kind: "local", name: "On this server", hasKey: false }),
];

const routes: RouteRecord[] = [
  {
    companyId: "c1",
    purpose: "interview_turn",
    providerId: "p-or",
    model: "vendor/fast",
    effort: "low",
    maxOutputTokens: 4096,
    batchAllowed: false,
  },
  {
    companyId: "c1",
    purpose: "transcription",
    providerId: "p-local",
    model: "whisper-small",
    maxOutputTokens: 0,
    batchAllowed: false,
  },
];

beforeEach(() => {
  vi.resetAllMocks();
  setClientLocale("en");
  staff.providers.models.mockImplementation(async (id: string) => ({
    models: id === "p-meta" ? [{ id: "muse-spark-1.3", name: "Muse Spark 1.3" }] : [],
  }));
  staff.routes.put.mockResolvedValue(undefined);
});

async function pick(user: ReturnType<typeof userEvent.setup>, trigger: RegExp, option: RegExp) {
  await user.click(screen.getByRole("button", { name: trigger }));
  await user.click(await screen.findByRole("option", { name: option }));
}

describe("use one provider for every text task", () => {
  it("offers every language provider and none that only does audio", async () => {
    const user = userEvent.setup();
    render(<RoutesForm routes={routes} providers={providers} scope="tenant" companyId="c1" />);
    await user.click(screen.getByRole("button", { name: /Use one provider for every text task: Provider/ }));
    const names = (await screen.findAllByRole("option")).map((o) => o.textContent ?? "");
    expect(names.some((n) => n.includes("OpenRouter"))).toBe(true);
    expect(names.some((n) => n.includes("Meta Muse"))).toBe(true);
    expect(names.some((n) => n.includes("On this server"))).toBe(false);
  });

  it("moves every text task to the chosen provider and model, keeps speech, and saves only on Save", async () => {
    const user = userEvent.setup();
    render(<RoutesForm routes={routes} providers={providers} scope="tenant" companyId="c1" />);
    const apply = screen.getByRole("button", { name: "Apply to all text tasks" });
    expect(apply).toBeDisabled();

    await pick(user, /Use one provider for every text task: Provider/, /Meta Muse/);
    await pick(user, /Use one provider for every text task: Model/, /Muse Spark 1\.3/);
    await user.click(apply);
    expect(toastSuccess).toHaveBeenCalled();
    expect(staff.routes.put).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Save assignments" }));
    await waitFor(() => {
      expect(staff.routes.put).toHaveBeenCalledTimes(1);
    });
    const sent = staff.routes.put.mock.calls[0]![0] as Route[];
    const byPurpose = new Map(sent.map((r) => [r.purpose, r]));
    for (const p of ROUTABLE_PURPOSES.filter((x) => !NON_TEXT_PURPOSES.has(x)))
      expect(byPurpose.get(p)).toMatchObject({ providerId: "p-meta", model: "muse-spark-1.3" });
    // The task's own effort survives the switch; speech stays on the server.
    expect(byPurpose.get("interview_turn")).toMatchObject({ effort: "low", maxOutputTokens: 4096 });
    expect(byPurpose.get("transcription")).toMatchObject({ providerId: "p-local", model: "whisper-small" });
  });
});
