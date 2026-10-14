import { readFile, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { withSystemTenant } from "@aidp/db";
import type { PrismaClient } from "@prisma/client";
import type { JobAdminPort } from "../jobs/admin.js";
import type { JobName } from "../jobs/definitions.js";
import type { BackupStatusRead, DiskReading, HealthInputs, ProviderCallStats } from "./health-sweep.js";

export interface PrismaHealthInputsDeps {
  db: PrismaClient;
  admin: JobAdminPort;
  /**
   * The `ops_state` volume (D-92). Unset in development, where the backup and the disk are the
   * developer's own and not worth an alert; the sweep then simply skips those two checks.
   */
  opsStateDir?: string | undefined;
  /** What to measure for disk use: the volume the uploads and, usually, the database share. */
  diskPath?: string | undefined;
}

/** The production inputs: the queue through the admin port, files from `ops_state`, the ledger from Postgres. */
export class PrismaHealthInputs implements HealthInputs {
  constructor(private readonly deps: PrismaHealthInputsDeps) {}

  queues(): ReturnType<JobAdminPort["list"]> {
    return this.deps.admin.list();
  }

  stuck(): ReturnType<JobAdminPort["stuck"]> {
    return this.deps.admin.stuck();
  }

  deadLetters(queue: JobName, limit: number): ReturnType<JobAdminPort["deadLetters"]> {
    return this.deps.admin.deadLetters(queue, limit);
  }

  async backup(): Promise<BackupStatusRead> {
    const dir = this.deps.opsStateDir;
    if (!dir) return { state: "unconfigured" };
    let raw: string;
    try {
      raw = await readFile(join(dir, "status", "backup.json"), "utf8");
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ENOENT" ? { state: "absent" } : { state: "unreadable" };
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
        return { state: "unreadable" };
      return { state: "present", status: parsed };
    } catch {
      return { state: "unreadable" };
    }
  }

  async disk(): Promise<DiskReading | null> {
    const path = this.deps.diskPath ?? this.deps.opsStateDir;
    if (!path) return null;
    const s = await statfs(path);
    // The same arithmetic `df` uses: space reserved for root counts as used, not as free.
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    const used = total - s.bfree * s.bsize;
    return { path, totalBytes: used + free, usedBytes: used };
  }

  async heartbeatAgeSeconds(): Promise<number | null> {
    const dir = this.deps.opsStateDir;
    if (!dir) return null;
    try {
      const s = await stat(join(dir, "heartbeat", "worker"));
      return Math.max(0, Math.round((Date.now() - s.mtimeMs) / 1000));
    } catch {
      return null;
    }
  }

  async tenantActivity(): Promise<{ companyId: string; activeSessions: number; storageBytes: number }[]> {
    return withSystemTenant(async () => {
      const since = new Date(Date.now() - 5 * 60_000);
      const [active, storage] = await Promise.all([
        this.deps.db.session.groupBy({
          by: ["companyId"],
          where: { updatedAt: { gte: since }, status: { in: ["active", "consented"] } },
          _count: { _all: true },
        }),
        this.deps.db.attachment.groupBy({ by: ["companyId"], _sum: { sizeBytes: true } }),
      ]);
      const out = new Map<string, { companyId: string; activeSessions: number; storageBytes: number }>();
      for (const a of active)
        out.set(a.companyId, { companyId: a.companyId, activeSessions: a._count._all, storageBytes: 0 });
      for (const s of storage) {
        const row = out.get(s.companyId) ?? { companyId: s.companyId, activeSessions: 0, storageBytes: 0 };
        row.storageBytes = s._sum.sizeBytes ?? 0;
        out.set(s.companyId, row);
      }
      return [...out.values()];
    });
  }

  async providerCalls(since: Date): Promise<ProviderCallStats[]> {
    return withSystemTenant(async () => {
      const groups = await this.deps.db.llmCall.groupBy({
        by: ["providerId", "status"],
        where: { createdAt: { gte: since }, status: { in: ["ok", "error"] } },
        _count: { _all: true },
      });
      const ids = [...new Set(groups.map((g) => g.providerId))];
      if (ids.length === 0) return [];
      const providers = await this.deps.db.provider.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true },
      });
      return ids.map((providerId) => {
        const mine = groups.filter((g) => g.providerId === providerId);
        const count = (status: string): number =>
          mine.filter((g) => g.status === status).reduce((n, g) => n + g._count._all, 0);
        return {
          providerId,
          name: providers.find((p) => p.id === providerId)?.name ?? providerId,
          total: count("ok") + count("error"),
          failed: count("error"),
        };
      });
    });
  }
}
