import { expect, test, type Page } from "@playwright/test";
import { encode } from "next-auth/jwt";

/*
 * The admin shell and the table pages, as layout (D-340, D-348): axe reads contrast and names, not
 * whether the page fits its screen. Every converted page, at this project's width:
 *
 *  - never scrolls sideways;
 *  - on a desktop the content panel runs to within the gutter of the right edge (it is fluid, not a
 *    centred column), and sits beside the sidebar with a small gap;
 *  - the top bar is present, with a trail and the person's menu;
 *  - a table is cards on a phone and a table on a desktop.
 */

const AUTH_SECRET = "e2e-auth-secret-e2e-auth-secret-0123456789";
const PAGES = [
  "/admin",
  "/admin/campaigns",
  "/admin/users",
  "/admin/audit",
  "/admin/account",
  "/admin/settings",
  "/dev/ui",
];

async function signInStaff(page: Page, hostname: string): Promise<void> {
  const value = await encode({
    token: { email: "ada@acme.test", sub: "u1" },
    secret: AUTH_SECRET,
    salt: "authjs.session-token",
  });
  await page.context().addCookies([{ name: "authjs.session-token", value, domain: hostname, path: "/" }]);
}

test.beforeEach(async ({ page }, info) => {
  await signInStaff(page, new URL(info.project.use.baseURL ?? "http://localhost:3100").hostname);
});

for (const path of PAGES) {
  test(`${path}: fits the screen and has the shell`, async ({ page }) => {
    await page.goto(path, { waitUntil: "networkidle" });
    const width = page.viewportSize()?.width ?? 0;
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "page scrolls sideways").toBeLessThanOrEqual(1);
    if (path === "/dev/ui") return;

    await expect(page.getByRole("banner").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /account menu|tilin valikko/i })).toBeVisible();

    if (width >= 1024) {
      const box = await page.locator("main#main").boundingBox();
      const panel = await page.locator("main#main").evaluate((m) => {
        const card = m.parentElement;
        if (!card) throw new Error("main has no parent");
        const r = card.getBoundingClientRect();
        return { left: r.left, right: r.right };
      });
      expect(box).not.toBeNull();
      // Fluid: the panel ends at the right gutter (8px), however wide the screen is.
      expect(width - panel.right).toBeLessThanOrEqual(12);
      // A small gap from the sidebar, not touching it and not a wide margin.
      const sidebar = await page.getByRole("complementary", { name: /sidebar|sivupalkki/i }).boundingBox();
      expect(sidebar).not.toBeNull();
      const gap = panel.left - ((sidebar?.x ?? 0) + (sidebar?.width ?? 0));
      expect(gap).toBeGreaterThanOrEqual(4);
      expect(gap).toBeLessThanOrEqual(16);
    } else {
      await expect(page.getByRole("button", { name: /open menu|avaa valikko/i })).toBeVisible();
    }
  });
}

test("a table is cards on a phone and a table on a desktop", async ({ page }) => {
  await page.goto("/admin/users", { waitUntil: "networkidle" });
  const width = page.viewportSize()?.width ?? 0;
  const row = page.getByRole("row").nth(1);
  const display = await row.evaluate((r) => getComputedStyle(r).display);
  if (width < 768) expect(display).toBe("grid");
  else expect(display).toMatch(/table-row/);
});

test("the sidebar collapses to icons that keep their names, and stays collapsed after a reload", async ({
  page,
}) => {
  test.skip((page.viewportSize()?.width ?? 0) < 1024, "no sidebar below the desktop breakpoint");
  await page.goto("/admin/users", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /collapse sidebar|pienennä sivupalkki/i }).click();
  const sidebar = page.getByRole("complementary", { name: /sidebar|sivupalkki/i });
  await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 999).toBeLessThan(80);
  await page.reload({ waitUntil: "networkidle" });
  expect((await sidebar.boundingBox())?.width ?? 999).toBeLessThan(80);
  await expect(page.getByRole("link", { name: /campaigns|kampanjat/i }).first()).toBeVisible();
});

test("the quick search opens with the keyboard and goes to a page", async ({ page }, info) => {
  await page.goto("/admin", { waitUntil: "networkidle" });
  await page.keyboard.press("Control+k");
  const box = page.getByRole("combobox");
  await expect(box).toBeVisible();
  await box.fill(info.project.name.startsWith("fi") ? "käyttäjät" : "users");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/admin\/users/);
});
