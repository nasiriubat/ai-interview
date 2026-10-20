import { expect, test } from "@playwright/test";

/*
 * The product's mark (D-430, D-431): the platform's name from the API, with no letter tile beside
 * it, in the landing header, the sign-in page and the browser tab. The fake API sets no logo, so
 * the logo route answers 404 and nothing renders an image in its place.
 */

test("the landing header and the sign-in page show the name alone", async ({ page }) => {
  await page.goto("/");
  const home = page.locator("header a").first();
  await expect(home).toHaveText("AIScope");
  await expect(home.locator("[aria-hidden]")).toHaveCount(0);
  await expect(page).toHaveTitle(/^AIScope: /);

  await page.goto("/auth/signin");
  await expect(page.getByRole("link", { name: "AIScope" }).first()).toBeVisible();
  await expect(page.locator(".bg-brand-gradient")).toHaveCount(0);
});

test("the logo route answers from this origin, and 404 with no logo", async ({ request }) => {
  const res = await request.get("/api/branding/logo?v=missing");
  expect(res.status()).toBe(404);
  expect(res.headers()["cache-control"]).toBe("no-store");
});
