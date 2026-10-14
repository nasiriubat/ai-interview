import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetsPanel } from "@/components/admin/providers/BudgetsPanel";
import { ProvidersPanel } from "@/components/admin/providers/ProvidersPanel";
import { RoutesForm } from "@/components/admin/providers/RoutesForm";
import { setClientLocale } from "@/i18n";
import type { BudgetRecord, Provider, RouteRecord } from "@/lib/api/schemas";

/*
 * Providers, routes and budgets after the polish pass (D-110, D-236): the connection test says it
 * worked, a budget shows how much of it is spent, and the model assignment is a list of cards where
 * a table would scroll sideways. Plus the two rules that keep the styling from drifting back.
 */

const toastSuccess = vi.hoisted(() => vi.fn());
const staff = vi.hoisted(() => ({
  providers: { test: vi.fn(), update: vi.fn(), remove: vi.fn(), models: vi.fn(), create: vi.fn() },
  operator: { providers: {}, routes: { put: vi.fn() } },
  routes: { put: vi.fn() },
  budgets: { create: vi.fn(), remove: vi.fn() },
  settings: { scopes: vi.fn() },
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: Object.assign(vi.fn(), { success: toastSuccess, error: vi.fn() }),
  Toaster: () => null,
}));
vi.mock("@/lib/api/browser", () => ({ staffClient: staff, participantClient: {} }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), back: vi.fn() }),
  usePathname: () => "/admin/providers",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const provider = (over: Partial<Provider> = {}): Provider => ({
  id: "p1",
  kind: "anthropic",
  name: "Anthropic",
  enabled: true,
  hasKey: true,
  companyId: "c1",
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  setClientLocale("en");
  staff.providers.models.mockResolvedValue({ models: [] });
  staff.settings.scopes.mockResolvedValue([]);
});

describe("testing a provider connection", () => {
  it("says it once in a toast on success and keeps the result beside the row", async () => {
    staff.providers.test.mockResolvedValue({
      ok: true,
      latencyMs: 420,
      tokens: 12,
      costCents: 0.1,
      model: "m-1",
    });
    const user = userEvent.setup();
    render(<ProvidersPanel providers={[provider()]} scope="tenant" />);
    await user.click(screen.getByRole("button", { name: "Test: Anthropic" }));
    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith("Connected to Anthropic · m-1 · 420 ms");
    });
    expect(await screen.findByText(/420 ms/, { selector: "span[role=status]" })).toBeInTheDocument();
  });

  it("shows nothing in a toast on failure: the reason stays where it can be read", async () => {
    staff.providers.test.mockResolvedValue({ ok: false, error: "401 invalid key" });
    const user = userEvent.setup();
    render(<ProvidersPanel providers={[provider()]} scope="tenant" />);
    await user.click(screen.getByRole("button", { name: "Test: Anthropic" }));
    expect(await screen.findByText(/401 invalid key/)).toBeInTheDocument();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("announces that the test is running", async () => {
    let resolve: (v: unknown) => void = () => undefined;
    staff.providers.test.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const user = userEvent.setup();
    render(<ProvidersPanel providers={[provider()]} scope="tenant" />);
    await user.click(screen.getByRole("button", { name: "Test: Anthropic" }));
    expect(await screen.findByText("Testing…", { selector: "span[role=status]" })).toBeInTheDocument();
    resolve({ ok: true, latencyMs: 1, tokens: 1, costCents: 0 });
  });
});

describe("budgets show how much is spent", () => {
  const budget = (over: Partial<BudgetRecord>): BudgetRecord => ({
    id: "b1",
    scope: "campaign",
    scopeId: "camp1",
    limitCents: 10000,
    period: "total",
    ...over,
  });

  it("draws a bar with the figures in words, amber from 80 percent, red at the limit", () => {
    render(
      <BudgetsPanel
        companyId="c1"
        budgets={[
          budget({ id: "b1", scopeId: "camp1", spentCents: 2500 }),
          budget({ id: "b2", scopeId: "camp2", spentCents: 8500 }),
          budget({ id: "b3", scopeId: "camp3", spentCents: 12000 }),
        ]}
      />,
    );
    const bars = screen.getAllByRole("progressbar");
    expect(bars.map((b) => b.getAttribute("aria-valuenow"))).toEqual(["25", "85", "100"]);
    expect(bars[0]).toHaveAttribute("aria-valuetext", expect.stringContaining("€25.00"));
    expect(bars[0]?.firstElementChild?.className).toContain("bg-primary");
    expect(bars[1]?.firstElementChild?.className).toContain("bg-warning");
    expect(bars[2]?.firstElementChild?.className).toContain("bg-destructive");
  });

  it("has no bar for a budget with no figure yet, or a limit of nothing", () => {
    render(
      <BudgetsPanel
        companyId="c1"
        budgets={[budget({ id: "b1" }), budget({ id: "b2", scopeId: "x", spentCents: 5, limitCents: 0 })]}
      />,
    );
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });
});

describe("model assignment on a phone", () => {
  const routes: RouteRecord[] = [
    {
      companyId: "c1",
      purpose: "interview_turn",
      providerId: "p1",
      model: "m-1",
      maxOutputTokens: 2048,
      batchAllowed: false,
    },
  ];

  const matchMedia = (narrow: boolean) =>
    vi.fn().mockImplementation((query: string) => ({
      matches: narrow && query.includes("max-width: 767px"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));

  it("is a table where there is room", () => {
    vi.stubGlobal("matchMedia", matchMedia(false));
    render(<RoutesForm routes={routes} providers={[provider()]} scope="tenant" companyId="c1" />);
    expect(screen.getByRole("table")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("is one card per task on a narrow screen, with every control still named", () => {
    vi.stubGlobal("matchMedia", matchMedia(true));
    render(<RoutesForm routes={routes} providers={[provider()]} scope="tenant" companyId="c1" />);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    const cards = screen.getAllByRole("listitem");
    expect(cards.length).toBeGreaterThan(3);
    const first = within(cards[0]!);
    expect(first.getByRole("heading", { level: 3 })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Provider: / })[0]).toBeInTheDocument();
    expect(screen.getAllByRole("spinbutton", { name: /Max output tokens: / })[0]).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});

/* ---- the two rules that keep the pass from being undone ---- */

const SRC = path.resolve(import.meta.dirname, "../src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}
const files = walk(SRC).filter((f) => f.endsWith(".tsx"));
const rel = (f: string): string => path.relative(SRC, f);

describe("typography", () => {
  /**
   * Files that other work in flight owns; remove an entry when its file is converted. Nothing else
   * may set a size under 12px, which is the floor of the scale (ux-design 3.7).
   */
  const PENDING = new Set(["components/admin/results/FactorBars.tsx"]);

  it("has no text below 12px", () => {
    const offenders = files
      .filter((f) => !PENDING.has(rel(f)))
      .flatMap((f) =>
        (readFileSync(f, "utf8").match(/text-\[(?:[0-9]|1[01])(?:\.\d+)?px\]/g) ?? []).map(
          (m) => `${rel(f)} ${m}`,
        ),
      );
    expect(offenders).toEqual([]);
  });
});

describe("boxes", () => {
  /**
   * A bordered box is `rounded-* border` with padding: a 1.2:1 line around content that needed
   * none (D-110). Controls, badges and chips are not boxes. Files named here belong to work in
   * flight (the results workspace, the requirements version page, the report); each is removed
   * from the list when it is converted.
   */
  const PENDING = new Set([
    "components/admin/results/OverrideSheet.tsx",
    "components/admin/results/WeightsPanel.tsx",
    "components/admin/results/MergeBar.tsx",
    "components/admin/requirements/DiagramsPanel.tsx",
    "components/admin/results/SplitDialog.tsx",
    "components/admin/requirements/VersionView.tsx",
    "components/admin/requirements/VersionDiff.tsx",
    "components/report/MermaidDiagram.tsx",
    "components/report/ReportView.tsx",
    "components/admin/SetupChecklist.tsx",
  ]);
  const NOT_BOXES = new Set([
    "components/ui/badge.tsx",
    "components/ui/radio-group.tsx",
    "components/ui/switch.tsx",
  ]);

  it("uses Inset, Card, Panel or ChoiceTile instead of a bordered box", () => {
    const offenders = files
      .filter((f) => !PENDING.has(rel(f)) && !NOT_BOXES.has(rel(f)))
      .flatMap((f) =>
        readFileSync(f, "utf8")
          .split("\n")
          .map((line, i) => ({ line, n: i + 1 }))
          .filter(({ line }) => /rounded(-[a-z0-9]+)? border( |"|`)/.test(line) && !line.includes("border-0"))
          // The comment that explains the rule quotes the pattern.
          .filter(({ line }) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
          .map(({ n }) => `${rel(f)}:${String(n)}`),
      );
    expect(offenders).toEqual([]);
  });
});
