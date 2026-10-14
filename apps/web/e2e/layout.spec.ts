import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { encode } from "next-auth/jwt";
import { LIVE_TOKEN, PARTICIPANT_TOKEN } from "./fixtures";
import { PAGES } from "./pages";

/*
 * Layout assertions the accessibility pass cannot make (axe reads contrast and names, not whether a
 * sentence runs off the edge of its card), and a screenshot of each voice screen (D-326):
 *
 *  - the department panel of the results sidebar keeps every word inside its card, at a phone's
 *    width and at a desktop's (D-321: "Described by many: ..." clipped on the right);
 *  - the voice screens show their controls inside the viewport, with no sideways scroll, and are
 *    written to `e2e/results/screens/` so a person can look at them (they could not be captured
 *    before: they need a microphone and a call).
 */

const AUTH_SECRET = "e2e-auth-secret-e2e-auth-secret-0123456789";
const SCREENS = path.join(import.meta.dirname, "results", "screens");

async function signInStaff(page: Page, hostname: string): Promise<void> {
  const value = await encode({
    token: { email: "ada@acme.test", sub: "u1" },
    secret: AUTH_SECRET,
    salt: "authjs.session-token",
  });
  await page.context().addCookies([{ name: "authjs.session-token", value, domain: hostname, path: "/" }]);
}

test("department cards: no text leaves its card (D-321, D-374)", async ({ page }, info) => {
  await signInStaff(page, new URL(info.project.use.baseURL ?? "http://localhost:3100").hostname);
  await page.goto("/admin/campaigns/camp1/results?tab=departments", { waitUntil: "networkidle" });
  const cards = page.locator("ul[aria-label] > li").filter({ hasText: /Automatic reminder messages/ });
  await expect(cards.first()).toBeVisible();
  const card = cards.first();

  const longTitle = card.getByText(/Automatic reminder messages for appointments/);
  await expect(longTitle).toBeVisible();

  const offenders = await card.evaluate((root) => {
    const box = root.getBoundingClientRect();
    const out: string[] = [];
    for (const el of root.querySelectorAll<HTMLElement>("*")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // Wider than its own box (text running past it) or past the card's right edge.
      if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === "visible")
        out.push(
          `${el.tagName.toLowerCase()} overflows its box by ${String(el.scrollWidth - el.clientWidth)}px`,
        );
      if (r.right > box.right + 1)
        out.push(
          `${el.tagName.toLowerCase()} "${(el.textContent ?? "").slice(0, 30)}" ends ${String(Math.round(r.right - box.right))}px past the card`,
        );
    }
    return out;
  });
  expect(offenders).toEqual([]);

  // And no word is squeezed into a strip: the sentence's box is at least a third of the card, so
  // the "Most shared" list is not the one-word-wide column the demo had.
  const sentence = await longTitle.evaluate((el) => {
    const li = el.closest("li") ?? el;
    return { width: li.getBoundingClientRect().width };
  });
  const cardWidth = await card.evaluate((el) => el.getBoundingClientRect().width);
  expect(sentence.width).toBeGreaterThan(cardWidth / 3);
});

for (const id of ["interview-voice", "interview-voice-denied", "interview-voice-live"]) {
  test(`${id}: controls are inside the viewport, and the screen is captured`, async ({
    page,
    context,
  }, info) => {
    const entry = PAGES.find((p) => p.id === id);
    if (!entry) throw new Error(`no inventory entry ${id}`);
    const hostname = new URL(info.project.use.baseURL ?? "http://localhost:3100").hostname;
    await context.addCookies([
      {
        name: "aidp_participant",
        value: entry.token ?? PARTICIPANT_TOKEN,
        domain: hostname,
        path: "/",
      },
    ]);
    expect([PARTICIPANT_TOKEN, LIVE_TOKEN]).toContain(entry.token ?? PARTICIPANT_TOKEN);
    await entry.before?.(page);
    await page.goto(entry.path, { waitUntil: "networkidle" });
    await entry.prepare?.(page);
    await page.waitForTimeout(600);

    const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
    const outside = await page.evaluate((w) => {
      const out: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>("button, [role='button'], textarea, input")) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (getComputedStyle(el).visibility === "hidden") continue;
        if (r.left < -1 || r.right > w + 1)
          out.push(
            `${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30)}" spans ${String(Math.round(r.left))} to ${String(Math.round(r.right))} of ${String(w)}`,
          );
      }
      return out;
    }, viewport.width);
    expect(outside).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
      "horizontal page overflow",
    ).toBeLessThanOrEqual(0);

    mkdirSync(SCREENS, { recursive: true });
    await page.screenshot({ path: path.join(SCREENS, `${id}-${info.project.name}.png`) });
  });
}
