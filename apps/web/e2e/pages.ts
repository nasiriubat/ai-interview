import type { Page } from "@playwright/test";
import { LINK_TOKEN } from "./fixtures";

/**
 * Every page the app can show, and the states of the interview and the forms that a plain load
 * does not reach (ux-design 5.1). A page belongs here in the same change that adds the page: the
 * inventory test also fails when a route under `src/app` has no entry (`e2e/inventory.spec.ts`).
 *
 * `auth`:
 *  - `none`        no credential at all;
 *  - `staff`       an Auth.js session cookie, answered by the fake API as `role`;
 *  - `participant` the participant cookie.
 */
export interface Entry {
  id: string;
  path: string;
  auth: "none" | "staff" | "participant";
  role?: "admin" | "member" | "platform_operator";
  /** Gets the page into the state worth checking (a dialog open, a step reached). */
  prepare?: (page: Page) => Promise<void>;
  /** The `app/**` route this entry covers, for the inventory test. */
  route: string;
  /** The page is itself an error page, so showing the error wording is correct. */
  isErrorPage?: boolean;
}

const publicPage = (id: string, path: string, route: string, prepare?: Entry["prepare"]): Entry => ({
  id,
  path,
  route,
  auth: "none",
  ...(prepare ? { prepare } : {}),
});
const admin = (id: string, path: string, route: string, prepare?: Entry["prepare"]): Entry => ({
  id,
  path,
  route,
  auth: "staff",
  role: "admin",
  ...(prepare ? { prepare } : {}),
});
const operator = (id: string, path: string, route: string): Entry => ({
  id,
  path,
  route,
  auth: "staff",
  role: "platform_operator",
});

const click = async (page: Page, name: RegExp | string): Promise<void> => {
  await page.getByRole("button", { name }).first().click();
};

export const PAGES: Entry[] = [
  // Without any session
  publicPage("root", "/", "app/page.tsx"),
  // The landing page with every answer of its FAQ open, so axe reads the text it hides by default.
  publicPage("root-faq-open", "/", "app/page.tsx", async (page) => {
    const summaries = page.locator("details > summary");
    for (let i = 0; i < (await summaries.count()); i++) await summaries.nth(i).click();
  }),
  publicPage("signin", "/auth/signin", "app/auth/signin/page.tsx"),
  publicPage("verify-request", "/auth/verify", "app/auth/verify/page.tsx"),
  {
    ...publicPage("auth-error", "/auth/error?error=Configuration", "app/auth/error/page.tsx"),
    isErrorPage: true,
  },
  publicPage("not-found", "/no-such-page", "app/not-found.tsx"),
  publicPage("participant-not-found", "/p/missing-link", "app/p/not-found.tsx"),
  publicPage("link-closed", "/p/closed-link", "app/p/[linkToken]/page.tsx"),
  publicPage("link-expired", "/p/expired-link", "app/p/[linkToken]/page.tsx"),
  publicPage("session-without-cookie", "/p/session", "app/p/session/page.tsx"),

  // Participant, against the fake API
  publicPage("arrival", `/p/${LINK_TOKEN}`, "app/p/[linkToken]/page.tsx"),
  publicPage("arrival-details", `/p/${LINK_TOKEN}`, "app/p/[linkToken]/page.tsx", async (page) => {
    await click(page, /./);
    await page.getByRole("heading", { level: 1 }).waitFor();
  }),
  publicPage("invited-arrival", "/p/r/invite-token", "app/p/r/[token]/page.tsx"),
  {
    id: "interview",
    path: "/p/session",
    route: "app/p/session/page.tsx",
    auth: "participant",
  },
  {
    id: "interview-menu",
    path: "/p/session",
    route: "app/p/session/page.tsx",
    auth: "participant",
    prepare: async (page: Page): Promise<void> => {
      await page
        .getByRole("button", { name: /interview options|haastattelun valinnat|valinnat/i })
        .first()
        .click();
    },
  },

  // Admin
  // The same page for a signed-in visitor: "Go to the overview" instead of "Sign in", no redirect.
  admin("root-signed-in", "/", "app/page.tsx"),
  admin("dashboard", "/admin", "app/admin/page.tsx"),
  admin("campaigns", "/admin/campaigns", "app/admin/campaigns/page.tsx"),
  admin("campaign-new", "/admin/campaigns/new", "app/admin/campaigns/new/page.tsx"),
  admin("campaign-overview", "/admin/campaigns/camp1", "app/admin/campaigns/[id]/page.tsx"),
  admin(
    "campaign-invitations",
    "/admin/campaigns/camp1?tab=invitations",
    "app/admin/campaigns/[id]/page.tsx",
  ),
  admin("campaign-sessions", "/admin/campaigns/camp1?tab=sessions", "app/admin/campaigns/[id]/page.tsx"),
  admin("campaign-analysis", "/admin/campaigns/camp1?tab=analysis", "app/admin/campaigns/[id]/page.tsx"),
  admin("campaign-settings", "/admin/campaigns/camp1?tab=settings", "app/admin/campaigns/[id]/page.tsx"),
  admin("campaign-edit", "/admin/campaigns/camp1/edit", "app/admin/campaigns/[id]/edit/page.tsx"),
  admin("campaign-results", "/admin/campaigns/camp1/results", "app/admin/campaigns/[id]/results/page.tsx"),
  admin("campaign-report", "/admin/campaigns/camp1/report", "app/admin/campaigns/[id]/report/page.tsx"),
  admin("sessions-detail", "/admin/sessions/sess0001abcdef", "app/admin/sessions/[id]/page.tsx"),
  admin("templates", "/admin/templates", "app/admin/templates/page.tsx"),
  admin("template", "/admin/templates/tpl1", "app/admin/templates/[id]/page.tsx"),
  admin("template-edit", "/admin/templates/tpl1/edit", "app/admin/templates/[id]/edit/page.tsx"),
  admin("template-new", "/admin/templates/new", "app/admin/templates/new/page.tsx"),
  admin("requirements", "/admin/requirements", "app/admin/requirements/page.tsx"),
  admin("requirements-new", "/admin/requirements/new", "app/admin/requirements/new/page.tsx"),
  admin("requirements-session", "/admin/requirements/req1", "app/admin/requirements/[id]/page.tsx"),
  admin(
    "requirements-version",
    "/admin/requirements/req1/versions/2",
    "app/admin/requirements/[id]/versions/[v]/page.tsx",
  ),
  admin("settings", "/admin/settings", "app/admin/settings/page.tsx"),
  admin("settings-privacy", "/admin/settings?scope=tenant&category=privacy", "app/admin/settings/page.tsx"),
  admin("providers", "/admin/providers", "app/admin/providers/page.tsx"),
  admin("provider", "/admin/providers/p1", "app/admin/providers/[id]/page.tsx"),
  admin("routes", "/admin/routes", "app/admin/routes/page.tsx"),
  admin("budgets", "/admin/budgets", "app/admin/budgets/page.tsx"),
  admin("users", "/admin/users", "app/admin/users/page.tsx"),
  admin("audit", "/admin/audit", "app/admin/audit/page.tsx"),
  admin("prompts", "/admin/prompts", "app/admin/prompts/page.tsx"),
  admin("prompt", "/admin/prompts/interviewer", "app/admin/prompts/[key]/page.tsx"),
  admin(
    "prompt-use-dialog",
    "/admin/prompts/interviewer",
    "app/admin/prompts/[key]/page.tsx",
    async (page) => {
      await page.getByRole("button", { name: /^(Use version|Ota käyttöön versio) 3/ }).click();
      await page.getByRole("dialog").waitFor();
    },
  ),
  operator("operator-tenants", "/admin/operator", "app/admin/operator/page.tsx"),
  operator("operator-providers", "/admin/operator/providers", "app/admin/operator/providers/page.tsx"),
  operator("operator-provider", "/admin/operator/providers/p1", "app/admin/operator/providers/[id]/page.tsx"),
  operator("operator-routes", "/admin/operator/routes", "app/admin/operator/routes/page.tsx"),
  operator("operator-stats", "/admin/operator/stats", "app/admin/operator/stats/page.tsx"),
  operator("operator-jobs", "/admin/operator/jobs", "app/admin/operator/jobs/page.tsx"),
  operator("operator-health", "/admin/operator/health", "app/admin/operator/health/page.tsx"),
];

/** Routes that serve no document (JSON or redirects), so there is nothing for axe to read. */
export const NOT_DOCUMENTS = new Set([
  "app/api/auth/[...nextauth]/route.ts",
  "app/api/csp-report/route.ts",
  "app/api/health/route.ts",
  "app/api/participant/[...path]/route.ts",
  "app/api/preview/[templateId]/route.ts",
  "app/api/staff/[...path]/route.ts",
  "app/robots.txt/route.ts",
  "app/sitemap.xml/route.ts",
  "app/error.tsx",
  "app/p/error.tsx",
  "app/admin/error.tsx",
  "app/layout.tsx",
  "app/admin/layout.tsx",
  "app/admin/operator/layout.tsx",
]);

/**
 * Routes that exist but are not covered by an entry above yet, each with the reason. An entry
 * here is a debt: the inventory test lists them so they stay visible.
 */
export const NOT_YET: Record<string, string> = {};
