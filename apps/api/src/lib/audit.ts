import type { Prisma, PrismaClient } from "@prisma/client";

/** What an audit row records. The company is passed separately, as every service's first argument. */
export interface AuditEntry {
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  diff?: unknown;
}

/**
 * Append-only audit log of admin actions (FR-51). Services reach this through `AuditService`;
 * route files never see a database client, so they cannot call it directly.
 */
export async function audit(db: PrismaClient, companyId: string, entry: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      companyId,
      actorId: entry.actorId,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      ...(entry.diff !== undefined ? { diff: entry.diff as Prisma.InputJsonValue } : {}),
    },
  });
}
