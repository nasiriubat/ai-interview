import type { Prisma, PrismaClient } from "@prisma/client";

/** Append-only audit log of admin actions (FR-51). */
export async function audit(
  db: PrismaClient,
  entry: {
    companyId: string;
    actorId: string | null;
    action: string;
    targetType: string;
    targetId: string;
    diff?: unknown;
  },
): Promise<void> {
  await db.auditLog.create({
    data: {
      companyId: entry.companyId,
      actorId: entry.actorId,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      ...(entry.diff !== undefined ? { diff: entry.diff as Prisma.InputJsonValue } : {}),
    },
  });
}
