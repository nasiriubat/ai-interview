import { tenantTransaction, withSystemTenant, withTenant } from "@aidp/db";
import type { PrismaClient } from "@prisma/client";
import type { AlertPort } from "../../alerts/port.js";
import { companyPrefix, type StoragePort } from "../../storage/port.js";
import type { ErasureLedger } from "./erasure-ledger.js";
import { exportsPrefix } from "./export.js";
import { RETAINED_TABLES, SPECIAL_TABLES, ident, tenantTables } from "./tables.js";

/**
 * Offboarding: a tenant's data leaves, rows and bytes (D-226).
 *
 * Idempotent in every step, so a crashed run is finished by the next one and the erasure ledger
 * can re-run it after a restore. The order matters:
 *
 *   1. The tenant becomes `offboarding`. From here nothing in the application acts for it
 *      (`TenantGate` treats every status but `active` as closed) and the audit purge function
 *      will accept it.
 *   2. Queued and dead-lettered jobs that name the tenant are removed, so nothing wakes up and
 *      writes a row back after the purge.
 *   3. Stored bytes: the tenant's prefix, and its exports.
 *   4. Rows, children before parents, discovered from the catalogue (see `tables.ts`); then the
 *      audit trail through `audit_purge_tenant`, the one deletion of audit rows that exists.
 *   5. A scan: no table that carries the tenant's id may still hold a row of it, other than the
 *      retained statements. If one does, the job fails and retries rather than reporting success.
 *   6. The `Company` row stays as a tombstone (`deleted`, name cleared): statements and the erasure
 *      ledger refer to its id.
 */

export interface PurgeReport {
  companyId: string;
  /** Rows removed per table. */
  rows: Record<string, number>;
  auditRows: number;
  /** Objects removed from storage (tenant prefix plus exports). */
  objects: number;
  jobsRemoved: number;
  retained: string[];
  alreadyDeleted: boolean;
}

export class PurgeIncompleteError extends Error {
  constructor(readonly leftovers: Record<string, number>) {
    super(`Offboarding left rows behind: ${JSON.stringify(leftovers)}`);
    this.name = "PurgeIncompleteError";
  }
}

export interface TenantPurgerDeps {
  db: PrismaClient;
  storage: StoragePort;
  ledger: ErasureLedger;
  alerts?: AlertPort | undefined;
  now?: () => Date;
  log?: { info: (m: string, meta?: Record<string, unknown>) => void };
}

export class TenantPurger {
  constructor(private readonly deps: TenantPurgerDeps) {}

  async run(companyId: string, requestedBy: string): Promise<PurgeReport> {
    const { db, storage } = this.deps;
    const company = await withSystemTenant(async () =>
      db.company.findUnique({ where: { id: companyId }, select: { id: true, status: true } }),
    );
    if (!company) throw new Error(`Tenant ${companyId} does not exist`);
    const report: PurgeReport = {
      companyId,
      rows: {},
      auditRows: 0,
      objects: 0,
      jobsRemoved: 0,
      retained: Object.keys(RETAINED_TABLES),
      alreadyDeleted: company.status === "deleted",
    };

    // 1. Closed to everyone, and eligible for the audit purge. A tenant that is already `deleted`
    //    is moved back to `offboarding` for the run (the audit purge function accepts nothing
    //    else) and ends `deleted` again: that is how a restore that brought rows back is cleaned.
    if (company.status !== "offboarding") {
      await withSystemTenant(async () =>
        db.company.update({ where: { id: companyId }, data: { status: "offboarding" } }),
      );
    }

    // 2. Jobs that would write the tenant's rows back. The offboarding job itself is excluded.
    report.jobsRemoved = await this.removeJobs(companyId);

    // 3. Bytes.
    report.objects += await storage.deletePrefix(companyPrefix(companyId));
    report.objects += await storage.deletePrefix(exportsPrefix(companyId));

    // 4. Rows.
    const { ordered } = await withTenant(companyId, () => tenantTables(db));
    const todo = ordered.filter((t) => !(t in RETAINED_TABLES) && !(t in SPECIAL_TABLES));
    await this.deleteTokens(companyId);
    let pending = todo;
    // A pass per dependency surprise: a foreign key the ordering did not see makes one DELETE fail
    // and succeed once its dependants are gone.
    for (let pass = 0; pass < 4 && pending.length > 0; pass++) {
      const failed: string[] = [];
      for (const table of pending) {
        try {
          const n = await withTenant(companyId, () =>
            tenantTransaction(db, (tx) =>
              tx.$executeRawUnsafe(`DELETE FROM ${ident(table)} WHERE "companyId" = $1`, companyId),
            ),
          );
          report.rows[table] = (report.rows[table] ?? 0) + n;
        } catch (err) {
          if (pass === 3) throw err;
          failed.push(table);
        }
      }
      pending = failed;
    }
    if ("AuditLog" in SPECIAL_TABLES) {
      const removed = await withSystemTenant(() =>
        tenantTransaction(db, (tx) =>
          tx.$queryRawUnsafe<{ n: number }[]>("SELECT audit_purge_tenant($1) AS n", companyId),
        ),
      );
      report.auditRows = removed[0]?.n ?? 0;
    }

    // 5. The scan.
    const leftovers = await this.leftovers(companyId, ordered);
    if (Object.keys(leftovers).length > 0) throw new PurgeIncompleteError(leftovers);

    // 6. The tombstone, the ledger, the announcement.
    await withSystemTenant(async () =>
      db.company.update({
        where: { id: companyId },
        data: { status: "deleted", name: "Deleted tenant", monthlyBudgetCents: 0 },
      }),
    );
    await this.deps.ledger.record({
      kind: "tenant",
      targetId: companyId,
      tenantRef: companyId,
      requestedBy,
      ...(this.deps.now ? { erasedAt: this.deps.now().toISOString() } : {}),
    });
    await this.deps.alerts?.raise({
      kind: "tenant.offboarded",
      key: `tenant.offboarded:${companyId}`,
      title: "Tenant offboarded",
      message: `Tenant ${companyId} was offboarded: ${Object.values(report.rows).reduce((a, b) => a + b, 0)} rows and ${report.objects} stored objects removed, ${report.auditRows} audit rows purged.`,
      context: { companyId },
      audience: ["operator"],
    });
    this.deps.log?.info("tenant offboarded", {
      companyId,
      rows: report.rows,
      objects: report.objects,
      auditRows: report.auditRows,
    });
    return report;
  }

  /** Pending and dead-lettered jobs carrying the tenant's id. A queue that does not exist yet is not an error. */
  private async removeJobs(companyId: string): Promise<number> {
    try {
      return await withSystemTenant(() =>
        tenantTransaction(this.deps.db, (tx) =>
          tx.$executeRawUnsafe(
            `DELETE FROM pgboss.job WHERE data->>'companyId' = $1 AND name NOT IN ('tenant.offboard')`,
            companyId,
          ),
        ),
      );
    } catch {
      return 0;
    }
  }

  /** Sign-in tokens of the tenant's users: platform-level rows keyed by address, so removed by it. */
  private async deleteTokens(companyId: string): Promise<void> {
    const { db } = this.deps;
    const users = await withTenant(companyId, () =>
      db.user.findMany({ where: { companyId }, select: { email: true } }),
    );
    if (users.length === 0) return;
    await withSystemTenant(async () =>
      db.verificationToken.deleteMany({ where: { identifier: { in: users.map((u) => u.email) } } }),
    );
  }

  private async leftovers(companyId: string, tables: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const table of tables) {
      if (table in RETAINED_TABLES) continue;
      const r = await withSystemTenant(() =>
        tenantTransaction(this.deps.db, (tx) =>
          tx.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*) AS n FROM ${ident(table)} WHERE "companyId" = $1`,
            companyId,
          ),
        ),
      );
      const n = Number(r[0]?.n ?? 0);
      if (n > 0) out[table] = n;
    }
    return out;
  }
}
