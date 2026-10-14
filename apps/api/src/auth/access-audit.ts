import type { FastifyInstance } from "fastify";
import type { AuditService } from "../modules/audit/service.js";
import { declarationKey } from "./audit-actions.js";

/**
 * Audit rows for reading, as opposed to changing (A2, D-262).
 *
 * The mutation registry in `audit-actions.ts` answers "who changed what". Two kinds of read are
 * just as much a record of who did what to personal data, and neither passes through a mutating
 * route:
 *
 * - **Operator access.** The platform operator is trusted and audited. Acting inside a tenant
 *   (any route other than `/operator/*`, with `X-Company-Id`) writes one `operator.access` row in
 *   that tenant's log, so the tenant's admins can see that, and when, the platform looked.
 * - **Sensitive reads.** A transcript, the identities of a campaign's participants, a report or
 *   a specification export. Each is declared in {@link AUDIT_READS}; a successful response writes
 *   a `session.read`, `session.list_read`, `report.export` or `spec.export` row. The row is
 *   written in `onSend`, before the bytes leave: a record that cannot be written means the data
 *   is not delivered (the request fails), never the other way round.
 *
 * Neither writes a diff: a row says who, what kind, which target and when; it never copies the
 * thing that was read. A burst is counted once: the same actor reading the same target within a
 * minute is one row, so scrolling a transcript does not bury the log.
 */
export interface AuditReadDeclaration {
  action: string;
  targetType: string;
  /** The route parameter that names the target. */
  param: string;
}

export const AUDIT_READS: Readonly<Record<string, AuditReadDeclaration>> = {
  "GET /sessions/:id": { action: "session.read", targetType: "session", param: "id" },
  "GET /sessions/:id/events": { action: "session.read", targetType: "session", param: "id" },
  "GET /campaigns/:id/sessions": { action: "session.list_read", targetType: "campaign", param: "id" },
  "GET /campaigns/:id/sessions.csv": { action: "session.list_read", targetType: "campaign", param: "id" },
  "GET /analyses/:id/report.pdf": { action: "report.export", targetType: "analysis", param: "id" },
  "GET /requirements/:id/versions/:v/export": {
    action: "spec.export",
    targetType: "requirements",
    param: "id",
  },
  "GET /requirements/:id/versions/:v/export.pdf": {
    action: "spec.export",
    targetType: "requirements",
    param: "id",
  },
};

/** The same actor reading the same target within this window is one row. */
export const READ_DEDUPE_MS = 60_000;
/** An operator working in a tenant is one `operator.access` row per this window. */
export const OPERATOR_ACCESS_DEDUPE_MS = 10 * 60_000;

export function installAccessAudit(app: FastifyInstance, audit: AuditService): void {
  // After validation, so a refused or malformed request leaves nothing, and after the guards, so
  // only an operator who was let in is recorded.
  app.addHook("preHandler", async (request) => {
    const p = request.principal;
    if (p.kind !== "staff" || p.role !== "platform_operator") return;
    const override = request.headers["x-company-id"];
    if (typeof override !== "string" || override === "" || override === p.companyId) return;
    // `/operator/*` routes are platform-wide by definition and ignore the header (D-141).
    if (request.routeOptions.config.access === "operator") return;
    await audit.recordOnce(
      override,
      {
        actorId: p.userId,
        action: "operator.access",
        targetType: "tenant",
        targetId: override,
        diff: {
          method: request.method,
          route: declarationKey(request.method, request.routeOptions.url ?? ""),
        },
      },
      OPERATOR_ACCESS_DEDUPE_MS,
      { requireTenant: true },
    );
  });

  app.addHook("onSend", async (request, reply, payload) => {
    if (request.method !== "GET" || reply.statusCode < 200 || reply.statusCode >= 300) return payload;
    const p = request.principal;
    if (p.kind !== "staff") return payload;
    const declared = AUDIT_READS[declarationKey(request.method, request.routeOptions.url ?? "")];
    if (!declared) return payload;
    const params = request.params as Record<string, string | undefined>;
    const targetId = params[declared.param];
    if (!targetId || !request.companyId) return payload;
    await audit.recordOnce(
      request.companyId,
      { actorId: p.userId, action: declared.action, targetType: declared.targetType, targetId },
      READ_DEDUPE_MS,
    );
    return payload;
  });
}
