import { expect, test, type Page } from "@playwright/test";

/*
 * The public landing page, beyond what axe sees (`axe.spec.ts` runs it too, as `root`, `root-faq-open`
 * and `root-signed-in`): it must raise no Content-Security-Policy event, ask no other host for
 * anything, fit the screen without sideways scroll, and switch language without a reload by hand.
 */

declare global {
  interface Window {
    __csp: string[];
  }
}

async function watchCsp(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      window.__csp.push(`${e.effectiveDirective} ${e.blockedURI}`);
    });
  });
}

test("raises no CSP event and requests nothing from another host", async ({ page, baseURL }) => {
  await watchCsp(page);
  const foreign: string[] = [];
  const own = new URL(baseURL ?? "http://localhost:3100").origin;
  page.on("request", (r) => {
    const u = r.url();
    if (!u.startsWith("data:") && !u.startsWith("blob:") && new URL(u).origin !== own) foreign.push(u);
  });
  await page.goto("/", { waitUntil: "networkidle" });
  // Interacting must not load anything new either: open a question and use the switches.
  await page.locator("details > summary").first().click();
  await page.waitForLoadState("networkidle");
  expect(await page.evaluate(() => window.__csp)).toEqual([]);
  expect(foreign).toEqual([]);
});

test("has one h1 and the landmarks, and the skip link reaches the main content", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByRole("banner")).toHaveCount(1);
  await expect(page.getByRole("main")).toHaveCount(1);
  await expect(page.getByRole("contentinfo")).toHaveCount(1);
  await page.keyboard.press("Tab");
  await expect(page.locator("a[href='#main']")).toBeFocused();
});

test("fits the screen without sideways scroll", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("switches language from the page and keeps it", async ({ page, context }) => {
  await context.addCookies([{ name: "lang", value: "en", domain: "localhost", path: "/" }]);
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.getByLabel(/^(Language|Kieli)$/).selectOption("fi");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Ymmärrä ongelma", { timeout: 10_000 });
  await expect(page.locator("html")).toHaveAttribute("lang", "fi");
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Ymmärrä ongelma");
});

test("serves robots.txt and sitemap.xml", async ({ request }) => {
  const robots = await request.get("/robots.txt");
  expect(robots.ok()).toBe(true);
  const text = await robots.text();
  expect(text).toContain("Disallow: /admin");
  expect(text).toMatch(/Sitemap: https?:\/\/[^\s]+\/sitemap\.xml/);
  const sitemap = await request.get("/sitemap.xml");
  expect(sitemap.ok()).toBe(true);
  expect(await sitemap.text()).toContain("<urlset");
});
