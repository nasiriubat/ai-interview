import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoutesForm } from "@/components/admin/providers/RoutesForm";
import { CategoryForm } from "@/components/admin/settings/CategoryForm";
import { SpendPanel } from "@/components/admin/SpendPanel";
import { StatsGroups } from "@/components/admin/StatsGroups";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { setClientLocale } from "@/i18n";
import { participantErrorFor, ApiError, participantErrorText } from "@/lib/api/errors";
import type { Provider, RouteRecord, SettingsCatalogEntry, Spend } from "@/lib/api/schemas";

/*
 * Screens that used to spell identifiers out in English (`humanize`) read in Finnish now. Each
 * test renders in `fi` and fails on the English words or the raw identifier (D-132).
 */

vi.mock("@/lib/api/browser", () => ({
  staffClient: {
    routes: { put: vi.fn() },
    providers: { models: vi.fn().mockResolvedValue({ models: [] }) },
    settings: { put: vi.fn(), emailTest: vi.fn() },
  },
  participantClient: {},
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), back: vi.fn() }),
  usePathname: () => "/admin",
  useSearchParams: () => new URLSearchParams(),
}));

beforeEach(() => {
  setClientLocale("fi");
});
afterEach(() => {
  setClientLocale("en");
});

describe("settings in Finnish", () => {
  const entries: SettingsCatalogEntry[] = [
    {
      key: "privacy.rawTranscriptsVisibleTo",
      category: "privacy",
      description: "Who may open raw transcripts",
      default: "admins_when_identified_and_opted_in",
      scopes: ["platform", "tenant"],
      secret: false,
    },
    {
      key: "privacy.retentionMonths",
      category: "privacy",
      description: "Months before session data is deleted automatically",
      default: 24,
      scopes: ["platform", "tenant"],
      secret: false,
    },
  ];

  it("names each setting and its options in Finnish, not by its identifier", () => {
    render(
      <CategoryForm
        category="privacy"
        title="Yksityisyys"
        entries={entries}
        values={{}}
        effective={{}}
        secrets={{}}
        sources={{}}
        scope="tenant"
        scopeId={undefined}
      />,
    );
    expect(screen.getByText("Kuka saa lukea kokonaiset keskustelut")).toBeInTheDocument();
    expect(screen.getByText("Haastattelutietojen säilytysaika kuukausina")).toBeInTheDocument();
    // The description is ours, in Finnish; the API's English one is only a fallback.
    expect(
      screen.getByText(/Tämän jälkeen vastaukset, tiedostot ja tallenteet poistetaan/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Months before session data is deleted automatically")).not.toBeInTheDocument();
    expect(screen.queryByText("Retention months")).not.toBeInTheDocument();
    // The selected option of the enum reads as words.
    expect(
      screen.getByText("Ylläpitäjät, kun osallistuja osallistui omalla nimellään", { selector: "span" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Admins when identified and opted in")).not.toBeInTheDocument();
  });
});

describe("model assignment in Finnish", () => {
  it("names the task of each row and the provider type", () => {
    const provider: Provider = { id: "p1", kind: "openai", name: "OpenAI", enabled: true, hasKey: true };
    const routes = [
      {
        companyId: "co1",
        purpose: "interview_turn",
        providerId: "p1",
        model: "gpt-x",
        effort: "xhigh",
        maxOutputTokens: 800,
        batchAllowed: false,
      },
    ] as RouteRecord[];
    render(<RoutesForm routes={routes} providers={[provider]} scope="tenant" companyId="co1" />);
    expect(screen.getByRole("heading", { level: 3, name: "Haastattelukysymykset" })).toBeInTheDocument();
    expect(screen.getByText("Tietojen poiminta vastauksista")).toBeInTheDocument();
    expect(screen.queryByText("Interview turn")).not.toBeInTheDocument();
    expect(screen.queryByText("interview_turn")).not.toBeInTheDocument();
    // The effort of the row reads as words, not as "xhigh".
    expect(screen.getByRole("combobox", { name: /Päättelyn taso: Haastattelukysymykset/ })).toHaveTextContent(
      "Erittäin korkea",
    );
  });
});

describe("statuses, spend and statistics in Finnish", () => {
  it("shows a known status in Finnish and an unknown one as code", () => {
    render(
      <>
        <StatusBadge status="closed" />
        <StatusBadge status="quarantined" />
      </>,
    );
    expect(screen.getByText("Suljettu")).toBeInTheDocument();
    const unknown = screen.getByText("quarantined");
    expect(unknown.tagName).toBe("CODE");
  });

  it("names the tasks in the spend table", () => {
    const spend = {
      rows: [{ key: "transcription", costCents: 120, calls: 3, tokens: 900 }],
      budget: { limitCents: 1000, spentCents: 120 },
    } as Spend;
    render(<SpendPanel spend={spend} title="Kulutus" />);
    const table = screen.getByRole("table");
    expect(within(table).getByText("Tallenteiden litterointi")).toBeInTheDocument();
    expect(within(table).queryByText("Transcription")).not.toBeInTheDocument();
  });

  it("names platform statistics keys and their status rows", () => {
    render(<StatsGroups stats={{ tenants: 4, sessions: { completed: 7, paused: 2 } }} />);
    expect(screen.getByText("Organisaatiot")).toBeInTheDocument();
    expect(screen.getByText("Valmis")).toBeInTheDocument();
    expect(screen.getByText("Tauolla")).toBeInTheDocument();
  });
});

describe("participant errors in Finnish, in three parts", () => {
  it("says what happened, what to do and what was kept, and never the API message", () => {
    const e = new ApiError(502, "provider_error", "upstream timeout from anthropic");
    const text = participantErrorText(e, "interview");
    expect(text).toBe(
      "Haastattelija ei ole juuri nyt tavoitettavissa. Yritä hetken kuluttua uudelleen. Vastauksesi ovat tallessa.",
    );
    expect(text).not.toMatch(/anthropic|upstream/);
  });

  it("treats a failed fetch as a connection problem", () => {
    expect(participantErrorText(new TypeError("Failed to fetch"), "arrival")).toBe(
      "Palvelimeen ei saatu yhteyttä. Tarkista yhteytesi ja yritä uudelleen. Syöttämäsi tiedot ovat yhä tällä sivulla.",
    );
  });

  it("uses the same structure in English", () => {
    setClientLocale("en");
    expect(participantErrorFor("rate_limited", "none")).toBe(
      "There have been too many attempts. Wait a minute and try again.",
    );
    expect(participantErrorFor("budget_exceeded", "interview")).toMatch(
      /usage limit.*Come back later.*saved\.$/,
    );
  });

  it("tells a participant a full server disk is not their fault, in both languages (D-283)", () => {
    expect(participantErrorFor("storage_full", "interview")).toBe(
      "Palvelu ei voi juuri nyt tallentaa tiedostoja. Vastaa toistaiseksi kirjoittamalla tai yritä tiedostoa myöhemmin uudelleen. Vastauksesi ovat tallessa.",
    );
    setClientLocale("en");
    expect(participantErrorFor("storage_full", "interview")).toMatch(
      /cannot store files right now.*Answer in writing/,
    );
  });

  it("falls back to the server wording for a code it does not know", () => {
    expect(participantErrorFor("something_new", "interview")).toMatch(/meidän päässämme/);
  });
});
