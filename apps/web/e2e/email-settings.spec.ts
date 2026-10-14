import { expect, test, type Page } from "@playwright/test";
import { encode } from "next-auth/jwt";
import { en } from "../src/i18n/en";
import { fi } from "../src/i18n/fi";

/*
 * The structured SMTP form (D-410 to D-413): every part of a relay has its own labelled field, the
 * password is write-only, the form holds its layout from a phone to a wide screen, and the test
 * send says what went wrong in words. The page is served from the fake API, so nothing is sent.
 */

const AUTH_SECRET = "e2e-auth-secret-e2e-auth-secret-0123456789";
const URL_PATH = "/admin/settings?scope=tenant&category=email";

async function signIn(page: Page, hostname: string): Promise<void> {
  const value = await encode({
    token: { email: "ada@acme.test", sub: "u1" },
    secret: AUTH_SECRET,
    salt: "authjs.session-token",
  });
  await page.context().addCookies([{ name: "authjs.session-token", value, domain: hostname, path: "/" }]);
}

function strings(project: string): typeof en.admin.settings.email.form {
  return project.startsWith("fi") ? fi.admin.settings.email.form : en.admin.settings.email.form;
}

test("the mail relay is a form with a field for each part", async ({ page }, info) => {
  const k = strings(info.project.name);
  // The policy is enforced in this build: the form, its select and its test button must not trip it.
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  await signIn(page, new URL(info.project.use.baseURL ?? "http://localhost:3100").hostname);
  await page.goto(URL_PATH, { waitUntil: "networkidle" });
  const violations = (): Promise<string[]> =>
    page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
  const atLoad = await violations();
  await page.locator("#smtp-security").click();
  await page.keyboard.press("Escape");
  // Opening the select adds nothing beyond what the page already did on load.
  expect(await violations(), `load: ${atLoad.join(", ")}`).toEqual(atLoad);

  const host = page.getByLabel(k.host, { exact: false }).first();
  await expect(host).toHaveValue("smtp.postmarkapp.com");
  await expect(page.locator("#smtp-port")).toHaveValue("587");
  await expect(page.locator("#smtp-username")).toHaveValue("ada@acme.test");
  await expect(page.locator("#email-from")).toHaveValue("hello@acme.test");
  await expect(page.locator("#email-replyto")).toHaveValue("");

  // Write-only: masked, empty, and never carrying the stored secret or the sentinel.
  const password = page.locator("#smtp-password");
  await expect(password).toHaveAttribute("type", "password");
  await expect(password).toHaveValue("");

  // The old single connection-string row is gone.
  await expect(page.locator("#setting-email-smtpUrl")).toHaveCount(0);

  // Where the relay comes from is said, in a badge and a sentence.
  await expect(page.getByTestId("email-source")).toHaveAttribute("data-source", "tenant");
  await expect(page.getByTestId("email-source-badge")).toHaveText(k.sourceBadge.tenant);
});

test("choosing a security mode moves the port to its usual value", async ({ page }, info) => {
  const k = strings(info.project.name);
  await signIn(page, new URL(info.project.use.baseURL ?? "http://localhost:3100").hostname);
  await page.goto(URL_PATH, { waitUntil: "networkidle" });
  await page.locator("#smtp-security").click();
  // A tenant is not offered plain text: the egress policy would refuse it.
  await expect(page.getByRole("option", { name: k.securityOptions.none })).toHaveCount(0);
  await page.getByRole("option", { name: k.securityOptions.ssl }).click();
  await expect(page.locator("#smtp-port")).toHaveValue("465");
});

test("a bad host or port is named at the field and nothing is sent", async ({ page }, info) => {
  const k = strings(info.project.name);
  let puts = 0;
  await page.route("**/api/staff/settings**", async (route) => {
    if (route.request().method() === "PUT") puts++;
    await route.continue();
  });
  await signIn(page, new URL(info.project.use.baseURL ?? "http://localhost:3100").hostname);
  await page.goto(URL_PATH, { waitUntil: "networkidle" });
  await page.locator("#smtp-host").fill("https://smtp.example.com/x");
  await page.locator("#smtp-port").fill("0");
  const saveLabel = info.project.name.startsWith("fi") ? fi.admin.settings.save : en.admin.settings.save;
  await page.getByRole("button", { name: saveLabel }).click();
  await expect(page.locator("#smtp-host-error")).toHaveText(k.errors.hostFormat);
  await expect(page.locator("#smtp-port-error")).toHaveText(k.errors.port);
  expect(puts).toBe(0);
});

test("the test send carries the unsaved form and words the failure", async ({ page }, info) => {
  const k = strings(info.project.name);
  let body: Record<string, unknown> | null = null;
  await page.route("**/api/staff/settings/email/test", async (route) => {
    body = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, usedScope: "tenant", errorClass: "auth_failed", error: "raw words" }),
    });
  });
  await signIn(page, new URL(info.project.use.baseURL ?? "http://localhost:3100").hostname);
  await page.goto(URL_PATH, { waitUntil: "networkidle" });
  await page.locator("#smtp-host").fill("mail.other.example");
  await page.locator("#smtp-password").fill("typed-secret");
  await page
    .getByRole("button", { name: en.admin.settings.email.test })
    .or(page.getByRole("button", { name: fi.admin.settings.email.test }))
    .click();
  await expect(page.getByTestId("email-test-error")).toContainText(k.testClass.auth_failed);
  const sent = body as unknown as { smtp: { host: string; password: string; port: number } };
  expect(sent.smtp).toMatchObject({ host: "mail.other.example", password: "typed-secret", port: 587 });
});

test("the form keeps its layout: no sideways scroll, host and port share a row, controls fit", async ({
  page,
}, info) => {
  await signIn(page, new URL(info.project.use.baseURL ?? "http://localhost:3100").hostname);
  await page.goto(URL_PATH, { waitUntil: "networkidle" });
  const width = page.viewportSize()?.width ?? 0;
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  expect(overflow).toBe(false);

  const host = await page.locator("#smtp-host").boundingBox();
  const port = await page.locator("#smtp-port").boundingBox();
  if (!host || !port) throw new Error("fields not rendered");
  expect(Math.abs(host.y - port.y)).toBeLessThan(2);
  expect(port.x).toBeGreaterThan(host.x + host.width - 1);

  const panel = await page.getByTestId("email-panel").boundingBox();
  if (!panel) throw new Error("panel not rendered");
  expect(panel.x).toBeGreaterThanOrEqual(0);
  expect(panel.x + panel.width).toBeLessThanOrEqual(width + 0.5);

  // Every control is at least 36 px tall (44 on coarse pointers is the kit's own rule).
  for (const id of [
    "#smtp-host",
    "#smtp-port",
    "#smtp-username",
    "#smtp-password",
    "#email-from",
    "#email-replyto",
  ]) {
    const box = await page.locator(id).boundingBox();
    expect(box?.height ?? 0, id).toBeGreaterThanOrEqual(36);
    expect((box?.x ?? 0) + (box?.width ?? 0), id).toBeLessThanOrEqual(width);
  }
});
