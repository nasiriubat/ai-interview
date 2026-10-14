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
  // The header shows the switch from 768 px; below that it is in the menu.
  const menu = page.getByRole("button", { name: /^(Menu|Valikko)$/ });
  const language = page.getByRole("button", { name: /^(Language|Kieli): / });
  if (await language.first().isVisible()) {
    await language.first().click();
  } else {
    await menu.click();
    await language.first().click();
  }
  await page.getByRole("menuitem", { name: /Suomi/ }).click();
  // The page behind an open dialog is inert, so close it to read the heading.
  if (await menu.isVisible().catch(() => false)) await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Ymmärrä ongelma", { timeout: 10_000 });
  await expect(page.locator("html")).toHaveAttribute("lang", "fi");
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Ymmärrä ongelma");
});

/*
 * Layout, at the widths the page is designed for (owner feedback of 2026-10-14: "broken topbar, no
 * responsiveness"). Each width is checked for what a person would see: one header row, nothing
 * sideways, nothing cut off at the right edge, screenshots loaded at their own size.
 */
const WIDTHS = [360, 390, 768, 1024, 1280, 1920, 2560] as const;

for (const width of WIDTHS) {
  test(`lays out cleanly at ${String(width)} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/", { waitUntil: "networkidle" });

    // No sideways scroll.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    // One header row: a fixed height, every control inside it and inside the screen.
    const header = page.getByRole("banner");
    const box = await header.boundingBox();
    expect(box?.height).toBeLessThanOrEqual(72);
    const stray = await page.evaluate(() => {
      const h = document.querySelector("header");
      if (!h) throw new Error("no header");
      const hb = h.getBoundingClientRect();
      const out: string[] = [];
      for (const el of h.querySelectorAll("a, button, select, [role=group]")) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue; // not shown at this width
        if (
          r.top < hb.top - 0.5 ||
          r.bottom > hb.bottom + 0.5 ||
          r.right > window.innerWidth + 0.5 ||
          r.left < -0.5
        )
          out.push(`${el.tagName} ${el.textContent.trim().slice(0, 20)} ${JSON.stringify(r)}`);
      }
      return out;
    });
    expect(stray).toEqual([]);

    // Nothing in the page runs past the right edge (a clipped card, a table that did not collapse).
    const clipped = await page.evaluate(() => {
      const out: string[] = [];
      for (const el of document.querySelectorAll("main *, footer *")) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.right > window.innerWidth + 1) out.push(`${el.tagName}.${el.className.slice(0, 40)}`);
      }
      return out.slice(0, 5);
    });
    expect(clipped).toEqual([]);

    // The inline navigation shows from 1280 px, the menu button below it.
    const menu = page.getByRole("button", { name: /^(Menu|Valikko)$/ });
    if (width >= 1280) {
      await expect(menu).toBeHidden();
      await expect(page.locator("header nav")).toBeVisible();
    } else {
      await expect(menu).toBeVisible();
      await expect(page.locator("header nav")).toBeHidden();
    }

    // The comparison collapses: side by side from 768 px, stacked below.
    const row = page.locator("#chatbot ul > li").first();
    const cells = row.locator(":scope > div");
    const a = await cells.nth(0).boundingBox();
    const b = await cells.nth(1).boundingBox();
    if (!a || !b) throw new Error("the comparison rows are not laid out");
    if (width >= 768) expect(Math.abs(a.y - b.y)).toBeLessThan(2);
    else expect(b.y - a.y).toBeGreaterThan(20);
  });
}

test("screenshots are loaded at their own size and the page does not shift", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __cls: number }).__cls = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const ls = e as unknown as { value: number; hadRecentInput: boolean };
        if (!ls.hadRecentInput) (window as unknown as { __cls: number }).__cls += ls.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  await page.goto("/", { waitUntil: "networkidle" });
  // Scroll the whole page so every lazy image loads.
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 500) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForLoadState("networkidle");
  const broken = await page.evaluate(() =>
    [...document.querySelectorAll("img")]
      .filter((i) => i.getBoundingClientRect().width > 0)
      .filter((i) => !i.complete || i.naturalWidth === 0)
      .map((i) => i.src),
  );
  expect(broken).toEqual([]);
  const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
  expect(cls).toBeLessThan(0.02);
});

test("the header stays at the top while the page scrolls", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.evaluate(() => {
    window.scrollTo(0, 1500);
  });
  const top = await page.getByRole("banner").evaluate((el) => el.getBoundingClientRect().top);
  expect(top).toBe(0);
});

test("the menu is a dialog: it traps focus, closes on Escape and returns focus", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/", { waitUntil: "networkidle" });
  const button = page.getByRole("button", { name: /^(Menu|Valikko)$/ });
  await button.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest("[role=dialog]")))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(button).toBeFocused();
  // A link in the menu goes to its section and closes the menu.
  await button.click();
  await dialog.getByRole("link").first().click();
  await expect(dialog).toBeHidden();
  expect(new URL(page.url()).hash).toBe("#paths");
});

test("shows the screenshot for the theme and only that one", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/", { waitUntil: "networkidle" });
  const hero = page.locator("#hero-title").locator("xpath=ancestor::section");
  const visible = await hero.locator("img.lp-shot-light, img.lp-shot-dark").evaluateAll((els) => {
    return els.filter((e) => getComputedStyle(e).display !== "none").map((e) => e.getAttribute("src"));
  });
  expect(visible).toEqual(["/landing/results-dark.webp"]);
  await page.evaluate(() => {
    document.documentElement.setAttribute("data-theme", "light");
  });
  const light = await hero.locator("img.lp-shot-light, img.lp-shot-dark").evaluateAll((els) => {
    return els.filter((e) => getComputedStyle(e).display !== "none").map((e) => e.getAttribute("src"));
  });
  expect(light).toEqual(["/landing/results-light.webp"]);
});

test("has Open Graph tags that point at this site", async ({ page, baseURL }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const og = await page.locator('meta[property="og:image"]').getAttribute("content");
  expect(og).toMatch(/\/landing\/og\.png$/);
  expect(new URL(og ?? "").origin).toBe(new URL(baseURL ?? "http://localhost:3100").origin);
  await expect(page.locator('meta[property="og:title"]')).toHaveCount(1);
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute("content", "summary_large_image");
  const res = await page.request.get("/landing/og.png");
  expect(res.ok()).toBe(true);
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
