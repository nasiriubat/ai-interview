/*
 * Screenshots of the participant screens and the requirements workspace in every state a design
 * review looks at (D-380). Not part of the test run: it writes images for a person to look at.
 *
 *   BASE=http://localhost:3470 OUT=/tmp/shots pnpm exec tsx scripts/review-shots.ts
 *
 * Optional: ONLY=regex on the state name, WIDTHS=360,390,768,1280,1920, THEMES=light,dark,
 * LOCALES=en,fi. The target must be a server pointed at the fake API (`e2e/fake-api.ts`), which
 * picks the interview variant from a word in the participant token.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { encode } from "next-auth/jwt";

const BASE = process.env.BASE ?? "http://localhost:3470";
const OUT = process.env.OUT ?? "/tmp/shots";
const SECRET = process.env.AUTH_SECRET ?? "e2e-auth-secret-e2e-auth-secret-0123456789";
const WIDTHS = (process.env.WIDTHS ?? "360,768,1280").split(",").map(Number);
const THEMES = (process.env.THEMES ?? "light,dark").split(",");
const LOCALES = (process.env.LOCALES ?? "en").split(",");
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;

interface State {
  name: string;
  path: string;
  auth?: "staff" | "participant";
  token?: string;
  before?: (page: Page, ctx: BrowserContext) => Promise<void>;
  prepare?: (page: Page) => Promise<void>;
  full?: boolean;
}

const LINK = "e2e-link-token-open";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const clickName = async (page: Page, name: RegExp): Promise<void> => {
  await page.getByRole("button", { name }).first().click();
};

const STATES: State[] = [
  { name: "arrival", path: `/p/${LINK}` },
  {
    name: "arrival-details",
    path: `/p/${LINK}`,
    prepare: async (p) => {
      await clickName(p, /./);
      await sleep(300);
    },
  },
  { name: "invited", path: "/p/r/invite-token" },
  { name: "link-closed", path: "/p/closed-link" },
  { name: "link-expired", path: "/p/expired-link" },
  { name: "link-missing", path: "/p/missing-link" },
  { name: "no-session", path: "/p/session" },
  { name: "chat", path: "/p/session", auth: "participant" },
  { name: "chat-long", path: "/p/session", auth: "participant", token: "long", full: true },
  {
    name: "chat-menu",
    path: "/p/session",
    auth: "participant",
    prepare: async (p) => {
      await clickName(p, /interview options|haastattelun valinnat|valinnat/i);
      await sleep(250);
    },
  },
  {
    name: "chat-typing",
    path: "/p/session",
    auth: "participant",
    before: async (p) => {
      await p.route("**/api/participant/**", async (route) => {
        if (route.request().method() === "POST") await sleep(60_000);
        else await route.continue();
      });
    },
    prepare: async (p) => {
      const box = p.getByRole("textbox").first();
      await box.fill("Mostly handover and charting, to be honest.");
      await p.keyboard.press("Enter");
      await sleep(500);
    },
  },
  {
    name: "chat-error",
    path: "/p/session",
    auth: "participant",
    before: async (p) => {
      await p.route("**/api/participant/**", async (route) => {
        if (route.request().method() === "POST") {
          await route.fulfill({
            status: 502,
            contentType: "application/json",
            body: JSON.stringify({ error: { code: "provider_error", message: "x" } }),
          });
        } else await route.continue();
      });
    },
    prepare: async (p) => {
      await p.getByRole("textbox").first().fill("Mostly handover.");
      await p.keyboard.press("Enter");
      await sleep(1200);
    },
  },
  { name: "paused", path: "/p/session", auth: "participant", token: "paused" },
  {
    name: "ended-summary",
    path: "/p/session",
    auth: "participant",
    token: "ended",
    full: true,
    prepare: async () => sleep(800),
  },
  {
    name: "ended-generating",
    path: "/p/session",
    auth: "participant",
    token: "ended",
    full: true,
    before: async (p) => {
      await p.route("**/api/participant/session/summary", (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ summary: "", facts: [], status: "pending" }),
        }),
      );
    },
    prepare: async () => sleep(800),
  },
  {
    name: "ended-unavailable",
    path: "/p/session",
    auth: "participant",
    token: "ended",
    full: true,
    before: async (p) => {
      await p.route("**/api/participant/session/summary", (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ summary: "", facts: [], status: "unavailable" }),
        }),
      );
    },
    prepare: async () => sleep(800),
  },
  {
    name: "voice",
    path: "/p/session",
    auth: "participant",
    before: async (_p, c) => {
      await c.grantPermissions(["microphone"]);
    },
    prepare: async (p) => {
      await p.locator("[data-mode-switch] > *").last().click();
      await sleep(400);
    },
  },
  {
    name: "voice-denied",
    path: "/p/session",
    auth: "participant",
    before: async (p) => {
      await p.addInitScript(() => {
        if (navigator.mediaDevices)
          navigator.mediaDevices.getUserMedia = () =>
            Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
      });
    },
    prepare: async (p) => {
      await p.locator("[data-mode-switch] > *").last().click();
      await clickName(p, /record your answer|nauhoita vastauksesi/i);
      await sleep(600);
    },
  },
  {
    name: "voice-live",
    path: "/p/session",
    auth: "participant",
    token: "live",
    before: async (p, c) => {
      await c.grantPermissions(["microphone"]);
      await p.routeWebSocket(/\/api\/v1\/p\/session\/live/, (ws) => {
        ws.send(
          JSON.stringify({
            type: "ready",
            captions: true,
            bargeIn: false,
            mode: "utterance",
            sampleRate: 24000,
          }),
        );
        ws.onMessage(() => undefined);
      });
    },
    prepare: async (p) => {
      await p.locator("[data-mode-switch] > *").last().click();
      await sleep(1500);
    },
  },
  // Requirements workspace
  { name: "req-list", path: "/admin/requirements", auth: "staff", full: true },
  { name: "req-new", path: "/admin/requirements/new", auth: "staff" },
  { name: "req-session", path: "/admin/requirements/req1", auth: "staff", full: true },
  { name: "req-version", path: "/admin/requirements/req1/versions/2", auth: "staff", full: true },
  {
    name: "req-diagrams",
    path: "/admin/requirements/reqd/versions/2",
    auth: "staff",
    full: true,
    prepare: async (p) => {
      await p.locator(".report-diagram svg").first().waitFor({ timeout: 30_000 });
      await sleep(500);
    },
  },
  {
    name: "req-diagram-fullscreen",
    path: "/admin/requirements/reqd/versions/2",
    auth: "staff",
    prepare: async (p) => {
      await p.locator(".report-diagram svg").first().waitFor({ timeout: 30_000 });
      await p
        .getByRole("button", { name: /open full screen|avaa koko/i })
        .first()
        .click();
      await sleep(600);
    },
  },
  {
    name: "req-diagram-source",
    path: "/admin/requirements/reqd/versions/2",
    auth: "staff",
    prepare: async (p) => {
      await p.locator(".report-diagram svg").first().waitFor({ timeout: 30_000 });
      await p
        .getByRole("button", { name: /show source|näytä lähdekoodi/i })
        .first()
        .click();
      await p
        .getByRole("button", { name: /show source|näytä lähdekoodi/i })
        .first()
        .scrollIntoViewIfNeeded();
      await sleep(300);
    },
  },
];

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
const staff = await encode({
  token: { email: "ada@acme.test", sub: "u1" },
  secret: SECRET,
  salt: "authjs.session-token",
});
const host = new URL(BASE).hostname;

for (const locale of LOCALES) {
  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      for (const s of STATES) {
        if (ONLY && !ONLY.test(s.name)) continue;
        const context = await browser.newContext({
          viewport: { width, height: width < 600 ? 780 : 900 },
          locale: locale === "fi" ? "fi-FI" : "en-GB",
          colorScheme: theme === "dark" ? "dark" : "light",
        });
        const cookies = [{ name: "lang", value: locale, domain: host, path: "/" }];
        if (s.auth === "staff")
          cookies.push({ name: "authjs.session-token", value: staff, domain: host, path: "/" });
        if (s.auth === "participant")
          cookies.push({
            name: "aidp_participant",
            value: s.token ? `e2e-${s.token}-token` : "e2e-participant-token",
            domain: host,
            path: "/",
          });
        await context.addCookies(cookies);
        const page = await context.newPage();
        try {
          await s.before?.(page, context);
          await page.goto(`${BASE}${s.path}`, { waitUntil: "networkidle" });
          await s.prepare?.(page);
          const name = `${s.name}-${locale}-${theme}-${String(width)}.png`;
          await page.screenshot({ path: path.join(OUT, name), fullPage: s.full === true });
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          );
          if (overflow) console.warn(`HORIZONTAL SCROLL: ${s.name} ${locale} ${theme} ${String(width)}`);
        } catch (e) {
          console.warn(`FAILED ${s.name} ${String(width)}: ${String(e).split("\n")[0] ?? ""}`);
        }
        await context.close();
      }
    }
  }
}
await browser.close();
console.warn(`wrote screenshots to ${OUT}`);
