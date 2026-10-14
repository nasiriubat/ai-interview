import { expect, test, type Page } from "@playwright/test";
import { encode } from "next-auth/jwt";

/*
 * Layout and behaviour of the campaign, template and prompt pages (D-361, D-363): what axe cannot
 * say (does the page scroll sideways, does a long name stay in its header, is every icon button
 * named) and the few interactions that carry the area.
 */

const AUTH_SECRET = "e2e-auth-secret-e2e-auth-secret-0123456789";

async function signIn(page: Page, hostname: string): Promise<void> {
  const value = await encode({
    token: { email: "ada@acme.test", sub: "u1" },
    secret: AUTH_SECRET,
    salt: "authjs.session-token",
  });
  await page.context().addCookies([{ name: "authjs.session-token", value, domain: hostname, path: "/" }]);
}

const hostOf = (base: string | undefined): string => new URL(base ?? "http://localhost:3100").hostname;

const AREA_PAGES = [
  "/admin/campaigns/camp1",
  "/admin/campaigns/camp1?tab=invitations",
  "/admin/campaigns/camp1?tab=sessions",
  "/admin/campaigns/camp1?tab=analysis",
  "/admin/campaigns/camp1?tab=settings",
  "/admin/campaigns/campEmpty?tab=invitations",
  "/admin/campaigns/campErr?tab=invitations",
  "/admin/campaigns/campLong?tab=sessions",
  "/admin/campaigns/camp1/edit",
  "/admin/campaigns/new",
  "/admin/templates",
  "/admin/templates/tpl1",
  "/admin/templates/tpl1/edit",
  "/admin/prompts",
  "/admin/prompts/interviewer",
];

for (const path of AREA_PAGES) {
  test(`${path}: no sideways scroll, every button named, one h1`, async ({ page }, info) => {
    await signIn(page, hostOf(info.project.use.baseURL));
    await page.goto(path, { waitUntil: "networkidle" });
    await expect(page.locator("h1")).toHaveCount(1);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "horizontal page overflow").toBeLessThanOrEqual(0);

    const unnamed = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("button, a[role='button']")]
        .filter((el) => el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== "hidden")
        .filter((el) => (el.getAttribute("aria-label") ?? el.textContent ?? "").trim() === "")
        // A switch or checkbox is named by its <label>, which is a name too.
        .filter((el) => el.getAttribute("aria-labelledby") === null)
        .filter((el) => ((el as HTMLButtonElement).labels?.length ?? 0) === 0)
        .map((el) => el.outerHTML.slice(0, 120)),
    );
    expect(unnamed).toEqual([]);
  });
}

test("a very long campaign name wraps inside the header and keeps the actions in view", async ({
  page,
}, info) => {
  await signIn(page, hostOf(info.project.use.baseURL));
  await page.goto("/admin/campaigns/campLong", { waitUntil: "networkidle" });
  const width = page.viewportSize()?.width ?? 1280;
  const h1 = await page.locator("h1").boundingBox();
  expect((h1?.x ?? 0) + (h1?.width ?? 0)).toBeLessThanOrEqual(width);
  const action = await page.getByRole("button", { name: /Close campaign|Sulje kampanja/ }).boundingBox();
  expect((action?.x ?? 0) + (action?.width ?? 0)).toBeLessThanOrEqual(width);
});

test("invitations: page, filter and search are read from the URL by the server", async ({ page }, info) => {
  await signIn(page, hostOf(info.project.use.baseURL));
  await page.goto("/admin/campaigns/camp1?tab=invitations&status=revoked&q=sara", {
    waitUntil: "networkidle",
  });
  const rows = page.locator("tbody tr:visible, [role='list'] > *:visible");
  await expect(rows.first()).toContainText(/sara/);
  expect(await rows.count()).toBeLessThan(12);
});

test("invitations: the composer counts what it understood and asks before a mass send", async ({
  page,
}, info) => {
  test.skip(info.project.name.startsWith("fi"), "English wording");
  await signIn(page, hostOf(info.project.use.baseURL));
  await page.goto("/admin/campaigns/camp1?tab=invitations", { waitUntil: "networkidle" });
  const box = page.getByLabel(/Email addresses/);
  await box.fill("a@x.test, b@x.test, nope");
  await expect(page.getByText("2 addresses recognised")).toBeVisible();
  await box.fill(Array.from({ length: 60 }, (_v, i) => `p${String(i)}@x.test`).join("\n"));
  await page.getByRole("button", { name: "Send 60 invitations" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Send 60 invitations?");
  await page.getByRole("button", { name: "Cancel" }).click();
});

test("template page: archive asks first, and the versions table names its icon actions", async ({
  page,
}, info) => {
  test.skip(info.project.name.startsWith("fi"), "English wording");
  await signIn(page, hostOf(info.project.use.baseURL));
  await page.goto("/admin/templates/tpl1", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toContainText(/Archive .*\?/);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: /^Restore \d+$/ }).first()).toBeVisible();
});

test("template editor: the section bar jumps to a section and the save bar is in view", async ({
  page,
}, info) => {
  test.skip(info.project.name.startsWith("fi"), "English wording");
  await signIn(page, hostOf(info.project.use.baseURL));
  await page.goto("/admin/templates/tpl1/edit", { waitUntil: "networkidle" });
  await page
    .getByRole("navigation", { name: "Jump to a section" })
    .getByRole("link", { name: "Closing and limits" })
    .click();
  await expect(page.locator("#section-closing")).toBeInViewport();
  await expect(page.getByTestId("save-bar")).toBeInViewport();
});
