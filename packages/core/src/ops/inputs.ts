import { readFile, statfs } from "node:fs/promises";
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
