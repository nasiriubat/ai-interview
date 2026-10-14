import { defineConfig, devices } from "@playwright/test";

/*
 * The accessibility pass (ux-design section 5): every page, in English and Finnish, on a phone and
 * on a desktop, with reduced motion and in the dark theme, checked by axe. It needs a browser
 * (`pnpm --filter @aidp/web exec playwright install chromium`) and a production build, so it is not
 * part of `pnpm check`, which prints a notice that says so. Run it with
 * `pnpm --filter @aidp/web e2e`.
 *
 * Nothing here needs the full stack: the web server is pointed at the fake API in `e2e/fake-api.ts`.
 */
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3100);
const API_PORT = Number(process.env.E2E_API_PORT ?? 3199);
export const E2E_AUTH_SECRET = "e2e-auth-secret-e2e-auth-secret-0123456789";

const mobile = { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } };
const desktop = { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } };

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  timeout: 60_000,
  workers: 4,
  reporter: [["list"]],
  globalTeardown: "./e2e/summary.ts",
  use: {
    baseURL: `http://localhost:${String(WEB_PORT)}`,
    trace: "off",
    // A fake microphone for the voice screens (D-326): the prompt is accepted and the device plays
    // a test tone, so a recording or a call can be set up without hardware or a person.
    launchOptions: {
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
    },
  },
  projects: [
    { name: "en-mobile", use: { ...mobile, locale: "en-GB" } },
    { name: "en-desktop", use: { ...desktop, locale: "en-GB" } },
    { name: "fi-mobile", use: { ...mobile, locale: "fi-FI" } },
    { name: "fi-desktop", use: { ...desktop, locale: "fi-FI" } },
    {
      name: "reduced-motion",
      use: { ...desktop, locale: "en-GB", contextOptions: { reducedMotion: "reduce" } },
    },
    { name: "dark", use: { ...desktop, locale: "en-GB", colorScheme: "dark" } },
  ],
  webServer: [
    {
      command: "pnpm exec tsx e2e/fake-api.ts",
      url: `http://127.0.0.1:${String(API_PORT)}/api/v1/__health`,
      env: { E2E_API_PORT: String(API_PORT) },
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: `pnpm exec next build && pnpm exec next start -p ${String(WEB_PORT)}`,
      url: `http://localhost:${String(WEB_PORT)}/api/health`,
      env: {
        API_URL: `http://127.0.0.1:${String(API_PORT)}`,
        AUTH_SECRET: E2E_AUTH_SECRET,
        AUTH_TRUST_HOST: "true",
        // Required at start-up; nothing is sent, the fake API never asks for a mail.
        EMAIL_SERVER: "smtp://localhost:1025",
        EMAIL_FROM: "e2e@localhost",
        NEXTAUTH_URL: `http://localhost:${String(WEB_PORT)}`,
        // The pass runs the policy the way production does: blocking. A page that would be broken
        // by it fails here, and the axe spec fails on any violation event (D-264).
        CSP_MODE: "enforce",
      },
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
    },
  ],
});
