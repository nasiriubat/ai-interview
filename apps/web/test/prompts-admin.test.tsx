import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PromptDiff } from "@/components/admin/prompts/PromptDiff";
import { PromptWorkspace } from "@/components/admin/prompts/PromptWorkspace";
import { PromptsTable } from "@/components/admin/prompts/PromptsTable";
import { en } from "@/i18n/en";
import { fi } from "@/i18n/fi";
import { setClientLocale } from "@/i18n";
import { countChanges, diffLines, foldUnchanged } from "@/lib/admin/lineDiff";
import { checkLines, issueText } from "@/lib/admin/promptIssues";
import type { PromptCheck, PromptDetail, PromptSummary, PromptVersion } from "@/lib/api/schemas";

/*
 * Prompt administration screens (D-233 to D-235): the list, the editor with its live checks, the
 * comparison, and the controls that change what participants get.
 */

const check = vi.fn();
const create = vi.fn();
const activate = vi.fn();
const stopCanary = vi.fn();
const rollback = vi.fn();
const reset = vi.fn();
const refresh = vi.fn();

vi.mock("@/lib/api/browser", () => ({
  staffClient: {
    prompts: {
      check: (...a: unknown[]): unknown => check(...a),
      create: (...a: unknown[]): unknown => create(...a),
      activate: (...a: unknown[]): unknown => activate(...a),
      stopCanary: (...a: unknown[]): unknown => stopCanary(...a),
      rollback: (...a: unknown[]): unknown => rollback(...a),
      reset: (...a: unknown[]): unknown => reset(...a),
    },
  },
  participantClient: {},
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn(), back: vi.fn() }),
  usePathname: () => "/admin/prompts/interviewer",
  useSearchParams: () => new URLSearchParams(),
}));

const SHIPPED = "Line one\nWarm, brief, specific.\n{{objective}}\nLine four";
const OK_CHECK: PromptCheck = { ok: true, issues: [], renders: [] };

const stats = { calls: 0, errors: 0, errorRate: 0, meanLatencyMs: 0, meanCostCents: 0 };
const version = (over: Partial<PromptVersion> & Pick<PromptVersion, "version">): PromptVersion => ({
  tag: `interviewer@t${String(over.version)}`,
  note: null,
  body: SHIPPED,
  state: "inactive",
  canaryShare: 0,
  parentVersion: null,
  createdAt: "2026-10-10T10:00:00.000Z",
  createdBy: { id: "u1", name: "Aino", email: "aino@acme.fi" },
  activatedAt: null,
  deactivatedAt: null,
  stats,
  ...over,
});

const detail = (over: Partial<PromptDetail> = {}): PromptDetail => ({
  key: "interviewer",
  group: "interview",
  shipped: { version: 5, tag: "interviewer@5", body: SHIPPED, stats },
  contract: {
    requiredPlaceholders: ["objective"],
    untrustedRules: true,
    contractTokens: ["<<<TURN_META>>>"],
    maxChars: 30000,
  },
  effective: { source: "shipped", version: 5, tag: "interviewer@5" },
  canary: null,
  platform: null,
  versions: [],
  windowDays: 30,
  ...over,
});

beforeEach(() => {
  for (const m of [check, create, activate, stopCanary, rollback, reset, refresh]) m.mockReset();
  check.mockResolvedValue(OK_CHECK);
  for (const m of [activate, stopCanary, rollback, reset]) m.mockResolvedValue(undefined);
  create.mockResolvedValue(version({ version: 1 }));
});
afterEach(() => {
  setClientLocale("en");
});

describe("line diff", () => {
  it("marks one changed line and keeps the rest", () => {
    const lines = diffLines(SHIPPED, SHIPPED.replace("Warm, brief, specific.", "Warm."));
    expect(countChanges(lines)).toEqual({ added: 1, removed: 1 });
    expect(lines.filter((l) => l.type === "same").map((l) => l.text)).toEqual([
      "Line one",
      "{{objective}}",
      "Line four",
    ]);
  });

  it("reports no change for identical text and handles CRLF", () => {
    expect(countChanges(diffLines("a\r\nb", "a\nb"))).toEqual({ added: 0, removed: 0 });
  });

  it("folds long unchanged runs and keeps context around a change", () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${String(i)}`).join("\n");
    const folded = foldUnchanged(diffLines(text, text.replace("line 15", "changed")), 2);
    const kinds = folded.map((l) => l.type);
    expect(kinds.filter((k) => k === "fold")).toHaveLength(2);
    expect(folded.filter((l) => l.type === "add" || l.type === "del")).toHaveLength(2);
    // Two lines of context on each side of the change.
    expect(folded.filter((l) => l.type === "same")).toHaveLength(4);
  });
});

describe("PromptDiff", () => {
  it("shows + and − marks and names the change for a screen reader, not by colour alone", () => {
    render(<PromptDiff lines={diffLines("a\nb\nc", "a\nB\nc")} />);
    const region = screen.getByRole("region", { name: "Line by line comparison" });
    expect(within(region).getByText("+")).toBeInTheDocument();
    expect(within(region).getByText("−")).toBeInTheDocument();
    expect(region).toHaveTextContent("Added: B");
    expect(region).toHaveTextContent("Removed: b");
    expect(region).toHaveAttribute("tabindex", "0");
  });

  it("says so when there is no difference", () => {
    render(<PromptDiff lines={diffLines("a", "a")} />);
    expect(screen.getByText("No difference.")).toBeInTheDocument();
  });
});

describe("reasons are shown in the reader's language", () => {
  it("never shows the API's English message", () => {
    const issue = { code: "missing_placeholder", detail: "{{areas}}", message: "API ENGLISH TEXT" };
    expect(issueText(issue, 30000)).toBe(
      "{{areas}} is missing. The interviewer fills it in for every interview, so the prompt must keep it.",
    );
    setClientLocale("fi");
    expect(issueText(issue, 30000)).toContain("{{areas}} puuttuu");
    expect(issueText(issue, 30000)).not.toContain("API ENGLISH TEXT");
  });

  it("turns each contract code and each rendering failure into a line", () => {
    const lines = checkLines(
      {
        ok: false,
        issues: [
          { code: "missing_untrusted_rules", message: "" },
          { code: "missing_contract_token", detail: "<<<TURN_META>>>", message: "" },
          { code: "something_new", message: "" },
        ],
        renders: [
          { template: "discovery", ok: false, leftover: ["objective"], chars: 10 },
          { template: "requirements", ok: true, leftover: [], chars: 900 },
        ],
      },
      30000,
    );
    expect(lines.map((l) => l.ok)).toEqual([false, false, false, false, true]);
    expect(lines[3]?.text).toContain("{{objective}}");
    expect(lines[2]?.text).toBe("This prompt cannot be used.");
  });

  it("has every prompt key named in both languages", () => {
    const keys = Object.keys(en.admin.prompts.names);
    expect(Object.keys(fi.admin.prompts.names).sort()).toEqual(keys.sort());
    for (const k of keys) {
      expect(fi.admin.prompts.names[k as keyof typeof fi.admin.prompts.names].name).not.toBe("");
    }
  });
});

describe("PromptsTable", () => {
  const summary = (over: Partial<PromptSummary> & Pick<PromptSummary, "key">): PromptSummary => ({
    group: "interview",
    shipped: { version: 5, tag: `${over.key}@5`, chars: 6000 },
    effective: { source: "shipped", version: 5, tag: `${over.key}@5` },
    canary: null,
    versions: 0,
    stats,
    ...over,
  });

  it("groups prompts, labels the source and shows a canary with its share", () => {
    render(
      <PromptsTable
        windowDays={30}
        prompts={[
          summary({
            key: "interviewer",
            effective: { source: "tenant", version: 3, tag: "interviewer@t3" },
            canary: { version: 4, share: 0.1 },
            stats: { ...stats, calls: 40, errors: 2, errorRate: 0.05 },
          }),
          summary({ key: "clustering", group: "analysis" }),
        ]}
      />,
    );
    expect(screen.getByRole("heading", { name: "Interview" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Analysis" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Interviewer" })).toHaveAttribute(
      "href",
      "/admin/prompts/interviewer",
    );
    expect(screen.getByText("Yours")).toBeInTheDocument();
    expect(screen.getByText("Canary 10 %")).toBeInTheDocument();
    expect(screen.getByText("interviewer@t3")).toBeInTheDocument();
    expect(screen.getByText("40")).toBeInTheDocument();
  });
});

describe("PromptWorkspace", () => {
  it("opens with the warning, the built-in text, and checks that must pass before saving", async () => {
    const user = userEvent.setup();
    render(<PromptWorkspace detail={detail()} />);
    expect(screen.getByText("Changing a prompt changes every interview that uses it")).toBeInTheDocument();
    expect(screen.getByText(/evals\/README\.md/)).toBeInTheDocument();
    const body = screen.getByRole("textbox", { name: "Prompt text" });
    expect(body).toHaveValue(SHIPPED);
    await waitFor(() => {
      expect(check).toHaveBeenCalledWith("interviewer", SHIPPED);
    });
    // Unchanged text: nothing to save, and the button says why.
    expect(screen.getByRole("button", { name: "Save as new version" })).toBeDisabled();
    expect(screen.getByText("The text is the same as the version it starts from.")).toBeInTheDocument();

    await user.type(body, " more");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save as new version" })).toBeEnabled();
    });
  });

  it("shows a failing check in words, marks the field invalid and blocks saving", async () => {
    check.mockResolvedValue({
      ok: false,
      issues: [{ code: "missing_placeholder", detail: "{{objective}}", message: "x" }],
      renders: [],
    } satisfies PromptCheck);
    const user = userEvent.setup();
    render(<PromptWorkspace detail={detail()} />);
    await user.type(screen.getByRole("textbox", { name: "Prompt text" }), "!");
    expect(await screen.findByText(/\{\{objective\}\} is missing/)).toBeInTheDocument();
    expect(screen.getByText("1 check failed")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Prompt text" })).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Save as new version" })).toBeDisabled();
  });

  it("says the checks could not be run instead of passing silently", async () => {
    check.mockRejectedValue(new Error("offline"));
    render(<PromptWorkspace detail={detail()} />);
    expect(await screen.findByText(/checks could not be run/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save as new version" })).toBeDisabled();
  });

  it("saves a new version with its note and parent, and does not activate it", async () => {
    const user = userEvent.setup();
    const own = version({ version: 2, state: "stable", canaryShare: 1, body: "Mine {{objective}}" });
    render(<PromptWorkspace detail={detail({ versions: [own] })} />);
    // Starts from the version in use.
    const body = screen.getByRole("textbox", { name: "Prompt text" });
    expect(body).toHaveValue("Mine {{objective}}");
    await user.type(body, " plainer");
    await user.type(screen.getByRole("textbox", { name: "What this changes" }), "Plainer");
    const save = screen.getByRole("button", { name: "Save as new version" });
    await waitFor(() => {
      expect(save).toBeEnabled();
    });
    await user.click(save);
    await waitFor(() => {
      expect(create).toHaveBeenCalledWith("interviewer", {
        body: "Mine {{objective}} plainer",
        note: "Plainer",
        parentVersion: 2,
      });
    });
    expect(activate).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalled();
  });

  it("starts a canary from the slider and sends the share as a fraction", async () => {
    const user = userEvent.setup();
    render(<PromptWorkspace detail={detail({ versions: [version({ version: 1 })] })} />);
    await user.click(screen.getByRole("button", { name: "Use version 1" }));
    const dialog = await screen.findByRole("dialog", { name: "Use version 1" });
    const number = within(dialog).getByRole("spinbutton", { name: "Percent" });
    const slider = within(dialog).getByRole("slider", { name: "Share of new interviews" });
    expect(number).toHaveValue(10);
    expect(slider).toHaveValue("10");
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "About 10 % of new interviews use version 1",
    );
    // The number and the slider are one value.
    await user.clear(number);
    await user.type(number, "35");
    expect(slider).toHaveValue("35");
    await user.click(within(dialog).getByRole("button", { name: "Use this version" }));
    await waitFor(() => {
      expect(activate).toHaveBeenCalledWith("interviewer", 1, 0.35);
    });
  });

  it("makes a version the one in use at 100 %, in words that say everyone gets it", async () => {
    const user = userEvent.setup();
    render(<PromptWorkspace detail={detail({ versions: [version({ version: 1 })] })} />);
    await user.click(screen.getByRole("button", { name: "Use version 1" }));
    const dialog = await screen.findByRole("dialog");
    const number = within(dialog).getByRole("spinbutton", { name: "Percent" });
    await user.clear(number);
    await user.type(number, "100");
    expect(within(dialog).getByRole("status")).toHaveTextContent("Every new interview uses version 1");
    await user.click(within(dialog).getByRole("button", { name: "Use this version" }));
    await waitFor(() => {
      expect(activate).toHaveBeenCalledWith("interviewer", 1, 1);
    });
  });

  it("clamps the percent to 1..100", async () => {
    const user = userEvent.setup();
    render(<PromptWorkspace detail={detail({ versions: [version({ version: 1 })] })} />);
    await user.click(screen.getByRole("button", { name: "Use version 1" }));
    const dialog = await screen.findByRole("dialog");
    const number = within(dialog).getByRole("spinbutton", { name: "Percent" });
    await user.clear(number);
    await user.type(number, "250");
    // Still being typed: the slider keeps the last valid value.
    expect(within(dialog).getByRole("slider")).toHaveValue("25");
    await user.tab();
    expect(number).toHaveValue(100);
    await user.clear(number);
    await user.type(number, "0");
    await user.tab();
    expect(number).toHaveValue(1);
  });

  it("asks before stopping a canary, before rolling back and before resetting", async () => {
    const user = userEvent.setup();
    const stable = version({
      version: 1,
      state: "stable",
      canaryShare: 1,
      activatedAt: "2026-10-11T00:00:00.000Z",
    });
    const previous = version({
      version: 2,
      state: "inactive",
      canaryShare: 1,
      deactivatedAt: "2026-10-12T00:00:00.000Z",
    });
    const canary = version({ version: 3, state: "canary", canaryShare: 0.2 });
    render(
      <PromptWorkspace
        detail={detail({
          effective: { source: "tenant", version: 1, tag: "interviewer@t1" },
          canary: { version: 3, share: 0.2 },
          versions: [canary, previous, stable],
        })}
      />,
    );
    expect(screen.getByText(/Your version 3 is a canary: about 20 %/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Stop canary" }));
    let dialog = await screen.findByRole("alertdialog", { name: "Stop the canary?" });
    expect(stopCanary).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Stop canary" }));
    await waitFor(() => {
      expect(stopCanary).toHaveBeenCalledWith("interviewer");
    });

    await user.click(screen.getByRole("button", { name: "Roll back" }));
    dialog = await screen.findByRole("alertdialog", { name: "Go back to the earlier version?" });
    await user.click(within(dialog).getByRole("button", { name: "Roll back" }));
    await waitFor(() => {
      expect(rollback).toHaveBeenCalledWith("interviewer");
    });

    await user.click(screen.getByRole("button", { name: "Use the built-in prompt" }));
    dialog = await screen.findByRole("alertdialog", { name: "Switch back to the built-in prompt?" });
    await user.click(within(dialog).getByRole("button", { name: "Use built-in prompt" }));
    await waitFor(() => {
      expect(reset).toHaveBeenCalledWith("interviewer");
    });
  });

  it("offers neither rollback nor reset when nothing of yours is in use", () => {
    render(<PromptWorkspace detail={detail()} />);
    expect(screen.getByRole("button", { name: "Roll back" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Use the built-in prompt" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Stop canary" })).not.toBeInTheDocument();
  });

  it("compares a saved version with the built-in prompt from its row", async () => {
    const user = userEvent.setup();
    const v = version({ version: 1, body: SHIPPED.replace("Warm, brief, specific.", "Short and plain.") });
    render(<PromptWorkspace detail={detail({ versions: [v] })} />);
    await user.click(screen.getByRole("button", { name: "Compare version 1 with the built-in prompt" }));
    const region = screen.getByRole("region", { name: "Line by line comparison" });
    expect(region).toHaveTextContent("Short and plain.");
    expect(region).toHaveTextContent("Warm, brief, specific.");
    expect(screen.getByText("1 added, 1 removed")).toBeInTheDocument();
  });

  it("renders in Finnish with no English left in the controls", async () => {
    setClientLocale("fi");
    render(<PromptWorkspace detail={detail({ versions: [version({ version: 1 })] })} />);
    expect(
      screen.getByText("Kehotteen muutos koskee kaikkia sitä käyttäviä haastatteluja"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tallenna uutena versiona" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ota käyttöön versio 1" })).toBeInTheDocument();
    expect(screen.queryByText("Save as new version")).not.toBeInTheDocument();
  });
});
