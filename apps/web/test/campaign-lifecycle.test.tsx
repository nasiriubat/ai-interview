import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CampaignEditForm, toLocalInput } from "@/components/admin/campaigns/CampaignEditForm";
import { CampaignLink } from "@/components/admin/campaigns/CampaignLink";
import { CampaignOverview } from "@/components/admin/campaigns/CampaignOverview";
import { CampaignSettingsTab, shortValue } from "@/components/admin/campaigns/CampaignSettingsTab";
import { CampaignTabs, tabFrom } from "@/components/admin/campaigns/CampaignTabs";
import { InvitationsPanel } from "@/components/admin/campaigns/InvitationsPanel";
import { qrPath, qrSvgDocument } from "@/components/admin/campaigns/QrCode";
import { SessionsTable } from "@/components/admin/campaigns/SessionsTable";
import { MeterBar } from "@/components/admin/MeterBar";
import { setClientLocale } from "@/i18n";
import {
  AnalysisSchema,
  CampaignSchema,
  InvitationSchema,
  SessionListItemSchema,
  SettingsResponseSchema,
} from "@/lib/api/schemas";

/*
 * The campaign page (D-237): sections as addresses, a share link with a QR code, progress against
 * the threshold, the analysis and spend cards, an edit page, and invitations and interviews lists
 * that say who and how.
 */

const staff = vi.hoisted(() => ({
  campaigns: { update: vi.fn(), remind: vi.fn(), revoke: vi.fn(), invite: vi.fn() },
  settings: { put: vi.fn() },
  analyses: { start: vi.fn(), list: vi.fn() },
}));
const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), back: vi.fn() }));

vi.mock("@/lib/api/browser", () => ({ staffClient: staff, participantClient: {} }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/admin/campaigns/c1",
  useSearchParams: () => new URLSearchParams(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  setClientLocale("en");
  staff.analyses.list.mockResolvedValue({ items: [], total: 0 });
});

describe("QR code", () => {
  it("draws the three finder squares of a real QR code, deterministically", () => {
    const a = qrPath("https://interviews.example.org/p/Zm9vYmFyYmF6");
    const b = qrPath("https://interviews.example.org/p/Zm9vYmFyYmF6");
    expect(a).toEqual(b);
    // Four modules of quiet zone on every side: size is modules + 8, and version 3 is 29 modules.
    expect(a.size).toBeGreaterThanOrEqual(29 + 8);
    const n = a.size - 8;
    // The seven-module top row of each finder pattern starts at the corners.
    expect(a.path).toContain("M4 4h7v1h-7z");
    expect(a.path).toContain(`M${String(n - 7 + 4)} 4h7v1h-7z`);
    expect(a.path).toContain(`M4 ${String(n - 7 + 4)}h7v1h-7z`);
  });

  it("makes a different code for a different link", () => {
    expect(qrPath("https://a.example/p/1").path).not.toBe(qrPath("https://a.example/p/2").path);
  });

  it("is a stand-alone black-on-white document, with no external reference", () => {
    const svg = qrSvgDocument("https://a.example/p/1");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('fill="white"');
    expect(svg).toContain('fill="black"');
    expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  });
});

describe("share link", () => {
  const url = "https://interviews.example.org/p/abc";

  it("shows the link, a QR code with a text alternative, and a download", () => {
    render(<CampaignLink name="Q3 ward round" url={url} status="open" />);
    expect(screen.getByRole("textbox", { name: "Shareable link" })).toHaveValue(url);
    expect(screen.getByRole("img", { name: "QR code for the link to Q3 ward round" })).toBeInTheDocument();
    const download = screen.getByRole("link", { name: /Download QR code/ });
    expect(download.getAttribute("href")).toMatch(/^data:image\/svg\+xml/);
    expect(download).toHaveAttribute("download", "Q3-ward-round-qr.svg");
    // The QR service is never contacted: nothing in the page names another host.
    expect(document.body.innerHTML).not.toContain("api.qrserver");
  });

  it("copies the link and announces it once, apart from the button", async () => {
    const user = userEvent.setup();
    render(<CampaignLink name="Q3" url={url} status="open" />);
    await user.click(screen.getByRole("button", { name: "Copy link" }));
    await expect(navigator.clipboard.readText()).resolves.toBe(url);
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("Link copied");
    });
    expect(screen.getByRole("button", { name: "Link copied" })).not.toHaveAttribute("aria-live");
  });

  it("says why there is nothing to share on a closed campaign, and shows no code without a link", () => {
    render(<CampaignLink name="Q3" url={undefined} status="closed" />);
    expect(screen.getByText(/The campaign is closed/)).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});

describe("sections as addresses", () => {
  it("falls back to the overview for anything that is not a section", () => {
    expect(tabFrom("sessions")).toBe("sessions");
    expect(tabFrom(["analysis", "x"])).toBe("analysis");
    expect(tabFrom("nope")).toBe("overview");
    expect(tabFrom(undefined)).toBe("overview");
  });

  it("links every section and marks the current one", () => {
    render(<CampaignTabs campaignId="c1" current="invitations" />);
    const nav = screen.getByRole("navigation", { name: "Campaign sections" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual([
      "Overview",
      "Invitations",
      "Interviews",
      "Analysis",
      "Settings",
    ]);
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/admin/campaigns/c1",
      "/admin/campaigns/c1?tab=invitations",
      "/admin/campaigns/c1?tab=sessions",
      "/admin/campaigns/c1?tab=analysis",
      "/admin/campaigns/c1?tab=settings",
    ]);
    expect(within(nav).getByRole("link", { current: "page" })).toHaveTextContent("Invitations");
  });
});

describe("MeterBar", () => {
  it("clamps, names the measure and says the value in words", () => {
    render(<MeterBar value={15} max={10} label="Spend" valueText="€15 of €10" tone="spend" />);
    const bar = screen.getByRole("progressbar", { name: "Spend" });
    expect(bar).toHaveAttribute("aria-valuenow", "100");
    expect(bar).toHaveAttribute("aria-valuetext", "€15 of €10");
    expect(bar.firstElementChild?.className).toContain("bg-destructive");
  });

  it("turns amber at 80 percent for spend and never for progress", () => {
    const { rerender } = render(<MeterBar value={8} max={10} label="a" valueText="x" tone="spend" />);
    expect(screen.getByRole("progressbar").firstElementChild?.className).toContain("bg-warning");
    rerender(<MeterBar value={8} max={10} label="a" valueText="x" />);
    expect(screen.getByRole("progressbar").firstElementChild?.className).toContain("bg-primary");
  });

  it("does not divide by zero", () => {
    render(<MeterBar value={0} max={0} label="a" valueText="x" />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
  });
});

describe("overview", () => {
  const campaign = CampaignSchema.parse({
    id: "c1",
    name: "Q3",
    status: "open",
    completionThreshold: 10,
    link: { url: "https://x.example/p/a" },
    stats: { invited: 20, started: 12, completed: 7, dropOffByArea: { tools: 3 } },
  });
  const base = { latestAnalysis: undefined, analysisError: null, spend: null, areaNames: { tools: "Tools" } };

  it("shows progress to the threshold with the number and what is missing", () => {
    render(<CampaignOverview campaign={campaign} data={base} />);
    expect(screen.getByRole("progressbar", { name: "Completed interviews" })).toHaveAttribute(
      "aria-valuetext",
      "7 of 10 needed for final results",
    );
    expect(screen.getByText("3 more interviews needed for final results.")).toBeInTheDocument();
    expect(screen.getByText("Tools")).toBeInTheDocument();
  });

  it("offers a preliminary analysis below the threshold and a final one above it", () => {
    const { rerender } = render(<CampaignOverview campaign={campaign} data={base} />);
    expect(screen.getByText(/3 more completed interviews before the results are final/)).toBeInTheDocument();
    const enough = { ...campaign, stats: { ...campaign.stats!, completed: 12 } };
    rerender(<CampaignOverview campaign={enough} data={base} />);
    expect(screen.getByText(/Enough interviews are complete/)).toBeInTheDocument();
  });

  it("runs the analysis from the card and reports a run already in progress", async () => {
    const user = userEvent.setup();
    staff.analyses.start.mockResolvedValue(undefined);
    render(<CampaignOverview campaign={campaign} data={base} />);
    await user.click(screen.getByRole("button", { name: "Analyze now" }));
    expect(staff.analyses.start).toHaveBeenCalledWith("c1");
    expect(router.refresh).toHaveBeenCalled();
  });

  it("disables Analyze now while a run is active and says so", () => {
    const running = AnalysisSchema.parse({ id: "a1", version: 2, status: "running" });
    render(<CampaignOverview campaign={campaign} data={{ ...base, latestAnalysis: running }} />);
    expect(screen.getByRole("button", { name: "Analyze now" })).toBeDisabled();
    expect(screen.getByText(/The analysis is running/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open results/ })).toHaveAttribute(
      "href",
      "/admin/campaigns/c1/results",
    );
  });

  it("shows spend against the campaign budget, or the way to set one", () => {
    const { rerender } = render(
      <CampaignOverview
        campaign={campaign}
        data={{ ...base, spend: { spentCents: 8000, limitCents: 10000 } }}
      />,
    );
    expect(screen.getByRole("progressbar", { name: "Spend on this campaign" })).toHaveAttribute(
      "aria-valuenow",
      "80",
    );
    rerender(
      <CampaignOverview
        campaign={campaign}
        data={{ ...base, spend: { spentCents: 250, limitCents: null } }}
      />,
    );
    expect(screen.getByText(/No budget is set for this campaign/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Set a budget" })).toHaveAttribute("href", "/admin/budgets");
    rerender(<CampaignOverview campaign={campaign} data={base} />);
    expect(screen.getByText("Spend could not be loaded.")).toBeInTheDocument();
  });
});

describe("interviews table", () => {
  const row = (over: Record<string, unknown>) =>
    SessionListItemSchema.parse({ id: "abcdef123456", status: "active", ...over });

  it("names an identified participant and calls anyone else anonymous, with the short id", () => {
    render(
      <SessionsTable
        sessions={[
          row({ id: "named0001xx", participantName: "Aino Virtanen", participantEmail: "aino@ward.test" }),
          row({ id: "anon0002xxx" }),
        ]}
      />,
    );
    expect(screen.getByText("Aino Virtanen")).toBeInTheDocument();
    expect(screen.getByText("aino@ward.test")).toBeInTheDocument();
    const anon = screen.getByText("anon0002").closest("tr");
    expect(anon).toHaveTextContent("Anonymous");
    expect(anon).not.toHaveTextContent("@");
  });

  it("shows the mode in words and the flag in its own column", () => {
    render(
      <SessionsTable
        sessions={[
          row({ id: "voice0001xx", mode: "voice", flagged: true }),
          row({ id: "chat00002xx", mode: "chat" }),
        ]}
      />,
    );
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(expect.arrayContaining(["Participant", "Mode", "Attention"]));
    const flagged = screen.getByText("voice000").closest("tr")!;
    expect(flagged).toHaveTextContent("Voice");
    expect(flagged).toHaveTextContent("Needs attention");
    const plain = screen.getByText("chat0000").closest("tr")!;
    expect(plain).toHaveTextContent("Chat");
    expect(plain).not.toHaveTextContent("Needs attention");
  });

  it("falls back to a topic count when the list carries no area breakdown", () => {
    render(<SessionsTable sessions={[row({ areasCovered: 3 })]} />);
    expect(screen.getByText("3 topics covered")).toBeInTheDocument();
  });
});

describe("invitations", () => {
  it("offers the address import as a labelled button that opens the import dialog", async () => {
    const user = userEvent.setup();
    render(<InvitationsPanel campaignId="c1" invitations={[]} />);
    await user.click(screen.getByRole("button", { name: "Import addresses from a file" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Choose a file" })).toBeInTheDocument();
    // Nothing can be imported before a file was understood.
    expect(within(dialog).getByRole("button", { name: "Import 0 rows" })).toBeDisabled();
  });

  it("marks who was reminded in this view and what cannot be reminded, and why", async () => {
    staff.campaigns.remind.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <InvitationsPanel
        campaignId="c1"
        invitations={[
          InvitationSchema.parse({ id: "i1", email: "a@x.test", status: "sent" }),
          InvitationSchema.parse({ id: "i2", email: "b@x.test", status: "bound" }),
          InvitationSchema.parse({ id: "i3", email: null, status: "sent" }),
          InvitationSchema.parse({ id: "i4", email: "d@x.test", status: "expired" }),
        ]}
      />,
    );
    // The API names an answered invitation "bound"; it reads as Started and is neither reminded nor revoked.
    expect(screen.getByText("Started")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remind: b@x.test" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Revoke: b@x.test" })).toBeDisabled();
    // No stored address, no reminder (the API refuses it too).
    expect(screen.getByRole("button", { name: "Remind: i3" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remind: d@x.test" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Remind: a@x.test" }));
    expect(staff.campaigns.remind).toHaveBeenCalledWith("c1", "i1");
    expect(await screen.findAllByText("Reminder sent")).not.toHaveLength(0);
  });
});

describe("settings for this campaign", () => {
  const settings = SettingsResponseSchema.parse({
    values: { "campaign.consentText": "Our words", "engine.maxTurns": 40, _linkToken: "secret" },
    catalog: [
      {
        key: "campaign.consentText",
        category: "campaign",
        description: "",
        default: "",
        scopes: ["campaign"],
      },
      { key: "engine.maxTurns", category: "engine", description: "", default: 30, scopes: ["campaign"] },
    ],
  });

  it("lists only what differs, never an internal key, with a link to each setting", () => {
    render(<CampaignSettingsTab campaignId="c1" settings={settings} />);
    expect(screen.getByText("2 settings are changed here")).toBeInTheDocument();
    expect(screen.queryByText(/_linkToken/)).not.toBeInTheDocument();
    expect(screen.queryByText("secret")).not.toBeInTheDocument();
    const link = screen.getAllByRole("link").find((a) => a.getAttribute("href")?.includes("engine-maxTurns"));
    expect(link).toHaveAttribute(
      "href",
      "/admin/settings?scope=campaign&scopeId=c1&category=engine#setting-engine-maxTurns",
    );
    expect(screen.getByRole("link", { name: /Open this campaign's settings/ })).toHaveAttribute(
      "href",
      "/admin/settings?scope=campaign&scopeId=c1",
    );
  });

  it("says the campaign follows the organization when nothing differs", () => {
    render(
      <CampaignSettingsTab
        campaignId="c1"
        settings={SettingsResponseSchema.parse({ values: {}, catalog: [] })}
      />,
    );
    expect(screen.getByText(/It follows your organization's settings/)).toBeInTheDocument();
  });

  it("never shows a secret value", () => {
    expect(shortValue("sk-live-123", true)).toBe("••••••");
    expect(shortValue("x".repeat(200), false)).toHaveLength(78);
    expect(shortValue(null, false)).toBe("–");
  });
});

describe("edit campaign", () => {
  const campaign = CampaignSchema.parse({
    id: "c1",
    name: "Q3 ward",
    status: "open",
    participationMode: "anonymous",
    verification: "email_code",
    allowedEmailDomains: ["ward.test"],
    maxTurns: 40,
    completionThreshold: 10,
    expiresAt: "2026-12-01T10:30:00.000Z",
  });
  const consent = {
    own: null,
    defaultText: "Default consent words.",
    language: "English",
    organizationText: null,
  };

  it("shows the default consent text and what cannot be changed", () => {
    render(<CampaignEditForm campaign={campaign} consent={consent} />);
    expect(screen.getByText("Default text (English)")).toBeInTheDocument();
    expect(screen.getByText("Default consent words.")).toBeInTheDocument();
    expect(screen.getByText("Fixed for this campaign")).toBeInTheDocument();
    expect(screen.getByText("Shared link; email code required")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Your own consent text" })).toHaveValue("");
  });

  it("shows the organization's text instead when it has one", () => {
    render(<CampaignEditForm campaign={campaign} consent={{ ...consent, organizationText: "Org words." }} />);
    expect(screen.getByText("Your organization's text")).toBeInTheDocument();
    expect(screen.getByText("Org words.")).toBeInTheDocument();
  });

  it("saves the changed fields and the consent text, then goes back to the campaign", async () => {
    staff.campaigns.update.mockResolvedValue(campaign);
    staff.settings.put.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<CampaignEditForm campaign={campaign} consent={consent} />);
    const name = screen.getByRole("textbox", { name: /^Name/ });
    await user.clear(name);
    await user.type(name, "Q3 ward round");
    await user.type(screen.getByRole("textbox", { name: "Your own consent text" }), "We keep it short.");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => {
      expect(staff.campaigns.update).toHaveBeenCalled();
    });
    const [id, patch] = staff.campaigns.update.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe("c1");
    expect(patch).toMatchObject({
      name: "Q3 ward round",
      allowedEmailDomains: ["ward.test"],
      maxTurns: 40,
      completionThreshold: 10,
    });
    expect(staff.settings.put).toHaveBeenCalledWith(
      { scope: "campaign", scopeId: "c1" },
      { "campaign.consentText": "We keep it short." },
    );
    expect(router.push).toHaveBeenCalledWith("/admin/campaigns/c1");
  });

  it("clears the campaign's own text with an empty value so the default applies again", async () => {
    staff.campaigns.update.mockResolvedValue(campaign);
    staff.settings.put.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<CampaignEditForm campaign={campaign} consent={{ ...consent, own: "Old words" }} />);
    await user.click(screen.getByRole("button", { name: "Use the default" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => {
      expect(staff.settings.put).toHaveBeenCalledWith(
        { scope: "campaign", scopeId: "c1" },
        { "campaign.consentText": null },
      );
    });
  });

  it("does not touch the settings when the consent text was left alone", async () => {
    staff.campaigns.update.mockResolvedValue(campaign);
    const user = userEvent.setup();
    render(<CampaignEditForm campaign={campaign} consent={consent} />);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => {
      expect(staff.campaigns.update).toHaveBeenCalled();
    });
    expect(staff.settings.put).not.toHaveBeenCalled();
  });

  it("refuses an empty name and a turn limit out of range, in the form", async () => {
    const user = userEvent.setup();
    render(<CampaignEditForm campaign={campaign} consent={consent} />);
    await user.clear(screen.getByRole("textbox", { name: /^Name/ }));
    const turns = screen.getByRole("spinbutton", { name: /Turns at most/ });
    await user.clear(turns);
    await user.type(turns, "2");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(staff.campaigns.update).not.toHaveBeenCalled();
    expect(await screen.findByText("This field is required.", { selector: "p" })).toBeInTheDocument();
    expect(screen.getAllByText("Must be 5 or more.").length).toBeGreaterThan(0);
  });

  it("turns an ISO instant into a datetime-local value, and tolerates nothing", () => {
    expect(toLocalInput(null)).toBe("");
    expect(toLocalInput("not a date")).toBe("");
    expect(toLocalInput("2026-12-01T10:30:00.000Z")).toMatch(/^2026-12-0[12]T\d\d:\d\d$/);
  });
});

describe("in Finnish", () => {
  it("names the sections and the share panel in Finnish", () => {
    setClientLocale("fi");
    render(<CampaignTabs campaignId="c1" current="overview" />);
    expect(screen.getByRole("link", { name: "Yleiskatsaus" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Haastattelut" })).toBeInTheDocument();
    setClientLocale("en");
  });
});
