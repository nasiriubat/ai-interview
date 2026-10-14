import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CampaignForm } from "@/components/admin/campaigns/CampaignForm";
import { RequirementsForm } from "@/components/admin/requirements/RequirementsForm";
import { ScopePicker } from "@/components/admin/settings/ScopePicker";
import { emptyTemplate, TemplateForm } from "@/components/admin/templates/TemplateForm";
import { DirtyGuardProvider } from "@/components/common/DirtyGuard";
import { ArrivalFlow } from "@/components/participant/ArrivalFlow";
import { setClientLocale } from "@/i18n";
import { locateTemplateIssue, templateIssues } from "@/lib/admin/templateIssues";
import { countBySection, issueMessage } from "@/lib/admin/validation";
import { ApiError } from "@/lib/api/errors";
import type { ParticipantApi } from "@/lib/api/participant";

const push = vi.fn();
const back = vi.fn();
const scopes = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, back, refresh: vi.fn() }),
  usePathname: () => "/admin/templates/new",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/api/browser", () => ({
  staffClient: {
    templates: { create: vi.fn(), update: vi.fn() },
    campaigns: { create: vi.fn() },
    requirements: { create: vi.fn() },
    settings: { scopes: (...a: unknown[]): unknown => scopes(...a) },
  },
  participantClient: {},
}));

beforeEach(() => {
  push.mockReset();
  back.mockReset();
  scopes.mockReset();
  scopes.mockResolvedValue([{ id: "c1", name: "Q3 survey" }]);
  setClientLocale("en");
});

afterEach(() => {
  setClientLocale("en");
});

describe("issueMessage", () => {
  it("says what is wrong in words, not in the schema's", () => {
    expect(issueMessage({ code: "too_small", origin: "string", minimum: 1, message: "x" })).toBe(
      "This field is required.",
    );
    expect(issueMessage({ code: "too_small", origin: "string", minimum: 20, message: "x" })).toBe(
      "Use at least 20 characters.",
    );
    expect(issueMessage({ code: "too_big", origin: "number", maximum: 500, message: "x" })).toBe(
      "Must be 500 or less.",
    );
    expect(issueMessage({ code: "invalid_type", input: undefined, message: "x" })).toBe(
      "This field is required.",
    );
    expect(issueMessage({ code: "custom", message: "Keep this text" })).toBe("Keep this text");
  });

  it("follows the language", () => {
    setClientLocale("fi");
    expect(issueMessage({ code: "too_small", origin: "string", minimum: 1, message: "x" })).toBe(
      "Tämä kenttä on pakollinen.",
    );
  });
});

describe("template issues point at the control the editor renders", () => {
  it("maps list items, nested policies and plain fields to element ids and sections", () => {
    expect(locateTemplateIssue(["coverageAreas", 1, "key"])).toMatchObject({
      id: "ca-1-key",
      section: "areas",
      item: 2,
    });
    expect(locateTemplateIssue(["contextBlock", 0, "question"])).toMatchObject({
      id: "cq-0-q",
      section: "context",
    });
    expect(locateTemplateIssue(["widgetPolicy", "maxPerTurns"])).toMatchObject({
      id: "widgetMaxPerTurns",
      section: "widgets",
    });
    expect(locateTemplateIssue(["objective"])).toMatchObject({ id: "objective", section: "basics" });
    // A list-level problem has no control of its own: it points at the section.
    expect(locateTemplateIssue(["coverageAreas"])).toMatchObject({ id: "section-areas" });
  });

  it("names each problem by place and counts them per section", () => {
    const issues = templateIssues([
      { path: ["coverageAreas", 1, "key"], code: "too_small", message: "x" },
      { path: ["coverageAreas", 1, "key"], code: "too_big", message: "dup" },
      { path: ["name"], code: "too_small", message: "x" },
    ]);
    expect(issues.map((i) => i.label)).toEqual(["Topics: Key 2", "Basics: Name"]);
    expect(countBySection(issues)).toEqual({ areas: 1, basics: 1 });
  });
});

function renderGuarded(ui: React.ReactElement): void {
  render(
    <DirtyGuardProvider>
      <a href="/admin/campaigns">Campaigns</a>
      {ui}
    </DirtyGuardProvider>,
  );
}

describe("template form validation", () => {
  it("lists the problems, counts them per section, and puts focus on the first invalid field", async () => {
    const user = userEvent.setup();
    renderGuarded(<TemplateForm initial={emptyTemplate} />);
    await user.click(screen.getByRole("button", { name: "Create" }));

    const summary = await screen.findByText(/problems to fix/);
    expect(summary).toBeInTheDocument();
    // Key, name and objective are empty in a blank template.
    expect(screen.getByRole("link", { name: "Basics: Key" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Basics: Name" })).toBeInTheDocument();
    expect(screen.getAllByRole("status").length).toBeGreaterThan(0);

    // The first invalid field in document order has focus and carries its error.
    const key = screen.getByLabelText(/^Key/);
    await waitFor(() => {
      expect(key).toHaveFocus();
    });
    expect(key).toHaveAttribute("aria-invalid", "true");
    expect(key.getAttribute("aria-describedby")).toContain("key-error");

    // The section heading says how many problems it holds, and the button explains itself.
    const basics = screen.getByRole("region", { name: /^Basics/ });
    expect(within(basics).getByText(/\d+ problems?/)).toBeInTheDocument();
    expect(screen.getByText(/Fix \d+ problems to save/)).toBeInTheDocument();
  });

  it("focuses the field when its entry in the summary is activated", async () => {
    const user = userEvent.setup();
    renderGuarded(<TemplateForm initial={emptyTemplate} />);
    await user.click(screen.getByRole("button", { name: "Create" }));
    await user.click(await screen.findByRole("link", { name: "Basics: Name" }));
    expect(screen.getByLabelText(/^Name/)).toHaveFocus();
  });

  it("does not announce each field's error as its own alert", async () => {
    const user = userEvent.setup();
    renderGuarded(<TemplateForm initial={emptyTemplate} />);
    await user.click(screen.getByRole("button", { name: "Create" }));
    await screen.findByText(/problems to fix/);
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });
});

describe("dirty guard", () => {
  it("is silent while nothing was edited", async () => {
    const user = userEvent.setup();
    renderGuarded(<TemplateForm initial={emptyTemplate} />);
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    await user.click(screen.getByRole("link", { name: "Campaigns" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("asks before an in-app link, prompts on unload, and Stay keeps the edits", async () => {
    const user = userEvent.setup();
    renderGuarded(<TemplateForm initial={emptyTemplate} />);
    await user.type(screen.getByLabelText(/^Name/), "Discovery");

    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);

    await user.click(screen.getByRole("link", { name: "Campaigns" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Leave without saving?")).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Stay on this page" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^Name/)).toHaveValue("Discovery");
    expect(push).not.toHaveBeenCalled();
  });

  it("Leave goes where the link pointed", async () => {
    const user = userEvent.setup();
    renderGuarded(<TemplateForm initial={emptyTemplate} />);
    await user.type(screen.getByLabelText(/^Name/), "Discovery");
    await user.click(screen.getByRole("link", { name: "Campaigns" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Leave" }));
    expect(push).toHaveBeenCalledWith("/admin/campaigns");
  });

  it("asks before Cancel goes back, too", async () => {
    const user = userEvent.setup();
    renderGuarded(<TemplateForm initial={emptyTemplate} />);
    await user.type(screen.getByLabelText(/^Name/), "x");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(back).not.toHaveBeenCalled();
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Leave" }));
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("is clean again once the edit is undone", async () => {
    const user = userEvent.setup();
    renderGuarded(<TemplateForm initial={emptyTemplate} />);
    const name = screen.getByLabelText(/^Name/);
    await user.type(name, "ab");
    await user.clear(name);
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("campaign and requirements forms", () => {
  it("focuses the first invalid control of the campaign form and lists both problems", async () => {
    const user = userEvent.setup();
    renderGuarded(<CampaignForm templates={[]} />);
    await user.click(screen.getByRole("button", { name: /Create campaign|Create/ }));
    expect(await screen.findByText("2 problems to fix")).toBeInTheDocument();
    // The template picker is the first invalid control in document order.
    await waitFor(() => {
      expect(document.getElementById("campaign-form-templateId")).toHaveFocus();
    });
    expect(screen.getByText("Fix 2 problems to save")).toBeInTheDocument();
  });

  it("focuses the title of the requirements form, and the path group when only it is missing", async () => {
    const user = userEvent.setup();
    renderGuarded(<RequirementsForm templates={[]} />);
    await user.click(screen.getByRole("button", { name: /Start|Create|Begin/ }));
    await waitFor(() => {
      expect(document.getElementById("title")).toHaveFocus();
    });
    await user.type(document.getElementById("title")!, "Payroll app");
    await user.click(screen.getByRole("button", { name: /Start|Create|Begin/ }));
    await waitFor(() => {
      expect(document.getElementById("path")).toHaveFocus();
    });
  });
});

describe("scope picker", () => {
  it("navigates when a stand-alone scope is chosen, with no Open button", async () => {
    const user = userEvent.setup();
    render(
      <DirtyGuardProvider>
        <ScopePicker scope="template" scopeId="" allowPlatform={false} extraParams={{ category: "engine" }} />
      </DirtyGuardProvider>,
    );
    expect(screen.queryByRole("button", { name: "Open" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Level" }));
    await user.click(await screen.findByRole("option", { name: "Organization" }));
    expect(push).toHaveBeenCalledWith("/admin/settings?category=engine&scope=tenant");
  });

  it("waits for a target on template and campaign, then navigates when one is chosen", async () => {
    const user = userEvent.setup();
    render(
      <DirtyGuardProvider>
        <ScopePicker scope="campaign" scopeId="" allowPlatform={false} />
      </DirtyGuardProvider>,
    );
    expect(push).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: /Target/ }));
    await user.click(await screen.findByRole("option", { name: /Q3 survey/ }));
    expect(push).toHaveBeenCalledWith("/admin/settings?scope=campaign&scopeId=c1");
    expect(screen.getByRole("status")).toHaveTextContent("Showing settings for Q3 survey");
  });

  it("asks before leaving unsaved settings", async () => {
    const user = userEvent.setup();
    function Unsaved(): React.JSX.Element {
      return (
        <>
          <ScopePicker scope="tenant" scopeId="" allowPlatform={false} />
          <DirtyProbe />
        </>
      );
    }
    // A stand-in for a settings form with edits: registers itself dirty.
    const { useDirty } = await import("@/components/common/DirtyGuard");
    function DirtyProbe(): null {
      useDirty("settings-engine", true);
      return null;
    }
    render(
      <DirtyGuardProvider>
        <Unsaved />
      </DirtyGuardProvider>,
    );
    await user.click(screen.getByRole("combobox", { name: "Level" }));
    await user.click(await screen.findByRole("option", { name: "Campaign" }));
    expect(push).not.toHaveBeenCalled();
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Leave" }));
    expect(push).toHaveBeenCalledWith("/admin/settings?scope=campaign");
  });
});

describe("arrival flow field errors", () => {
  const api = (over: Partial<ParticipantApi>): ParticipantApi =>
    ({
      requestCode: vi.fn(() => Promise.resolve()),
      confirmCode: vi.fn(() => Promise.reject(new ApiError(401, "unauthenticated", "no"))),
      open: vi.fn(() => Promise.resolve({ sessionId: "s", resume: false })),
      consent: vi.fn(() => Promise.resolve()),
      ...over,
    }) as unknown as ParticipantApi;

  const campaign = {
    name: "Acme",
    productName: "",
    purpose: "",
    expectedMinutes: 10,
    participationMode: "identified" as const,
    verification: "email_code" as const,
    consentText: "Consent.",
    participantFields: [
      { key: "role", label: "Role", required: true },
      { key: "team", label: "Team", required: true },
    ],
    pathSelection: "none" as const,
  };

  it("shows an invalid email under the field and focuses it", async () => {
    const user = userEvent.setup();
    render(<ArrivalFlow linkToken="t" campaign={campaign} api={api({})} />);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(screen.getByLabelText("Email"), "not-an-address");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    const input = screen.getByLabelText("Email");
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Enter a valid email address.")).toHaveAttribute("id", "email-error");
    expect(input.getAttribute("aria-describedby")).toBe("email-error");
  });

  it("puts a wrong code on the code field, not in a detached banner", async () => {
    const user = userEvent.setup();
    render(<ArrivalFlow linkToken="t" campaign={campaign} api={api({})} />);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    const code = await screen.findByLabelText("Six-digit code");
    await user.type(code, "123456");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => {
      expect(code).toHaveAttribute("aria-invalid", "true");
    });
    expect(code).toHaveFocus();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(code.getAttribute("aria-describedby")).toContain("code-error");
  });

  it("marks every missing required detail and focuses the first", async () => {
    const user = userEvent.setup();
    render(
      <ArrivalFlow
        linkToken="t"
        campaign={{ ...campaign, verification: "open" }}
        api={api({ open: vi.fn(() => Promise.resolve({ sessionId: "s", resume: false })) })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("A few details");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByLabelText("Role")).toHaveFocus();
    expect(screen.getByLabelText("Role")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Team")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Role is required.")).toBeInTheDocument();
    expect(screen.getByText("Team is required.")).toBeInTheDocument();
    // Typing clears that field's error only.
    await user.type(screen.getByLabelText("Role"), "Analyst");
    expect(screen.getByLabelText("Role")).not.toHaveAttribute("aria-invalid");
    expect(screen.getByLabelText("Team")).toHaveAttribute("aria-invalid", "true");
  });
});
