import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { encode } from "next-auth/jwt";
import { en } from "../src/i18n/en";
import { fi } from "../src/i18n/fi";
import { PAGES } from "./pages";

/** What the error boundaries say. A page showing one has been drawn from a fixture the app no longer parses. */
const ERROR_SCREENS = [
  en.app.errorTitle,
  fi.app.errorTitle,
  en.participant.session.errorServerTitle,
  fi.participant.session.errorServerTitle,
];

const AUTH_SECRET = "e2e-auth-secret-e2e-auth-secret-0123456789";
const RESULTS = path.join(import.meta.dirname, "results");
export const FINDINGS_FILE = path.join(RESULTS, "findings.jsonl");

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** The role and the scenario ride in the token, so every context has its own (D-370). */
async function staffCookie(role?: string, scenario?: string): Promise<string> {
  return encode({
    token: {
      email: "ada@acme.test",
      sub: "u1",
      ...(role ? { role } : {}),
      ...(scenario ? { scenario } : {}),
    },
    secret: AUTH_SECRET,
    salt: "authjs.session-token",
  });
}

for (const entry of PAGES) {
  test(`${entry.id}: no serious or critical axe violations`, async ({ page, context }, info) => {
    const origin = new URL(info.project.use.baseURL ?? "http://localhost:3100");
    if (entry.auth === "staff") {
      await context.addCookies([
        {
          name: "authjs.session-token",
          value: await staffCookie(entry.role, entry.scenario),
          domain: origin.hostname,
          path: "/",
        },
      ]);
      if (entry.role && entry.role !== "admin") {
        await context.setExtraHTTPHeaders({ "x-e2e-role": entry.role });
      }
    }
    if (entry.auth === "participant") {
      await context.addCookies([
        {
          name: "aidp_participant",
          value: entry.token ?? "e2e-participant-token",
          domain: origin.hostname,
          path: "/",
        },
      ]);
    }
    // Every Content-Security-Policy violation the page raises, from the first script onward. The
    // policy is enforced in this run (CSP_MODE=enforce in playwright.config.ts), so an entry here
    // is something production would block (D-264).
    await page.addInitScript(() => {
      const w = window as Window & { __cspViolations?: string[] };
      const found: string[] = [];
      w.__cspViolations = found;
      document.addEventListener("securitypolicyviolation", (e) => {
        found.push(
          `${e.effectiveDirective} blocked ${e.blockedURI || "inline"} at ${e.sourceFile || "page"}:${String(e.lineNumber)}`,
        );
      });
    });
    await entry.before?.(page);
    // The role header reaches the fake API through the web server only when it is forwarded; the
    // operator pages are served by the same fake, which answers every role the same way.
    const response = await page.goto(entry.path, { waitUntil: "networkidle" });
    expect(response, `${entry.path} answered`).not.toBeNull();
    await entry.prepare?.(page);
    await page.waitForLoadState("networkidle");
    // Dialogs and popovers fade in; axe would read the colours halfway through the fade.
    if (entry.prepare) await page.waitForTimeout(600);

    // A page that rendered its error state would pass axe (error screens are accessible). The
    // fixtures drifting from the API's shapes did exactly that for two pages, unnoticed.
    const shown = await page.locator("body").innerText();
    expect(
      entry.isErrorPage ? [] : ERROR_SCREENS.filter((text) => shown.includes(text)),
      `${entry.path} rendered an error screen, so its fixture no longer matches what the page parses`,
    ).toEqual([]);

    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    mkdirSync(RESULTS, { recursive: true });
    for (const v of results.violations) {
      appendFileSync(
        FINDINGS_FILE,
        `${JSON.stringify({
          project: info.project.name,
          page: entry.id,
          rule: v.id,
          impact: v.impact,
          help: v.help,
          nodes: v.nodes.length,
          target: v.nodes[0]?.target.join(" "),
        })}\n`,
      );
    }
    const violations = await page.evaluate(
      () => (window as Window & { __cspViolations?: string[] }).__cspViolations ?? [],
    );
    expect(violations, `${entry.path} raised Content-Security-Policy violations`).toEqual([]);
    const blocking = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(
      blocking.map((v) => `${v.id} (${v.impact ?? "?"}): ${v.help} - ${v.nodes[0]?.target.join(" ") ?? ""}`),
    ).toEqual([]);
  });
}
