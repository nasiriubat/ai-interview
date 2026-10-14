/*
 * The design review of the analysis workspace and the configuration and operator pages (D-370):
 * every page in every state this area has, at the widths, themes and languages a review looks at.
 * Not part of the test run; it writes images for a person to look at, and prints what overflows.
 *
 *   BASE=http://localhost:3410 OUT=/tmp/review \
 *     SHOTS=results WIDTHS=390,1280 THEMES=light LOCALES=en pnpm exec tsx scripts/review-shots.ts
 *
 * `SHOTS` is a regular expression over the shot names. The target must run against the fake API
 * (`e2e/fake-api.ts`), whose `/__scenario` endpoint selects the state of each shot.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium, type Page } from "@playwright/test";
import { encode } from "next-auth/jwt";

const BASE = process.env.BASE ?? "http://localhost:3410";
const OUT = process.env.OUT ?? "/tmp/review";
const SECRET = process.env.AUTH_SECRET ?? "e2e-auth-secret-e2e-auth-secret-0123456789";
const WIDTHS = (process.env.WIDTHS ?? "390,768,1280,1920").split(",").map(Number);
const THEMES = (process.env.THEMES ?? "light,dark").split(",");
const LOCALES = (process.env.LOCALES ?? "en").split(",");
const FILTER = new RegExp(process.env.SHOTS ?? ".");
const FULL = process.env.FULL !== "0";

interface Shot {
  name: string;
  path: string;
  scenario?: string;
  role?: string;
  /** Gets the page into the state worth looking at. */
  act?: (page: Page) => Promise<void>;
}

const R = "/admin/campaigns/camp1/results";
const click = async (page: Page, name: RegExp | string, nth = 0): Promise<void> => {
  await page.getByRole("button", { name }).nth(nth).click();
  await page.waitForTimeout(400);
};

const SHOTS: Shot[] = [
  { name: "results-overview", path: R },
  { name: "results-overview-table", path: R, act: (p) => click(p, /^Table$|^Taulukko$/) },
  { name: "results-opportunities", path: `${R}?tab=opportunities` },
  {
    name: "results-opportunity-panel",
    path: `${R}?tab=opportunities`,
    act: (p) => click(p, /Open details|Avaa tiedot/, 0),
  },
  {
    name: "results-opportunity-panel-withheld",
    path: `${R}?tab=opportunities`,
    scenario: "withheld",
    act: (p) => click(p, /Open details|Avaa tiedot/, 0),
  },
  {
    name: "results-weights",
    path: `${R}?tab=opportunities`,
    act: (p) => click(p, /Scoring weights|Pisteytyksen painot/),
  },
  { name: "results-departments", path: `${R}?tab=departments` },
  { name: "results-departments-withheld", path: `${R}?tab=departments`, scenario: "withheld" },
  { name: "results-departments-long", path: `${R}?tab=departments`, scenario: "long" },
  { name: "results-opportunities-long", path: `${R}?tab=opportunities`, scenario: "long" },
  { name: "results-history", path: `${R}?tab=history` },
  { name: "results-running", path: R, scenario: "running" },
  { name: "results-autoqueued", path: R, scenario: "autoqueued" },
  { name: "results-failed", path: R, scenario: "failed" },
  { name: "results-preliminary", path: R, scenario: "preliminary" },
  { name: "results-empty", path: R, scenario: "empty" },
  { name: "results-error", path: R, scenario: "error" },
  { name: "report", path: "/admin/campaigns/camp1/report" },
  { name: "report-empty", path: "/admin/campaigns/camp1/report", scenario: "empty" },
  { name: "report-error", path: "/admin/campaigns/camp1/report", scenario: "error" },
  { name: "providers", path: "/admin/providers" },
  { name: "providers-empty", path: "/admin/providers", scenario: "empty" },
  { name: "providers-error", path: "/admin/providers", scenario: "error" },
  { name: "provider-detail", path: "/admin/providers/p1" },
  { name: "provider-detail-empty", path: "/admin/providers/p1", scenario: "empty" },
  { name: "routes", path: "/admin/routes" },
  { name: "routes-empty", path: "/admin/routes", scenario: "empty" },
  { name: "budgets", path: "/admin/budgets" },
  { name: "budgets-empty", path: "/admin/budgets", scenario: "empty" },
  { name: "budgets-error", path: "/admin/budgets", scenario: "error" },
  { name: "statements", path: "/admin/budgets/statements" },
  { name: "statements-empty", path: "/admin/budgets/statements", scenario: "empty" },
  { name: "statement-detail", path: "/admin/budgets/statements/2026-09" },
  { name: "op-tenants", path: "/admin/operator", role: "platform_operator" },
  { name: "op-tenants-empty", path: "/admin/operator", role: "platform_operator", scenario: "empty" },
  { name: "op-tenants-error", path: "/admin/operator", role: "platform_operator", scenario: "error" },
  { name: "op-tenant", path: "/admin/operator/tenants/c2", role: "platform_operator" },
  { name: "op-providers", path: "/admin/operator/providers", role: "platform_operator" },
  { name: "op-provider", path: "/admin/operator/providers/p1", role: "platform_operator" },
  { name: "op-routes", path: "/admin/operator/routes", role: "platform_operator" },
  { name: "op-stats", path: "/admin/operator/stats", role: "platform_operator" },
  { name: "op-jobs", path: "/admin/operator/jobs", role: "platform_operator" },
  { name: "op-jobs-empty", path: "/admin/operator/jobs", role: "platform_operator", scenario: "empty" },
  { name: "op-health", path: "/admin/operator/health", role: "platform_operator" },
  { name: "op-health-empty", path: "/admin/operator/health", role: "platform_operator", scenario: "empty" },
  { name: "op-health-error", path: "/admin/operator/health", role: "platform_operator", scenario: "error" },
  { name: "op-statements", path: "/admin/operator/statements", role: "platform_operator" },
];

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const host = new URL(BASE).hostname;
const problems: string[] = [];

for (const shot of SHOTS.filter((s) => FILTER.test(s.name))) {
  // The state of the shot travels in the session token (D-370), so shots do not share any.
  const token = await encode({
    token: {
      email: "ada@acme.test",
      sub: "u1",
      ...(shot.role ? { role: shot.role } : {}),
      scenario: shot.scenario ?? "default",
    },
    secret: SECRET,
    salt: "authjs.session-token",
  });
  for (const locale of LOCALES) {
    for (const theme of THEMES) {
      for (const width of WIDTHS) {
        const context = await browser.newContext({
          viewport: { width, height: width < 600 ? 844 : 900 },
          locale: locale === "fi" ? "fi-FI" : "en-GB",
          colorScheme: theme === "dark" ? "dark" : "light",
        });
        await context.addCookies([
          { name: "authjs.session-token", value: token, domain: host, path: "/" },
          { name: "lang", value: locale, domain: host, path: "/" },
        ]);
        const page = await context.newPage();
        const csp: string[] = [];
        page.on("console", (m) => {
          // The dev server's own overlay injects styles the policy reports; a production build
          // (the e2e pass) is where a violation is a failure.
          if (/Refused to/i.test(m.text()) && !m.location().url.includes("next-devtools"))
            csp.push(m.text().slice(0, 140));
        });
        try {
          await page.goto(`${BASE}${shot.path}`, { waitUntil: "networkidle" });
          if (shot.act) await shot.act(page);
          const name = `${shot.name}-${locale}-${theme}-${String(width)}.png`;
          // A side panel is a fixed layer: the page shot is the viewport, not the whole document.
          await page.screenshot({ path: path.join(OUT, name), fullPage: FULL && !shot.act });
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          if (overflow > 1)
            problems.push(`HORIZONTAL SCROLL ${shot.name} ${locale} ${theme} ${String(width)}`);
          for (const c of csp) problems.push(`CSP ${shot.name}: ${c}`);
        } catch (e) {
          problems.push(`FAILED ${shot.name} ${String(width)}: ${(e as Error).message.slice(0, 120)}`);
        }
        await context.close();
      }
    }
  }
}
await browser.close();
for (const p of problems) console.warn(p);
console.warn(`wrote screenshots to ${OUT}; ${String(problems.length)} problems`);
