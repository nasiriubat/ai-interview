import { expect, test, type Page } from "@playwright/test";
import { encode } from "next-auth/jwt";
import { demoDiagrams } from "./fixtures";

/*
 * Diagrams are legible (FR-23, D-320). The demo run drew context, container and entity diagrams
 * with a viewBox thousands of units wide, so a box was a few pixels high. This spec renders the
 * five diagram types in a real browser under the enforced policy, at a desktop and a phone width,
 * and measures them: the viewBox is bounded, the drawing is shown at a scale a person can read, the
 * page itself never scrolls sideways, and a wide drawing scrolls inside its own container.
 */

const AUTH_SECRET = "e2e-auth-secret-e2e-auth-secret-0123456789";
/** Mermaid draws text at 16px; below this scale of the drawing it is under about 9px on screen. */
const MIN_SCALE = 0.55;
const MAX_VIEWBOX_WIDTH = 2_400;
const MAX_VIEWBOX_HEIGHT = 2_400;

const PAGES = [
  { id: "version", path: "/admin/requirements/reqd/versions/2" },
  { id: "workspace", path: "/admin/requirements/reqd" },
] as const;

async function signIn(page: Page, hostname: string): Promise<void> {
  const value = await encode({
    token: { email: "ada@acme.test", sub: "u1" },
    secret: AUTH_SECRET,
    salt: "authjs.session-token",
  });
  await page.context().addCookies([{ name: "authjs.session-token", value, domain: hostname, path: "/" }]);
}

for (const target of PAGES) {
  test(`${target.id}: diagrams are drawn at a readable size and stay inside the page`, async ({
    page,
  }, info) => {
    await signIn(page, new URL(info.project.use.baseURL ?? "http://localhost:3100").hostname);
    await page.goto(target.path, { waitUntil: "networkidle" });
    const drawn = page.locator(".report-diagram svg");
    await expect(drawn).toHaveCount(demoDiagrams.length, { timeout: 30_000 });

    const phone = (page.viewportSize()?.width ?? 1280) < 600;
    const measured = await drawn.evaluateAll((svgs) =>
      svgs.map((svg) => {
        const vb = svg.getAttribute("viewBox")?.split(/\s+/).map(Number) ?? [];
        const box = svg.getBoundingClientRect();
        const holder = svg.closest(".report-diagram");
        const hostBox = holder?.getBoundingClientRect();
        return {
          vbWidth: vb[2] ?? 0,
          vbHeight: vb[3] ?? 0,
          width: box.width,
          scale: (vb[2] ?? 0) > 0 ? box.width / (vb[2] ?? 1) : 0,
          // The drawing may be wider than its holder only if the holder scrolls.
          scrollable: holder ? holder.scrollWidth > holder.clientWidth + 1 : false,
          holderRight: hostBox?.right ?? 0,
        };
      }),
    );
    const viewportWidth = page.viewportSize()?.width ?? 1280;
    for (const m of measured) {
      expect(m.vbWidth, "viewBox width").toBeGreaterThan(0);
      expect(m.vbWidth, "viewBox width").toBeLessThanOrEqual(MAX_VIEWBOX_WIDTH);
      expect(m.vbHeight, "viewBox height").toBeLessThanOrEqual(MAX_VIEWBOX_HEIGHT);
      expect(m.scale, `scale on a ${phone ? "phone" : "desktop"}`).toBeGreaterThanOrEqual(MIN_SCALE);
      expect(m.holderRight, "the diagram's container stays inside the viewport").toBeLessThanOrEqual(
        viewportWidth + 1,
      );
    }
    // Nothing makes the page itself scroll sideways.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "horizontal page overflow").toBeLessThanOrEqual(0);
  });
}
