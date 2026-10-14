import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TenantsPanel } from "@/components/admin/operator/TenantsPanel";
import { CategoryForm } from "@/components/admin/settings/CategoryForm";
import { SettingsSearch } from "@/components/admin/settings/SettingsSearch";
import { WhatChangedPanel, whatChangedSince } from "@/components/admin/settings/WhatChangedPanel";
import { SetupChecklist } from "@/components/admin/SetupChecklist";
import { VersionsPanel } from "@/components/admin/templates/VersionsPanel";
import { fold, searchSettings } from "@/lib/admin/settingsSearch";
import { participantErrorFor } from "@/lib/api/errors";
import type {
  Onboarding,
  SettingsCatalogEntry,
  SettingsHistoryItem,
  TemplateVersion,
  Tenant,
} from "@/lib/api/schemas";

const put = vi.fn();
const restore = vi.fn();
const dismiss = vi.fn();
const createTenant = vi.fn();
const push = vi.fn();
const refresh = vi.fn();

vi.mock("@/lib/api/browser", () => ({
  staffClient: {
    settings: { put: (...a: unknown[]): unknown => put(...a), emailTest: vi.fn() },
    templates: { restore: (...a: unknown[]): unknown => restore(...a) },
    onboarding: { dismiss: (...a: unknown[]): unknown => dismiss(...a) },
    operator: {
      tenants: {
        create: (...a: unknown[]): unknown => createTenant(...a),
        update: vi.fn(),
      },
    },
  },
  participantClient: {},
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push, back: vi.fn() }),
  usePathname: () => "/admin/templates/t3",
  useSearchParams: () => new URLSearchParams(),
}));

beforeEach(() => {
  for (const m of [put, restore, dismiss, createTenant, push, refresh]) m.mockReset();
  put.mockResolvedValue(undefined);
  window.localStorage.clear();
});

const entry = (
  over: Partial<SettingsCatalogEntry> & Pick<SettingsCatalogEntry, "key">,
): SettingsCatalogEntry => ({
  category: "other",
  description: "",
  default: 0,
  scopes: ["platform", "tenant"],
  ...over,
});

describe("settings search (D-180)", () => {
  const catalog = [
    entry({ key: "voice.captions", category: "voice", description: "Show captions" }),
    entry({ key: "privacy.retentionMonths", category: "privacy", description: "Months before deletion" }),
    entry({ key: "ceiling.maxActiveCampaigns", category: "ceiling", description: "Most campaigns" }),
  ];

  it("folds case and diacritics, so 'saily' finds säilytys and 'AANI' finds ääni", () => {
    expect(fold("Säilytysaika")).toBe("sailytysaika");
    expect(fold("ÄÄNI")).toBe("aani");
  });

  it("finds a key by its English name, its Finnish name or its key", () => {
    // English label of privacy.retentionMonths and its Finnish one both reach the same key.
    expect(searchSettings("retention", catalog).map((e) => e.key)).toContain("privacy.retentionMonths");
    expect(searchSettings("säilytys", catalog).map((e) => e.key)).toContain("privacy.retentionMonths");
    expect(searchSettings("voice.captions", catalog).map((e) => e.key)).toEqual(["voice.captions"]);
  });

  it("needs every word to match and returns nothing for an empty query", () => {
    expect(searchSettings("captions banana", catalog)).toEqual([]);
    expect(searchSettings("   ", catalog)).toEqual([]);
  });

  it("renders results as links to the category with the control's anchor", async () => {
    const user = userEvent.setup();
    render(<SettingsSearch entries={catalog} scope="tenant" scopeId={undefined} />);
    await user.type(screen.getByRole("searchbox", { name: "Find a setting" }), "retention");
    const link = await screen.findByRole("link", { name: /retention/i });
    expect(link).toHaveAttribute(
      "href",
      "/admin/settings?scope=tenant&category=privacy#setting-privacy-retentionMonths",
    );
    expect(screen.getByRole("status")).toHaveTextContent("1 setting matches");
    await user.clear(screen.getByRole("searchbox"));
    await user.type(screen.getByRole("searchbox"), "zzzz");
    expect(await screen.findByText("No setting matches that.")).toBeInTheDocument();
  });
});

describe("what changed since your last visit (D-180)", () => {
  const catalog = [
    { key: "voice.enabled", category: "voice", since: "2026.10" },
    { key: "privacy.kAnonymity", category: "privacy", since: null },
  ];
  const item = (over: Partial<SettingsHistoryItem>): SettingsHistoryItem => ({
    id: "h1",
    at: "2026-10-12T10:00:00.000Z",
    scope: "tenant",
    scopeId: "c1",
    keys: ["privacy.kAnonymity"],
    cleared: [],
    actor: { id: "u2", name: "Mika", email: "mika@acme.fi" },
    ...over,
  });

  it("is empty on a first visit: nothing is new to someone who has never looked", () => {
    expect(whatChangedSince(null, catalog, [item({})], "me@acme.fi")).toEqual({ added: [], changes: [] });
  });

  it("lists keys from a later release and saves by other people after the last visit", () => {
    const seen = { at: "2026-10-01T00:00:00.000Z", release: "2026.09" };
    const mine = item({ id: "mine", actor: { id: "u1", name: "Me", email: "me@acme.fi" } });
    const old = item({ id: "old", at: "2026-09-01T00:00:00.000Z" });
    const out = whatChangedSince(seen, catalog, [item({}), mine, old], "me@acme.fi");
    expect(out.added.map((a) => a.key)).toEqual(["voice.enabled"]);
    expect(out.changes.map((c) => c.id)).toEqual(["h1"]);
  });

  it("shows the panel once, then remembers the visit", async () => {
    window.localStorage.setItem("aidp.settings.lastVisit", "2026-10-01T00:00:00.000Z");
    window.localStorage.setItem("aidp.settings.lastRelease", "2026.09");
    const view = render(
      <WhatChangedPanel
        catalog={catalog}
        history={[item({})]}
        release="2026.10"
        myEmail="me@acme.fi"
        scope="tenant"
        scopeId={undefined}
      />,
    );
    expect(await screen.findByText("What changed since your last visit")).toBeInTheDocument();
    expect(screen.getByText("1 new setting in release 2026.10")).toBeInTheDocument();
    expect(screen.getByText(/Mika changed/)).toBeInTheDocument();
    expect(window.localStorage.getItem("aidp.settings.lastRelease")).toBe("2026.10");
    view.unmount();

    // Second render: the stored visit is now, so there is nothing to say.
    render(
      <WhatChangedPanel
        catalog={catalog}
        history={[item({})]}
        release="2026.10"
        myEmail="me@acme.fi"
        scope="tenant"
        scopeId={undefined}
      />,
    );
    await waitFor(() => {
      expect(screen.queryByText("What changed since your last visit")).not.toBeInTheDocument();
    });
  });
});

describe("operator-only settings (D-188)", () => {
  const ceiling = entry({
    key: "ceiling.maxActiveCampaigns",
    category: "ceiling",
    default: 20,
    operatorOnly: true,
    since: "2026.10",
  });
  const other = entry({ key: "campaign.completionThreshold", category: "campaign", default: 5 });

  it("shows a ceiling read-only to a tenant admin and does not send it on save", async () => {
    const user = userEvent.setup();
    render(
      <CategoryForm
        category="ceiling"
        title="Limits"
        entries={[ceiling, other]}
        values={{ "ceiling.maxActiveCampaigns": 30, "campaign.completionThreshold": 7 }}
        effective={{ "ceiling.maxActiveCampaigns": 30 }}
        secrets={{}}
        sources={{}}
        scope="tenant"
        scopeId={undefined}
      />,
    );
    expect(screen.getByText("Set by your platform operator")).toBeInTheDocument();
    expect(screen.queryByRole("spinbutton", { name: /Most campaigns at once/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save this category" }));
    await waitFor(() => {
      expect(put).toHaveBeenCalledTimes(1);
    });
    const [, payload] = put.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(payload).toEqual({ "campaign.completionThreshold": 7 });
  });

  it("is editable for the operator", () => {
    render(
      <CategoryForm
        category="ceiling"
        title="Limits"
        entries={[ceiling]}
        values={{}}
        effective={{}}
        secrets={{}}
        sources={{}}
        scope="tenant"
        scopeId="c1"
        operator
      />,
    );
    expect(screen.getByRole("spinbutton")).toBeInTheDocument();
    expect(screen.queryByText("Set by your platform operator")).not.toBeInTheDocument();
  });
});

describe("template versions and restore (FR-62)", () => {
  const versions: TemplateVersion[] = [
    {
      id: "t3",
      version: 3,
      status: "published",
      createdAt: "2026-10-12T10:00:00.000Z",
      createdBy: { id: "u1", name: "Aino", email: "aino@acme.fi" },
      changedFields: ["name", "objective"],
      campaigns: 0,
      latest: true,
    },
    {
      id: "t2",
      version: 2,
      status: "archived",
      createdAt: "2026-10-10T10:00:00.000Z",
      createdBy: null,
      changedFields: ["aiInstructions"],
      campaigns: 2,
      latest: false,
    },
    {
      id: "t1",
      version: 1,
      status: "archived",
      createdAt: "2026-10-01T10:00:00.000Z",
      createdBy: null,
      changedFields: [],
      campaigns: 1,
      latest: false,
    },
  ];

  it("lists versions with their changes and campaign counts, and restores one after a confirmation", async () => {
    const user = userEvent.setup();
    restore.mockResolvedValue({ id: "t4" });
    render(<VersionsPanel versions={versions} currentId="t3" canRestore />);

    expect(screen.getByText("Current")).toBeInTheDocument();
    expect(screen.getByText("First version")).toBeInTheDocument();
    // The current version has no restore button; the others do.
    expect(screen.queryByRole("button", { name: "Restore 3" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Restore 1" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Restore version 1?")).toBeInTheDocument();
    expect(within(dialog).getByText(/creates version 4 with the content of version 1/i)).toBeInTheDocument();
    expect(restore).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Restore version" }));
    await waitFor(() => {
      expect(restore).toHaveBeenCalledWith("t1");
    });
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith("/admin/templates/t4");
    });
  });

  it("offers no restore on a built-in template", () => {
    render(<VersionsPanel versions={versions} currentId="t3" canRestore={false} />);
    expect(screen.queryByRole("button", { name: /Restore/ })).not.toBeInTheDocument();
  });
});

describe("the getting-started card (D-189)", () => {
  const state = (over: Partial<Onboarding>): Onboarding => ({
    steps: [
      { key: "provider", done: true, source: "platform" },
      { key: "template", done: false },
      { key: "campaign", done: false },
      { key: "invite", done: false },
    ],
    done: 1,
    total: 4,
    complete: false,
    dismissed: false,
    next: "template",
    ...over,
  });

  it("marks the next step, says where the model comes from, and links each open step", () => {
    render(<SetupChecklist state={state({})} />);
    expect(screen.getByRole("region", { name: "Get started" })).toBeInTheDocument();
    expect(screen.getByText("1 of 4 done")).toBeInTheDocument();
    expect(screen.getByText(/platform's default model/)).toBeInTheDocument();
    const items = screen.getAllByRole("listitem");
    const current = items.filter((li) => li.getAttribute("aria-current") === "step");
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent("Choose a template");
    expect(within(current[0]!).getByRole("link", { name: "Templates" })).toHaveAttribute(
      "href",
      "/admin/templates",
    );
  });

  it("dismisses through the API and disappears", async () => {
    const user = userEvent.setup();
    dismiss.mockResolvedValue(state({ dismissed: true }));
    render(<SetupChecklist state={state({})} />);
    await user.click(screen.getByRole("button", { name: "Hide this card" }));
    await waitFor(() => {
      expect(dismiss).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "Get started" })).not.toBeInTheDocument();
    });
  });

  it("renders nothing once dismissed or complete", () => {
    const a = render(<SetupChecklist state={state({ dismissed: true })} />);
    expect(a.container).toBeEmptyDOMElement();
    const b = render(<SetupChecklist state={state({ complete: true, done: 4 })} />);
    expect(b.container).toBeEmptyDOMElement();
  });
});

describe("creating a tenant (D-189)", () => {
  const tenant: Tenant = {
    id: "c1",
    name: "Acme",
    status: "active",
    region: "eu",
    monthlyBudgetCents: 20000,
    utilisation: [
      { metric: "maxActiveCampaigns", used: 4, max: 5, percent: 80 },
      { metric: "storageBytes", used: 1024 * 1024 * 3, max: 0, percent: null },
    ],
    onboarding: { steps: [], done: 2, total: 4, complete: false, dismissed: false, next: "campaign" },
  };

  it("sends the first admin, the language and only the limits that were filled in, in the units the API uses", async () => {
    const user = userEvent.setup();
    createTenant.mockResolvedValue({ tenant, invitation: { to: "boss@uusi.fi", language: "fi" } });
    render(<TenantsPanel tenants={[]} />);
    // The form is a dialog, so the table of tenants is the first thing on the page.
    await user.click(screen.getByRole("button", { name: "New tenant" }));

    await user.type(screen.getByLabelText(/^Name/), "Uusi Oy");
    await user.type(screen.getByLabelText(/First admin's email/), "boss@uusi.fi");
    await user.type(screen.getByLabelText(/Storage \(MB\)/), "500");
    await user.type(screen.getByLabelText(/Campaigns at once/), "3");
    await user.click(screen.getByRole("combobox", { name: /Language of emails/ }));
    await user.click(await screen.findByRole("option", { name: "Finnish" }));
    await user.click(screen.getByRole("button", { name: /Create tenant/ }));

    await waitFor(() => {
      expect(createTenant).toHaveBeenCalledTimes(1);
    });
    expect(createTenant.mock.calls[0]?.[0]).toEqual({
      name: "Uusi Oy",
      region: "eu",
      adminEmail: "boss@uusi.fi",
      language: "fi",
      ceilings: { maxActiveCampaigns: 3, storageBytes: 500 * 1024 * 1024 },
    });
    expect(await screen.findByText("Invitation sent to boss@uusi.fi")).toBeInTheDocument();
  });

  it("shows each tenant's use of its limits and its setup progress", () => {
    render(<TenantsPanel tenants={[tenant]} />);
    expect(screen.getByText("4 / 5")).toBeInTheDocument();
    expect(screen.getByText(/3 \(no limit\)/)).toBeInTheDocument();
    expect(screen.getByText("2 of 4 set up")).toBeInTheDocument();
  });
});

describe("what a participant reads for the 2026.10 refusals", () => {
  it("says a full interview round and a switched-off way of answering in plain words, with what was kept", () => {
    const full = participantErrorFor("limit_reached", "interview");
    expect(full).toMatch(/cannot take more people/);
    expect(full).not.toMatch(/limit_reached|ceiling|403/i);
    const off = participantErrorFor("feature_disabled", "interview");
    expect(off).toMatch(/turned off for this interview/);
    expect(off).toMatch(/Answer in writing/);
  });
});
