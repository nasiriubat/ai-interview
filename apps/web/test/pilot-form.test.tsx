import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PilotForm, PILOT_ENDPOINT, validatePilot } from "@/components/pilot/PilotForm";
import { PilotPage } from "@/components/pilot/PilotPage";
import { en } from "@/i18n/en";
import { fi } from "@/i18n/fi";

vi.mock("next/headers", () => ({
  headers: (): Promise<{ get: (n: string) => string | null }> => Promise.resolve({ get: () => null }),
  cookies: (): Promise<{ get: () => undefined }> => Promise.resolve({ get: () => undefined }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/pilot",
  useSearchParams: () => new URLSearchParams(),
}));

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** A fetch that hands out a ticket on GET and answers POST with `answer`. */
function stubFetch(answer: () => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (!init || init.method === "GET") return Response.json({ ticket: "123.sig" });
      return answer();
    }),
  );
  return calls;
}

async function fillValid(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const f = en.pilot.fields;
  await user.type(screen.getByLabelText(new RegExp(`^${f.name}`)), "Aino Virtanen");
  await user.type(screen.getByLabelText(new RegExp(`^${f.email}`)), "aino@example.fi");
  await user.type(screen.getByLabelText(new RegExp(`^${f.company}`)), "Example Oy");
  await user.type(screen.getByLabelText(new RegExp(`^${f.role}`)), "Head of Operations");
  await user.selectOptions(screen.getByLabelText(new RegExp(`^${f.companySize}`)), "50-249");
  await user.selectOptions(screen.getByLabelText(new RegExp(`^${f.interest.replace("?", "\\?")}`)), "both");
  await user.click(screen.getByRole("checkbox", { name: new RegExp(en.pilot.consent) }));
}

describe("the pilot request form", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("names every missing required field, marks them invalid and sends nothing", async () => {
    const calls = stubFetch(() => Response.json({ ok: true }));
    const user = userEvent.setup();
    render(<PilotForm />);
    await user.click(screen.getByRole("button", { name: en.pilot.submit }));

    const f = en.pilot.fields;
    for (const label of [f.name, f.email, f.company, f.role, f.companySize, f.interest]) {
      const field = screen.getByLabelText(new RegExp(`^${label.replace("?", "\\?")}`));
      expect(field).toHaveAttribute("aria-invalid", "true");
    }
    expect(screen.getByRole("checkbox")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(en.pilot.errors.consent)).toBeInTheDocument();
    // Focus lands on the first problem, and a status line says how many there are.
    expect(screen.getByLabelText(new RegExp(`^${f.name}`))).toHaveFocus();
    expect(screen.getByText(en.pilot.errors.summary(7))).toBeInTheDocument();
    expect(calls.filter((c) => c.init?.method === "POST")).toHaveLength(0);
  });

  it("refuses an address that is not an email", () => {
    const errors = validatePilot({
      name: "A",
      email: "not-an-email",
      company: "C",
      role: "R",
      companySize: "1-49",
      interest: "both",
      participants: "",
      message: "",
      consent: true,
    });
    expect(errors).toEqual({ email: en.pilot.errors.email });
  });

  it("posts the request with the ticket, an empty honeypot and the page language, then confirms", async () => {
    const calls = stubFetch(() => Response.json({ ok: true }));
    const user = userEvent.setup();
    render(<PilotForm />);
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: en.pilot.submit }));

    const heading = await screen.findByRole("heading", { name: en.pilot.success.title });
    expect(heading).toHaveFocus();
    expect(screen.getByText(en.pilot.success.body("aino@example.fi"))).toBeInTheDocument();
    const post = calls.find((c) => c.init?.method === "POST");
    expect(post?.url).toBe(PILOT_ENDPOINT);
    expect(JSON.parse(String(post?.init?.body))).toEqual({
      name: "Aino Virtanen",
      email: "aino@example.fi",
      company: "Example Oy",
      role: "Head of Operations",
      companySize: "50-249",
      interest: "both",
      consent: true,
      locale: "en",
      website: "",
      ticket: "123.sig",
    });
  });

  it("keeps what was typed and asks to try again in a few minutes when sending fails", async () => {
    stubFetch(() => Response.json({ error: { code: "unavailable", message: "x" } }, { status: 503 }));
    const user = userEvent.setup();
    render(<PilotForm />);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: en.pilot.submit }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(en.pilot.failed.generic)).toBeInTheDocument();
    expect(en.pilot.failed.generic).toMatch(/few minutes/);
    expect(screen.getByLabelText(new RegExp(`^${en.pilot.fields.company}`))).toHaveValue("Example Oy");
    expect(screen.queryByRole("heading", { name: en.pilot.success.title })).toBeNull();
  });

  it("says why when the API found the form too fast or the network rate-limited", async () => {
    let answer = Response.json(
      { error: { code: "validation", message: "x", details: { reason: "too_fast" } } },
      { status: 400 },
    );
    const calls = stubFetch(() => answer);
    const user = userEvent.setup();
    render(<PilotForm />);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: en.pilot.submit }));
    expect(await screen.findByText(en.pilot.failed.tooFast)).toBeInTheDocument();
    // A refused ticket is replaced.
    await waitFor(() => {
      expect(calls.filter((c) => !c.init || c.init.method === "GET").length).toBe(2);
    });

    answer = Response.json({ error: { code: "rate_limited", message: "x" } }, { status: 429 });
    await user.click(screen.getByRole("button", { name: en.pilot.submit }));
    expect(await screen.findByText(en.pilot.failed.rateLimited)).toBeInTheDocument();
  });

  it("hides the honeypot from people and assistive technology", () => {
    stubFetch(() => Response.json({ ok: true }));
    const { container } = render(<PilotForm />);
    const trap = container.querySelector<HTMLInputElement>('input[name="website"]');
    expect(trap).not.toBeNull();
    expect(trap?.tabIndex).toBe(-1);
    expect(trap?.closest('[aria-hidden="true"]')).not.toBeNull();
  });
});

describe("the pilot page", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("names the product from the branding and links home", () => {
    stubFetch(() => Response.json({ ok: true }));
    render(<PilotPage strings={en.pilot} branding={{ productName: "AIScope", logoUrl: null }} />);
    expect(screen.getByRole("heading", { level: 1, name: en.pilot.title })).toBeInTheDocument();
    expect(screen.getByText(en.pilot.lead("AIScope"))).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /Back to home/ })[0]).toHaveAttribute("href", "/");
  });

  it("has every pilot string in Finnish, different from the English", () => {
    expect(fi.pilot.title).not.toBe(en.pilot.title);
    expect(fi.pilot.privacy).not.toBe(en.pilot.privacy);
    expect(Object.keys(fi.pilot.fields).sort()).toEqual(Object.keys(en.pilot.fields).sort());
  });

  it("is listed in the sitemap", async () => {
    vi.stubEnv("AUTH_URL", "https://discover.example.org");
    const sitemap = await (await import("@/app/sitemap.xml/route")).GET();
    expect(await sitemap.text()).toContain("<loc>https://discover.example.org/pilot</loc>");
    vi.unstubAllEnvs();
  });
});
