import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { withSystemTenant } from "@aidp/db";
import type { PrismaClient } from "@prisma/client";
import type { JobPublisher } from "../../jobs/definitions.js";

/**
 * What was erased on purpose, so that a restore does not bring it back (D-226, security plan A5).
 *
 * Two copies, because they answer different questions. The `ErasureLedger` table is the queryable
 * history the operator reads. The append-only file on the `ops_state` volume is the one that
 * matters after a restore: a database restored from last week's backup has last week's table, and
 * the erasure from yesterday is exactly what that table does not know. The file lives outside the
 * database and outside the backup, so it still says what was erased; `reapplyErasures` reads it at
 * worker start and queues the erasures again for anything that is back.
 *
 * Ids only. Never a name, an address or a count of anything about a person.
 */
export type ErasureKind = "tenant" | "session";

export interface ErasureEntry {
  kind: ErasureKind;
  targetId: string;
  /** The tenant the target belonged to. For a tenant erasure, the tenant itself. */
  tenantRef: string;
  erasedAt: string;
  requestedBy?: string | undefined;
}

export interface ErasureLedgerDeps {
  db: PrismaClient;
  /** `<OPS_STATE_DIR>/erasures.jsonl`. Absent in development, where only the table is written. */
  filePath?: string | undefined;
  now?: () => Date;
}

export class ErasureLedger {
  constructor(private readonly deps: ErasureLedgerDeps) {}

  async record(entry: Omit<ErasureEntry, "erasedAt"> & { erasedAt?: string }): Promise<ErasureEntry> {
    const full: ErasureEntry = {
      ...entry,
      erasedAt: entry.erasedAt ?? (this.deps.now?.() ?? new Date()).toISOString(),
    };
    // The file first: if the process dies between the two writes, the entry that survives is the
    // one that outlives a restore.
    await this.appendFile(full);
    await withSystemTenant(async () =>
      this.deps.db.erasureLedger.upsert({
        where: { kind_targetId: { kind: full.kind, targetId: full.targetId } },
        create: {
          kind: full.kind,
          targetId: full.targetId,
          tenantRef: full.tenantRef,
          erasedAt: new Date(full.erasedAt),
          requestedBy: full.requestedBy ?? null,
        },
        update: {},
      }),
    );
    return full;
  }

  private async appendFile(entry: ErasureEntry): Promise<void> {
    const path = this.deps.filePath;
    if (!path) return;
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o644 });
  }

  /** Every entry in the file; unreadable lines are skipped, a missing file is empty. */
  async fromFile(): Promise<ErasureEntry[]> {
    const path = this.deps.filePath;
    if (!path) return [];
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: ErasureEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as ErasureEntry;
        if (e.targetId && e.tenantRef) out.push(e);
      } catch {
        // A torn last line from a crash: the entries before it are still good.
      }
    }
    return out;
  }
}

export interface ReapplyDeps {
  db: PrismaClient;
  ledger: ErasureLedger;
  jobs: JobPublisher;
  log?: {
    warn: (m: string, meta?: Record<string, unknown>) => void;
    info: (m: string, meta?: Record<string, unknown>) => void;
  };
}

/**
 * Compares the file against the database and queues the erasure again for anything that has come
 * back: a tenant whose status is not `deleted`, a session that is not `deleted`. Idempotent and
 * cheap to run on every worker start; on a healthy system it finds nothing.
 */
export async function reapplyErasures(deps: ReapplyDeps): Promise<{ tenants: string[]; sessions: string[] }> {
  const entries = await deps.ledger.fromFile();
  const out = { tenants: [] as string[], sessions: [] as string[] };
  if (entries.length === 0) return out;
  const tenants = entries.filter((e) => e.kind === "tenant");
  const sessions = entries.filter((e) => e.kind === "session");
  await withSystemTenant(async () => {
    if (tenants.length) {
      const back = await deps.db.company.findMany({
        where: { id: { in: tenants.map((t) => t.targetId) }, status: { not: "deleted" } },
        select: { id: true },
      });
      for (const c of back) {
        await deps.jobs.publish(
          "tenant.offboard",
          { companyId: c.id, requestedBy: "erasure-ledger" },
          { singletonKey: `tenant.offboard:${c.id}` },
        );
        out.tenants.push(c.id);
      }
    }
    if (sessions.length) {
      const back = await deps.db.session.findMany({
        where: { id: { in: sessions.map((s) => s.targetId) }, status: { not: "deleted" } },
        select: { id: true, companyId: true },
      });
      for (const s of back) {
        await deps.jobs.publish(
          "privacy.delete-session",
          { companyId: s.companyId, sessionId: s.id },
          { singletonKey: `privacy.delete-session:${s.id}` },
        );
        out.sessions.push(s.id);
      }
    }
  });
  if (out.tenants.length || out.sessions.length)
    deps.log?.warn("re-applying erasures that a restore brought back", {
      tenants: out.tenants.length,
      sessions: out.sessions.length,
    });
  return out;
}
