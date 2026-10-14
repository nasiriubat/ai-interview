import { expect, test } from "@playwright/test";

/*
 * The auth pages and the global states as layout (D-390 to D-392): axe reads contrast and names,
 * not whether a page fits. Every page, at this project's width: no sideways scroll, one h1, the
 * illustration is decorative, and the sign-in page is split only where there is room for it.
 */

const PAGES = [
  "/auth/signin",
  "/auth/signin?reason=expired",
  "/auth/verify",
  "/auth/error?error=Configuration",
  "/auth/signout",
  "/maintenance",
  "/no-such-page",
  "/dev/states",
];

for (const path of PAGES) {
  test(`${path}: fits the screen with one heading`, async ({ page }) => {
    await page.goto(path);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    const exposed = await page.locator("svg[viewBox='0 0 160 120']:not([aria-hidden='true'])").count();
    expect(exposed).toBe(0);
  });
}

test("sign-in shows the brand panel only on a wide screen", async ({ page }, info) => {
  await page.goto("/auth/signin");
  const panel = page.locator("aside");
  const width = info.project.use.viewport?.width ?? 1280;
  if (width >= 1024) {
    await expect(panel).toBeVisible();
    const box = await page.locator("main").boundingBox();
    expect(box?.x ?? 0).toBeGreaterThan(300);
  } else {
    await expect(panel).toBeHidden();
  }
  await expect(page.getByLabel(/work email|työsähköposti/i)).toBeVisible();
});

test("going offline shows the banner and coming back removes it", async ({ page, context }) => {
  await page.goto("/auth/signin");
  await context.setOffline(true);
  await expect(page.getByText(/you are offline|olet offline/i)).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByText(/you are offline|olet offline/i)).toHaveCount(0);
});

test("the sign-out confirmation offers to stay", async ({ page }) => {
  await page.goto("/auth/signout");
  await expect(page.getByRole("link", { name: /stay signed in|pysy kirjautuneena/i })).toBeVisible();
});
