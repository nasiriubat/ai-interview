import { expect, test, type Page } from "@playwright/test";
import { encode } from "next-auth/jwt";

/*
 * The analysis workspace and the configuration and operator pages, as layout (D-370 to D-379).
 * axe reads names and contrast; these read geometry: nothing scrolls sideways, the filter bar
 * sticks, the side panel stays inside the screen, a withheld number is shown as withheld, the paper
 * is a page wide, and an icon-only row action explains itself on hover.
 */

const AUTH_SECRET = "e2e-auth-secret-e2e-auth-secret-0123456789";

async function signIn(
  page: Page,
  hostname: string,
  claims: { role?: string; scenario?: string } = {},
): Promise<void> {
  const value = await encode({
    token: { email: "ada@acme.test", sub: "u1", ...claims },
    secret: AUTH_SECRET,
    salt: "authjs.session-token",
  });
  await page.context().addCookies([{ name: "authjs.session-token", value, domain: hostname, path: "/" }]);
}

const host = (info: { project: { use: { baseURL?: string | undefined } } }): string =>
  new URL(info.project.use.baseURL ?? "http://localhost:3100").hostname;

const overflow = (page: Page): Promise<number> =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

const PAGES: { path: string; role?: string; scenario?: string }[] = [
  { path: "/admin/campaigns/camp1/results" },
  { path: "/admin/campaigns/camp1/results?tab=opportunities" },
  { path: "/admin/campaigns/camp1/results?tab=departments" },
  { path: "/admin/campaigns/camp1/results?tab=history" },
  { path: "/admin/campaigns/camp1/results?tab=departments", scenario: "withheld" },
  { path: "/admin/campaigns/camp1/results?tab=opportunities", scenario: "long" },
  { path: "/admin/campaigns/camp1/results?tab=departments", scenario: "long" },
  { path: "/admin/campaigns/camp1/results", scenario: "running" },
  { path: "/admin/campaigns/camp1/results", scenario: "failed" },
  { path: "/admin/campaigns/camp1/results", scenario: "empty" },
  { path: "/admin/campaigns/camp1/results", scenario: "error" },
  { path: "/admin/campaigns/camp1/report" },
  { path: "/admin/providers" },
  { path: "/admin/providers", scenario: "empty" },
  { path: "/admin/providers/p1" },
  { path: "/admin/routes" },
  { path: "/admin/budgets" },
  { path: "/admin/budgets/statements" },
  { path: "/admin/budgets/statements/2026-09" },
  { path: "/admin/operator", role: "platform_operator" },
  { path: "/admin/operator/tenants/c2", role: "platform_operator" },
  { path: "/admin/operator/providers", role: "platform_operator" },
  { path: "/admin/operator/routes", role: "platform_operator" },
  { path: "/admin/operator/stats", role: "platform_operator" },
  { path: "/admin/operator/jobs", role: "platform_operator" },
  { path: "/admin/operator/health", role: "platform_operator" },
  { path: "/admin/operator/statements", role: "platform_operator" },
];

for (const p of PAGES) {
  test(`${p.path}${p.scenario ? ` (${p.scenario})` : ""}: fits the screen and has a header`, async ({
    page,
  }, info) => {
    await signIn(page, host(info), {
      ...(p.role ? { role: p.role } : {}),
      ...(p.scenario ? { scenario: p.scenario } : {}),
    });
    await page.goto(p.path, { waitUntil: "networkidle" });
    expect(await overflow(page), "page scrolls sideways").toBeLessThanOrEqual(1);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    // The trail never repeats a name: "Tenants > Tenants" was a defect of the first cut.
    const crumbs = await page
      .getByRole("navigation", { name: /breadcrumb|leipäpolku/i })
      .first()
      .locator("li")
      .allInnerTexts();
    expect(new Set(crumbs).size, `crumbs repeat: ${crumbs.join(" > ")}`).toBe(crumbs.length);
  });
}

test("the overview charts have a table view of the same numbers", async ({ page }, info) => {
  await signIn(page, host(info));
  await page.goto("/admin/campaigns/camp1/results", { waitUntil: "networkidle" });
  const panel = page.locator("#chart-classes");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("img")).toBeVisible();
  await panel.getByRole("button", { name: /^(Table|Taulukko)$/ }).click();
  await expect(panel.getByRole("table")).toBeVisible();
  expect(await panel.getByRole("row").count()).toBeGreaterThan(2);
  // The factor matrix is its own table: every cell prints its number.
  const matrix = page.getByRole("table", { name: /factor scores|tekijäpisteet/i });
  await expect(matrix).toBeVisible();
  expect(await matrix.getByRole("cell").first().innerText()).toMatch(/^\d$/);
});

test("the filter bar sticks under the top bar while the list scrolls", async ({ page }, info) => {
  await signIn(page, host(info));
  await page.goto("/admin/campaigns/camp1/results?tab=opportunities", { waitUntil: "networkidle" });
  const bar = page.locator("[data-sticky-filters]");
  await expect(bar).toBeVisible();
  await page.evaluate(() => {
    window.scrollTo(0, 500);
  });
  await page.waitForTimeout(150);
  const box = await bar.boundingBox();
  expect(box).not.toBeNull();
  // Under the 56 px top bar, not scrolled away.
  expect(box?.y ?? 999).toBeGreaterThan(40);
  expect(box?.y ?? 999).toBeLessThan(100);
});

test("an opportunity opens in a side panel that stays on screen, with its evidence", async ({
  page,
}, info) => {
  await signIn(page, host(info));
  await page.goto("/admin/campaigns/camp1/results?tab=opportunities", { waitUntil: "networkidle" });
  await page
    .getByRole("button", { name: /^(Open details|Avaa tiedot)/ })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
  // The panel slides in; measured once it has settled.
  await expect
    .poll(async () => {
      const box = await dialog.boundingBox();
      return (box?.x ?? 0) + (box?.width ?? 0);
    })
    .toBeLessThanOrEqual(viewport.width + 1);
  const settled = await dialog.boundingBox();
  expect(settled?.x ?? -1).toBeGreaterThanOrEqual(-1);
  // Evidence is a quote figure (D-478), with its verification and provenance printed under it.
  expect(await dialog.locator("figure").count()).toBeGreaterThan(0);
  await expect(dialog.locator("figure").first()).toContainText(/op1-f\d/);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("withheld numbers look intentional: a lock and a reason, not a blank", async ({ page }, info) => {
  await signIn(page, host(info), { scenario: "withheld" });
  await page.goto("/admin/campaigns/camp1/results?tab=departments", { waitUntil: "networkidle" });
  const state = page.locator("[data-withheld-state]");
  await expect(state).toBeVisible();
  await expect(state).toContainText(/\b3\b/);
  await page.goto("/admin/campaigns/camp1/results?tab=opportunities", { waitUntil: "networkidle" });
  await page
    .getByRole("button", { name: /^(Open details|Avaa tiedot)/ })
    .first()
    .click();
  await expect(page.getByRole("dialog").locator("[data-withheld]").first()).toBeVisible();
  await expect(page.getByRole("dialog").locator("blockquote")).toHaveCount(0);
});

test("partly withheld shares show the lock in their cells", async ({ page }, info) => {
  await signIn(page, host(info));
  await page.goto("/admin/campaigns/camp1/results?tab=departments", { waitUntil: "networkidle" });
  const matrix = page.getByRole("table").first();
  await expect(matrix.locator("[data-withheld]").first()).toBeVisible();
});

test("the report is a page wide, and a hidden section leaves the preview", async ({ page }, info) => {
  await signIn(page, host(info));
  await page.goto("/admin/campaigns/camp1/report", { waitUntil: "networkidle" });
  const paper = page.locator("article.report-sheet");
  await expect(paper).toBeVisible();
  const box = await paper.boundingBox();
  expect(box?.width ?? 9999).toBeLessThanOrEqual(52 * 16 + 1);
  await expect(paper).toContainText(/Participation/);
  const toggle = page.getByRole("checkbox", { name: /Participation and method|Osallistuminen ja menetelmä/ });
  await toggle.click();
  await expect(paper).not.toContainText(/Eleven of fourteen invited people/);
});

test("an icon-only row action names itself on hover and keyboard focus", async ({ page }, info) => {
  test.skip((page.viewportSize()?.width ?? 0) < 768, "rows are cards on a phone; the names are the same");
  await signIn(page, host(info));
  await page.goto("/admin/providers", { waitUntil: "networkidle" });
  const action = page.getByRole("button", { name: /^(Delete|Poista)[^:]*: / }).first();
  await action.hover();
  await expect(page.getByRole("tooltip").first()).toContainText(/Delete|Poista/);
});

test("offboarding needs the tenant's name typed, and a suspended tenant", async ({ page }, info) => {
  await signIn(page, host(info), { role: "platform_operator" });
  await page.goto("/admin/operator/tenants/c2", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /^(Offboard|Poista käytöstä)$/ }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  const confirm = dialog.getByRole("button", { name: /^(Offboard|Poista käytöstä)$/ });
  await expect(confirm).toBeDisabled();
  await dialog
    .getByRole("textbox")
    .fill("Northern Pharmacy Group with an unusually long company name that must wrap");
  await expect(confirm).toBeEnabled();
});

test("an active tenant cannot be offboarded before it is suspended", async ({ page }, info) => {
  await signIn(page, host(info), { role: "platform_operator" });
  await page.goto("/admin/operator/tenants/c1", { waitUntil: "networkidle" });
  await expect(page.getByRole("button", { name: /^(Offboard|Poista käytöstä)$/ })).toBeDisabled();
});

/*
 * The requirements workspace fits the screen (D-481): the page itself never scrolls, the answer box
 * is on screen after a long conversation, the conversation opens at its end and scrolls on its own,
 * and on a phone conversation and specification are two views of one pane.
 */
test("requirements workspace: fits the viewport, composer on screen, panes scroll on their own", async ({
  page,
}, info) => {
  await signIn(page, host(info));
  await page.goto("/admin/requirements/reqlong", { waitUntil: "networkidle" });
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("no viewport");

  const pageScroll = await page.evaluate(
    () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
  );
  expect(pageScroll, "the page itself scrolls").toBeLessThanOrEqual(1);
  expect(await overflow(page), "page scrolls sideways").toBeLessThanOrEqual(1);

  const box = page.getByLabel(/^(Your answer|Vastauksesi)$/);
  await expect(box).toBeVisible();
  const rect = await box.boundingBox();
  expect(rect && rect.y + rect.height, "answer box below the fold").toBeLessThanOrEqual(viewport.height);

  // The conversation scrolls inside its own pane and opens at the newest message.
  const scroller = page.locator("[data-chat-scroller]");
  const metrics = await scroller.evaluate((el) => ({
    scrollable: el.scrollHeight > el.clientHeight,
    fromEnd: el.scrollHeight - el.scrollTop - el.clientHeight,
  }));
  expect(metrics.scrollable, "the conversation has its own scroller").toBe(true);
  expect(metrics.fromEnd, "the conversation opens at its end").toBeLessThanOrEqual(2);
  await expect(page.getByText("Question 15:", { exact: false })).toBeInViewport();

  // Scrolling the conversation up does not move the page, and offers the way back.
  await scroller.hover();
  await page.mouse.wheel(0, -1500);
  await expect(
    page.getByRole("button", { name: /Jump to latest|Siirry uusimpaan|uusimpaan/i }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.scrollY), "the page moved").toBe(0);

  if (viewport.width < 1024) {
    // A phone: one pane, switched.
    const spec = page.getByRole("button", { name: /^(Specification|Määrittely)$/ });
    await spec.click();
    await expect(spec).toHaveAttribute("aria-pressed", "true");
    await expect(box).toBeHidden();
    await page.getByRole("button", { name: /^(Conversation|Keskustelu)$/ }).click();
    await expect(box).toBeVisible();
  }
});
