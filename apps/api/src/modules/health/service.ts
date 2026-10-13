import type { PrismaClient } from "@prisma/client";

/** Whether the database answers. Not tenant-owned: it reads no row at all. */
export class HealthService {
  constructor(private readonly db: PrismaClient) {}

  /** `{ ok: false, err }` rather than a throw, so the readiness probe can log and still answer 503. */
  async checkDatabase(): Promise<{ ok: true } | { ok: false; err: unknown }> {
    try {
      await this.db.$queryRaw`SELECT 1`;
      return { ok: true };
    } catch (err) {
      return { ok: false, err };
    }
  }
}
