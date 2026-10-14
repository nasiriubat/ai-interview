import { expect, test, type Page } from "@playwright/test";
import { LINK_TOKEN } from "./fixtures";

/*
 * Layout assertions for the participant's screens (D-380): the people who open these links do it on
 * a phone, often one-handed, so the page must never scroll sideways, a long word must wrap inside
 * its bubble, and every control must be big enough to hit and inside the viewport.
 */

const STATES: { id: string; path: string; token?: string }[] = [
  { id: "arrival", path: `/p/${LINK_TOKEN}` },
  { id: "link-closed", path: "/p/closed-link" },
  { id: "link-expired", path: "/p/expired-link" },
  { id: "link-missing", path: "/p/missing-link" },
  { id: "interview", path: "/p/session", token: "e2e-participant-token" },
  { id: "interview-long", path: "/p/session", token: "e2e-long-token" },
  { id: "interview-ended", path: "/p/session", token: "e2e-ended-token" },
  { id: "interview-paused", path: "/p/session", token: "e2e-paused-token" },
];

/** Interactive controls shorter than this are too small for a thumb. */
const MIN_TOUCH = 36;

async function findings(page: Page): Promise<string[]> {
  return page.evaluate((minTouch) => {
    const out: string[] = [];
    const vw = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > vw + 1)
      out.push(`page scrolls sideways: ${String(document.documentElement.scrollWidth)} > ${String(vw)}`);
    const scrollsX = (el: Element | null): boolean => {
      for (let p = el; p && p !== document.body; p = p.parentElement) {
        const o = getComputedStyle(p).overflowX;
        if (o === "auto" || o === "scroll" || o === "hidden") return true;
      }
      return false;
    };
    for (const el of document.querySelectorAll<HTMLElement>("main *, header *, footer *")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === "hidden") continue;
      if (el.closest(".sr-only") || getComputedStyle(el).position === "fixed") continue;
      const text = (el.textContent ?? "").trim().slice(0, 30);
      if (!scrollsX(el) && r.right > vw + 1)
        out.push(
          `${el.tagName.toLowerCase()} "${text}" ends ${String(Math.round(r.right - vw))}px past the screen`,
        );
      if (!scrollsX(el) && r.left < -1)
        out.push(
          `${el.tagName.toLowerCase()} "${text}" starts ${String(Math.round(-r.left))}px before the screen`,
        );
      // A radio is hit through its label, which the tile makes as wide and tall as the tile.
      const interactive = el.matches("button:not([role=radio]), a[href], [role=button], summary, select");
      // A radio inside a tile is hit through the whole tile (its label), so its own box is small.
      if (interactive && r.height < minTouch && !el.closest("p, li > p, label"))
        out.push(`${el.tagName.toLowerCase()} "${text}" is ${String(Math.round(r.height))}px high`);
    }
    return out;
  }, MIN_TOUCH);
}

for (const state of STATES) {
  test(`${state.id}: no sideways scroll, nothing clipped, controls big enough`, async ({
    page,
    context,
  }, info) => {
    const hostname = new URL(info.project.use.baseURL ?? "http://localhost:3100").hostname;
    if (state.token)
      await context.addCookies([
        { name: "aidp_participant", value: state.token, domain: hostname, path: "/" },
      ]);
    await page.goto(state.path, { waitUntil: "networkidle" });
    await page.getByRole("heading").first().waitFor();
    expect(await findings(page)).toEqual([]);
  });
}

test("a long unbroken word stays inside its bubble", async ({ page, context }, info) => {
  const hostname = new URL(info.project.use.baseURL ?? "http://localhost:3100").hostname;
  await context.addCookies([
    { name: "aidp_participant", value: "e2e-long-token", domain: hostname, path: "/" },
  ]);
  await page.goto("/p/session", { waitUntil: "networkidle" });
  const bubble = page.getByText(/Supercalifragilistic/).first();
  await expect(bubble).toBeVisible();
  const [inner, outer] = await bubble.evaluate((el) => {
    const parent = el.closest("li") ?? el.parentElement;
    return [el.getBoundingClientRect().right, parent?.getBoundingClientRect().right ?? 0];
  });
  expect(inner).toBeLessThanOrEqual((outer ?? 0) + 1);
});
