import { existsSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Landing } from "@/components/landing/Landing";
import { setClientLocale, stringsFor } from "@/i18n";
import type { Locale } from "@/i18n/locale";
import { contactEmail, mailtoHref, publicOrigin } from "@/lib/landing";

/*
 * The public landing page (`/`): what it renders, in both languages, for each kind of visitor.
 * The words themselves are checked against the code in docs/team/claims-2026-10.md; this file
 * checks the properties that must not regress: one h1, landmarks, no third-party hosts, every link
 * resolves, no claim about something the product does not do.
 */

const state = vi.hoisted((): { lang: string | undefined; host: string } => ({
  lang: "en",
  host: "app.example.com",
}));

vi.mock("next/headers", () => ({
  cookies: (): Promise<{ get: (n: string) => { value: string } | undefined }> =>
    Promise.resolve({
      get: (n: string) => (n === "lang" && state.lang ? { value: state.lang } : undefined),
    }),
  headers: (): Promise<{ get: (n: string) => string | null }> =>
    Promise.resolve({
      get: (n: string) => (n === "host" ? state.host : n === "x-forwarded-proto" ? "https" : null),
    }),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("the landing page must not redirect");
  }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const render = (
  locale: Locale,
  over: { signedIn?: boolean; contact?: string | null; appName?: string; logoUrl?: string | null } = {},
): string => {
  setClientLocale(locale);
  const s = stringsFor(locale);
  return renderToStaticMarkup(
    <Landing
      strings={s.landing}
      appName={over.appName ?? s.app.name}
      logoUrl={over.logoUrl ?? null}
      signedIn={over.signedIn ?? false}
      contact={over.contact === undefined ? "hello@example.com" : over.contact}
    />,
  );
};

const doc = (html: string): Document => new DOMParser().parseFromString(html, "text/html");

beforeEach(() => {
  state.lang = "en";
  setClientLocale("en");
});

describe.each(["en", "fi"] as const)("landing page structure (%s)", (locale) => {
  const html = render(locale);
  const d = doc(html);

  it("has exactly one h1 and a section heading for each block, with no skipped level", () => {
    expect(d.querySelectorAll("h1")).toHaveLength(1);
    const levels = [...d.querySelectorAll("h1, h2, h3, h4")].map((h) => Number(h.tagName.slice(1)));
    for (let i = 1; i < levels.length; i++) expect(levels[i]! - levels[i - 1]!).toBeLessThanOrEqual(1);
    expect(d.querySelectorAll("h2").length).toBeGreaterThanOrEqual(7);
  });

  it("has the landmarks: banner, navigation, one main named by the skip link, contentinfo", () => {
    expect(d.querySelectorAll("header")).toHaveLength(1);
    expect(d.querySelectorAll("footer")).toHaveLength(1);
    expect(d.querySelectorAll("main#main")).toHaveLength(1);
    expect(d.querySelectorAll("nav[aria-label]").length).toBeGreaterThanOrEqual(1);
  });

  it("names every section by its heading", () => {
    for (const section of d.querySelectorAll("section[aria-labelledby]")) {
      const id = section.getAttribute("aria-labelledby")!;
      expect(d.getElementById(id), id).not.toBeNull();
    }
  });

  it("has ten questions, each a native details element (no script needed)", () => {
    expect(d.querySelectorAll("details > summary")).toHaveLength(10);
    expect(d.querySelectorAll("script")).toHaveLength(0);
  });

  it("makes no request to another host and loads no script, font or frame", () => {
    // An SVG namespace is an identifier, not a request.
    expect(html.replace(/xmlns="[^"]*"/g, "")).not.toMatch(/https?:\/\//i);
    // The one allowed <link> is the preload of the first screenshot, from this origin.
    const rest = html.replace(/<link rel="preload" as="image" href="\/landing\/[^"]+"\/>/g, "");
    expect(rest).not.toMatch(/<(script|iframe|link|object|embed|video|audio|source)\b/i);
    expect(html).not.toMatch(/\burl\(/i);
    for (const a of d.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href")!;
      expect(href.startsWith("/") || href.startsWith("#") || href.startsWith("mailto:"), href).toBe(true);
    }
  });

  it("shows only same-origin screenshots, each with its size and a description", () => {
    const imgs = [...d.querySelectorAll("img")];
    expect(imgs.length).toBeGreaterThanOrEqual(8);
    for (const img of imgs) {
      const src = img.getAttribute("src")!;
      expect(src.startsWith("/landing/"), src).toBe(true);
      expect(existsSync(path.resolve(import.meta.dirname, "../public", src.slice(1))), src).toBe(true);
      expect(Number(img.getAttribute("width")), src).toBeGreaterThan(0);
      expect(Number(img.getAttribute("height")), src).toBeGreaterThan(0);
      expect(img.getAttribute("alt")?.length ?? 0, src).toBeGreaterThan(10);
    }
    // Only the first screenshot is eager; the rest wait until they are near the screen.
    const eager = imgs.filter((i) => i.getAttribute("loading") !== "lazy");
    expect(eager.length).toBeLessThanOrEqual(1);
  });

  it("has a header menu button with a name, and a footer with the security contact and a language switch", () => {
    const menu = d.querySelector('header button[aria-haspopup="dialog"]');
    expect(menu?.getAttribute("aria-label")?.length ?? 0).toBeGreaterThan(0);
    expect(d.querySelector('footer a[href="/.well-known/security.txt"]')).not.toBeNull();
    expect(d.querySelectorAll('footer button[aria-haspopup="menu"]')).toHaveLength(1);
    const ids = [...d.querySelectorAll("[id]")].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("links only to routes and files that exist and to anchors on the page", () => {
    const app = path.resolve(import.meta.dirname, "../src/app");
    const hrefs = [...d.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")!);
    expect(hrefs.length).toBeGreaterThan(5);
    for (const href of hrefs) {
      if (href.startsWith("mailto:")) continue;
      if (href.startsWith("#")) {
        expect(d.getElementById(href.slice(1)), href).not.toBeNull();
        continue;
      }
      const dir = path.join(app, ...href.split("/").filter(Boolean));
      const publicFile = path.resolve(import.meta.dirname, "../public", href.slice(1));
      expect(existsSync(path.join(dir, "page.tsx")) || existsSync(publicFile), href).toBe(true);
    }
  });

  it("offers sign-in and, with an address configured, a prefilled mail to request a workspace", () => {
    expect(d.querySelector('a[href="/auth/signin"]')).not.toBeNull();
    const mail = d.querySelector('a[href^="mailto:"]')!;
    expect(mail.getAttribute("href")).toMatch(/^mailto:hello@example\.com\?subject=/);
  });
});

describe("the visitor", () => {
  it("who is signed in is offered the overview, not a sign-in, and is not redirected", () => {
    const d = doc(render("en", { signedIn: true }));
    expect(d.querySelectorAll('a[href="/admin"]').length).toBeGreaterThanOrEqual(2);
    expect(d.querySelector('a[href="/auth/signin"]')).toBeNull();
    expect(d.querySelector('a[href^="mailto:"]')).toBeNull();
    expect(d.querySelector("h1")).not.toBeNull();
  });

  it("with no contact address configured gets no mail link at all and a plain sentence instead", () => {
    const html = render("en", { contact: null });
    const d = doc(html);
    expect(d.querySelector('a[href^="mailto:"]')).toBeNull();
    expect(html).not.toMatch(/mailto:/);
    expect(d.querySelector('a[href="/auth/signin"]')).not.toBeNull();
    expect(d.body.textContent).toContain(stringsFor("en").landing.hero.noContact);
  });

  it("arriving by a link is told that the link is all they need", () => {
    const text = doc(render("en")).body.textContent;
    expect(text).toContain("Were you sent an interview link?");
    expect(text).toMatch(/do not need an account/);
    expect(doc(render("fi")).body.textContent).toContain("Sait haastattelulinkin?");
  });
});

describe("the product name", () => {
  it("comes from one value: a rename shows everywhere the name is used", () => {
    const d = doc(render("en", { appName: "Askel" }));
    expect(d.querySelector("header a")?.textContent).toContain("Askel");
    expect(d.querySelector("footer")?.textContent).toContain("Askel");
    // No letter tile beside the name (D-430): the name alone is the mark.
    expect(d.querySelector("header a")?.textContent).toBe("Askel");
    expect(d.querySelector("header a [aria-hidden]")).toBeNull();
    expect(d.body.textContent).not.toContain("Discovery:");
  });

  it("shows the uploaded logo instead of the name, with the name as its text alternative", () => {
    const d = doc(render("en", { appName: "Askel", logoUrl: "/api/branding/logo?v=abc" }));
    for (const where of ["header a", "footer"]) {
      const img = d.querySelector(`${where} img`);
      expect(img?.getAttribute("src")).toBe("/api/branding/logo?v=abc");
      expect(img?.getAttribute("alt")).toBe("Askel");
    }
    expect(d.querySelector("header a")?.textContent).toBe("");
  });
});

describe("the two languages say the same things", () => {
  const en = stringsFor("en").landing;
  const fi = stringsFor("fi").landing;

  it("have the same lists, the same number of items in each", () => {
    expect(fi.faq.items).toHaveLength(en.faq.items.length);
    expect(fi.chatbot.rows).toHaveLength(en.chatbot.rows.length);
    expect(fi.trust.items).toHaveLength(en.trust.items.length);
    expect(fi.audience.items).toHaveLength(en.audience.items.length);
    expect(fi.how.discovery.steps).toHaveLength(4);
    expect(fi.how.requirements.steps).toHaveLength(4);
    expect(fi.paths.discovery.paragraphs).toHaveLength(en.paths.discovery.paragraphs.length);
  });

  it("carry the same numbers", () => {
    const numbers = (x: unknown): string[] =>
      (JSON.stringify(x).match(/\d+([.,]\d+)?/g) ?? []).map((n) => n.replace(",", ".")).sort();
    expect(numbers(fi)).toEqual(numbers(en));
  });

  it("are not the English text under a Finnish heading", () => {
    const same = [
      [fi.hero.title, en.hero.title],
      [fi.chatbot.heading, en.chatbot.heading],
      [fi.faq.items[0]?.a, en.faq.items[0]?.a],
      [fi.trust.items[0]?.body, en.trust.items[0]?.body],
    ];
    for (const [a, b] of same) expect(a).not.toEqual(b);
  });

  it("addresses the reader as 'sinä' and never in the plural or formal form", () => {
    const text = JSON.stringify(fi);
    expect(text).not.toMatch(/\b(te|teidän|teille|teidät)\b/i);
    expect(text).not.toMatch(/\bOlkaa\b|\bVoitte\b/);
  });
});

describe("claims the page may not make (docs/team/claims-2026-10.md, rows that are not Built)", () => {
  const all = (l: Locale): string => JSON.stringify(stringsFor(l).landing);
  const unbuilt = [
    /\bSSO\b|\bSAML\b|\bOIDC\b|single sign-on/i,
    /\bSlack\b|\bMicrosoft Teams\b|\bJira\b|\bLinear\b/,
    /\bwebhooks?\b/i,
    /\bbilling\b|\binvoice\b|\bsubscription\b/i,
    /pen(etration)? test|\bSOC ?2\b|ISO ?27001|certif/i,
    /real-time collaboration|collaborat/i,
    /\bGDPR[- ]compliant\b|fully compliant/i,
    /\bguarantee/i,
    /nothing leaves|never leaves|never leave/i,
    /\bGitHub\b/i,
  ];
  it.each(unbuilt.map((r) => [String(r), r] as const))("English and Finnish avoid %s", (_n, re) => {
    expect(all("en")).not.toMatch(re);
    expect(all("fi")).not.toMatch(re);
  });

  it("keeps the sign-in panel to Built claims too: no EU residency promise (E1, E2)", () => {
    // Found in the 2026-10-15 simulation: the panel said "Your data stays in the EU", which hosted
    // providers outside the EU make untrue (claims row E2).
    for (const l of ["en", "fi"] as const) {
      const panel = JSON.stringify(stringsFor(l).kit.brand);
      expect(panel).not.toMatch(/stays in the EU|in the EU|EU:ssa/i);
      for (const re of unbuilt) expect(panel).not.toMatch(re);
    }
  });

  it("states the one cost figure as a test figure", () => {
    const q = stringsFor("en").landing.faq.items.find((i) => /cost/i.test(i.q));
    expect(q?.a).toMatch(/internal test/);
    expect(q?.a).toMatch(/test figure, not a quote/);
    const f = stringsFor("fi").landing.faq.items.find((i) => /maksaa/i.test(i.q));
    expect(f?.a).toMatch(/testiluku/);
  });
});

describe("metadata and crawler files", () => {
  it("gives each language its own title, description and an indexable robots directive", async () => {
    const { generateMetadata } = await import("@/app/page");
    state.lang = "fi";
    const fi = await generateMetadata();
    expect(JSON.stringify(fi.title)).toContain("Ymmärrä ongelma");
    expect(fi.description).toBe(stringsFor("fi").landing.meta.description);
    expect(fi.robots).toEqual({ index: true, follow: true });
  });

  it("serves robots.txt and sitemap.xml for the configured origin, without the staff area", async () => {
    vi.stubEnv("AUTH_URL", "https://discover.example.org/some/path");
    const robots = await (await import("@/app/robots.txt/route")).GET();
    const text = await robots.text();
    expect(robots.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(text).toContain("Disallow: /admin");
    expect(text).toContain("Disallow: /p/");
    expect(text).toContain("Sitemap: https://discover.example.org/sitemap.xml");
    const sitemap = await (await import("@/app/sitemap.xml/route")).GET();
    const xml = await sitemap.text();
    expect(sitemap.headers.get("content-type")).toMatch(/xml/);
    expect(xml).toContain("<loc>https://discover.example.org/</loc>");
    expect(xml).not.toContain("/admin");
    vi.unstubAllEnvs();
  });
});

describe("contact address and origin helpers", () => {
  it("accepts one plain address and nothing that could add a recipient or a header", () => {
    expect(contactEmail({ NEXT_PUBLIC_CONTACT_EMAIL: " sales@example.com " })).toBe("sales@example.com");
    for (const bad of [
      "",
      "no-at-sign",
      "a@b",
      "a@b.co?bcc=x@y.zz",
      "a@b.co&cc=x@y.zz",
      "a@b.co,c@d.ee",
      "a b@c.dd",
      "<a@b.co>",
      "a@b.co\nBcc: x@y.zz",
      "javascript:alert(1)//@x.yy",
    ])
      expect(contactEmail({ NEXT_PUBLIC_CONTACT_EMAIL: bad }), bad).toBeNull();
    expect(contactEmail({})).toBeNull();
  });

  it("encodes the subject and body of the mail", () => {
    expect(mailtoHref("a@b.co", "Hello there", "Line one\nTwo & three")).toBe(
      "mailto:a@b.co?subject=Hello%20there&body=Line%20one%0ATwo%20%26%20three",
    );
  });

  it("prefers the configured URL to the request's host, and ignores a host that is not a name", () => {
    expect(publicOrigin({ env: { AUTH_URL: "https://x.example/" }, host: "evil.test" })).toBe(
      "https://x.example",
    );
    expect(publicOrigin({ env: {}, host: "app.example.com", forwardedProto: "https" })).toBe(
      "https://app.example.com",
    );
    expect(publicOrigin({ env: {}, host: "a b/../c" })).toBe("http://localhost:3000");
    expect(publicOrigin({ env: { AUTH_URL: "javascript:alert(1)" }, host: null })).toBe(
      "http://localhost:3000",
    );
  });
});
