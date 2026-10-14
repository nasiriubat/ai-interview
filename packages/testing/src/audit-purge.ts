/**
 * Test cleanup for a table nothing may delete from (D-163).
 *
 * `AuditLog` refuses UPDATE, DELETE and TRUNCATE for every role unless the transaction sets the
 * purge flag, which only the tenant-purge job does in production. A test that creates its own
 * tenant and wants it gone sets the same flag, as the table's owner, in the same way.
 */
interface RawClient {
  $transaction<T>(fn: (tx: RawTx) => Promise<T>): Promise<T>;
}
interface RawTx {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

/** Removes every audit row of the named tenants. Owner connection only. */
export async function purgeAuditLog(db: RawClient, companyIds: string[]): Promise<void> {
  if (companyIds.length === 0) return;
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL app.audit_purge = 'on'");
    await tx.$executeRawUnsafe('DELETE FROM "AuditLog" WHERE "companyId" = ANY($1::text[])', companyIds);
  });
}
