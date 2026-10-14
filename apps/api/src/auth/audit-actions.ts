/**
 * Which audit action every administrative mutation writes (A2, D-163, FR-51).
 *
 * Every POST, PUT, PATCH and DELETE reachable by staff (member, admin, operator) is listed here
 * with the action or actions it records, or with the reason it records none. `installAccessGuard`
 * refuses to boot a route that is not listed, the same way it refuses one with no access
 * declaration, and `apps/api/test/audit-rows.e2e.test.ts` proves from the other side that each
 * route really writes a row whose action is one of these. So a new mutation cannot ship without
 * its author deciding what the audit log says about it.
 *
 * Kept in one file rather than on each route so that the whole answer to "what is audited?" can
 * be read, reviewed and diffed in one place. A trailing `*` stands for a family whose suffix is
 * the request's own value (`campaign.*` for a status change).
 */
export type AuditDeclaration = readonly string[] | { readonly none: string };

export const AUDIT_DECLARATIONS: Readonly<Record<string, AuditDeclaration>> = {
  // users
  "POST /users": ["user.create", "user.create_refused"],
  "PATCH /users/:id": ["user.update", "user.disable", "user.enable"],
  "DELETE /users/:id": ["user.delete"],
  // templates
  "POST /templates": ["template.create"],
  "PUT /templates/:id": ["template.update"],
  "POST /templates/:id/publish": ["template.published"],
  "POST /templates/:id/archive": ["template.archived"],
  "POST /templates/:id/restore": ["template.restore"],
  "POST /templates/:id/preview": ["template.preview"],
  // settings
  "PUT /settings": ["settings.update"],
  "POST /settings/email/test": ["settings.email_test"],
  // campaigns
  "POST /campaigns": ["campaign.create"],
  "PATCH /campaigns/:id": ["campaign.update"],
  "POST /campaigns/:id/open": ["campaign.open"],
  "POST /campaigns/:id/close": ["campaign.closed"],
  "POST /campaigns/:id/invitations": ["campaign.invite"],
  "POST /campaigns/:id/invitations/:invId/remind": ["invitation.remind"],
  "POST /campaigns/:id/invitations/:invId/revoke": ["invitation.revoke"],
  // interviews
  "POST /sessions/:id/flag/ack": ["session.flag.ack"],
  // onboarding
  "POST /onboarding/dismiss": ["onboarding.dismiss"],
  // providers, prices, routes, budgets
  "POST /providers": ["provider.create"],
  "PATCH /providers/:id": ["provider.update"],
  "DELETE /providers/:id": ["provider.delete"],
  "POST /providers/:id/test": ["provider.test"],
  "PUT /providers/:id/prices": ["prices.update"],
  "PUT /routes": ["routes.update"],
  "POST /budgets": ["budget.set"],
  "DELETE /budgets/:id": ["budget.delete"],
  // voice
  "POST /admin/voice/openai": ["voice.openai_connect"],
  "PUT /admin/voice/live": ["voice.live_toggle"],
  // analysis
  "POST /campaigns/:id/analyses": ["analysis.start"],
  "PATCH /opportunities/:id": ["opportunity.override"],
  "POST /opportunities/:id/status": ["opportunity.*"],
  "POST /opportunities/:id/promote": ["opportunity.promote"],
  // requirements workspace (staff, members included)
  "POST /requirements": ["requirements.create"],
  "POST /requirements/:id/path": ["requirements.path"],
  "POST /requirements/:id/complete": ["requirements.complete"],
  "POST /requirements/:id/reopen": ["requirements.reopen"],
  "PUT /requirements/:id/sections/:key": ["requirements.section_edit"],
  "POST /requirements/:id/findings/:findingId": ["requirements.finding"],
  "POST /requirements/:id/versions": ["requirements.version"],
  "POST /requirements/:id/versions/:v/github": ["requirements.github_push"],
  "POST /requirements/:id/invitations": ["requirements.invite"],
  "POST /requirements/:id/invitations/:invId/revoke": ["requirements.revoke"],
  "POST /requirements/:id/turns": {
    none: "A conversation turn is the interview itself, stored as messages; it is not an administrative action.",
  },
  // operator
  "POST /operator/tenants": ["tenant.create"],
  "PATCH /operator/tenants/:id": ["tenant.update"],
  "POST /operator/providers": ["provider.create"],
  "PATCH /operator/providers/:id": ["provider.update"],
  "DELETE /operator/providers/:id": ["provider.delete"],
  "POST /operator/providers/:id/test": ["provider.test"],
  "PUT /operator/providers/:id/prices": ["prices.update"],
  "PUT /operator/routes": ["routes.update"],
  "POST /operator/jobs/dead/:queue/:id/retry": ["job.retry"],
  "POST /operator/jobs/dead/:queue/:id/discard": ["job.discard"],
  "POST /operator/jobs/run/:name": ["job.run_now"],
  "POST /operator/crypto/rekey": ["crypto.rekey_requested"],
};

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Whether a route needs an entry: a staff-reachable mutation. */
export function needsAuditDeclaration(method: string, access: string): boolean {
  return MUTATING.has(method) && (access === "staff" || access === "admin" || access === "operator");
}

/** `/api/v1/users/:id` and `/users/:id` are the same route here. */
export function declarationKey(method: string, url: string): string {
  return `${method} ${url.replace(/^\/api\/v1/, "")}`;
}

/** The actions a route declares, or null when it declares none (or a reason for none). */
export function declaredActions(method: string, url: string): readonly string[] | null {
  const d = AUDIT_DECLARATIONS[declarationKey(method, url)];
  return d && Array.isArray(d) ? (d as readonly string[]) : null;
}

/** Whether `action` is one the route declared, honouring a trailing `*` family. */
export function actionIsDeclared(declared: readonly string[], action: string): boolean {
  return declared.some((d) => (d.endsWith("*") ? action.startsWith(d.slice(0, -1)) : d === action));
}

/**
 * Refuses to register a staff mutation that has no entry in {@link AUDIT_DECLARATIONS}. Install it
 * after `installAccessGuard` and before any route is registered.
 */
export function installAuditDeclarationCheck(app: {
  addHook(
    name: "onRoute",
    fn: (route: { method: string | string[]; url: string; config?: unknown }) => void,
  ): void;
}): void {
  app.addHook("onRoute", (route) => {
    const access = (route.config as { access?: string } | undefined)?.access ?? "";
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (!needsAuditDeclaration(method, access)) continue;
      if (!(declarationKey(method, route.url) in AUDIT_DECLARATIONS)) {
        throw new Error(
          `Route ${method} ${route.url} is an administrative mutation with no audit declaration. ` +
            "Add it to AUDIT_DECLARATIONS in auth/audit-actions.ts with the action it records, " +
            "or with a reason it records none (FR-51).",
        );
      }
    }
  });
}
