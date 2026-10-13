import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  HealthSweep,
  MemoryAlerts,
  MemoryJobAdmin,
  PrismaHealthInputs,
  deadLetterKey,
  type BackupStatusRead,
  type DiskReading,
  type HealthInputs,
  type HealthThresholds,
  type ProviderCallStats,
} from "../src/index.js";

const NOW = new Date("2026-10-13T12:00:00Z");
const thresholds: HealthThresholds = {
  diskWarnPercent: 80,
  diskCriticalPercent: 90,
  providerErrorRate: 0.25,
  backupMaxAgeHours: 26,
};

interface Fakes {
  admin: MemoryJobAdmin;
  backup: BackupStatusRead;
  disk: DiskReading | null;
  providers: ProviderCallStats[];
}

function sweep(f: Partial<Fakes> = {}): { sweep: HealthSweep; alerts: MemoryAlerts; fakes: Fakes } {
  const fakes: Fakes = {
    admin: f.admin ?? new MemoryJobAdmin(),
    backup: f.backup ?? { state: "unconfigured" },
    disk: f.disk ?? null,
    providers: f.providers ?? [],
  };
  const inputs: HealthInputs = {
    queues: () => fakes.admin.list(),
    stuck: () => fakes.admin.stuck(),
    deadLetters: (q, n) => fakes.admin.deadLetters(q, n),
    backup: async () => fakes.backup,
    disk: async () => fakes.disk,
    providerCalls: async () => fakes.providers,
  };
  const alerts = new MemoryAlerts();
  return {
    sweep: new HealthSweep({ inputs, alerts, thresholds: async () => thresholds, now: () => NOW }),
    alerts,
    fakes,
  };
}

const GB = 1024 ** 3;

describe("HealthSweep", () => {
  it("raises job.stuck for a queue with jobs active past expiry, and resolves it when they clear", async () => {
    const admin = new MemoryJobAdmin();
    admin.stuckJobs = [{ name: "session.extract", count: 7 }];
    const { sweep: s, alerts } = sweep({ admin });
    await s.run();
    expect(alerts.ofKind("job.stuck")).toHaveLength(1);
    expect(alerts.ofKind("job.stuck")[0]).toMatchObject({
      key: "job.stuck:session.extract",
      context: { queue: "session.extract", count: 7 },
    });
    expect(alerts.resolved).not.toContain("job.stuck:session.extract");

    admin.stuckJobs = [];
    const second = sweep({ admin });
    await second.sweep.run();
    expect(second.alerts.resolved).toContain("job.stuck:session.extract");
  });

  it("raises job.dead_lettered for a dead letter the consumer never saw, under the handler's own key", async () => {
    const admin = new MemoryJobAdmin();
    admin.addDead("analysis.run", {
      id: "dead-1",
      sourceId: "orig-1",
      raw: { analysisId: "an1", companyId: "co1" },
    });
    const { sweep: s, alerts } = sweep({ admin });
    await s.run();
    const raised = alerts.ofKind("job.dead_lettered");
    expect(raised).toHaveLength(1);
    expect(raised[0]?.key).toBe(deadLetterKey("analysis.run", "orig-1"));
    expect(raised[0]?.context).toMatchObject({ queue: "analysis.run", jobId: "orig-1", tenantId: "co1" });
    // The operator hears about it; the tenant's admins are not part of this kind.
    expect(raised[0]?.audience).toEqual(["operator"]);
  });

  describe("backup", () => {
    it("says nothing when no ops state is configured", async () => {
      const { sweep: s, alerts } = sweep({ backup: { state: "unconfigured" } });
      await s.run();
      expect(alerts.ofKind("backup.failed")).toHaveLength(0);
      expect(alerts.ofKind("backup.missing")).toHaveLength(0);
    });

    it("raises backup.failed with the last good time when the last run failed", async () => {
      const { sweep: s, alerts } = sweep({
        backup: {
          state: "present",
          status: {
            lastResult: "failed",
            lastRunAt: "2026-10-13T03:20:00Z",
            lastSuccessAt: "2026-10-12T03:20:00Z",
            error: "pg_dump exited 1",
          },
        },
      });
      await s.run();
      const [a] = alerts.ofKind("backup.failed");
      expect(a?.message).toContain("pg_dump exited 1");
      expect(a?.message).toContain("2026-10-12T03:20:00Z");
    });

    it("raises backup.missing when the last success is older than the limit", async () => {
      const { sweep: s, alerts } = sweep({
        backup: {
          state: "present",
          status: { lastResult: "ok", lastSuccessAt: "2026-10-11T04:00:00Z" },
        },
      });
      await s.run();
      const [a] = alerts.ofKind("backup.missing");
      expect(a?.title).toBe("No successful backup for 56 h");
    });

    it("raises backup.missing when the backup container has never reported", async () => {
      const { sweep: s, alerts } = sweep({ backup: { state: "absent" } });
      await s.run();
      expect(alerts.ofKind("backup.missing")).toHaveLength(1);
    });

    it("measures a fresh install from when the scheduler started, not from never", async () => {
      const fresh = sweep({
        backup: { state: "present", status: { lastResult: "none", startedAt: "2026-10-13T09:00:00Z" } },
      });
      await fresh.sweep.run();
      expect(fresh.alerts.ofKind("backup.missing")).toHaveLength(0);
      const old = sweep({
        backup: { state: "present", status: { lastResult: "none", startedAt: "2026-10-10T09:00:00Z" } },
      });
      await old.sweep.run();
      expect(old.alerts.ofKind("backup.missing")).toHaveLength(1);
    });

    it("resolves both when a run succeeds", async () => {
      const { sweep: s, alerts } = sweep({
        backup: { state: "present", status: { lastResult: "ok", lastSuccessAt: "2026-10-13T03:20:00Z" } },
      });
      await s.run();
      expect(alerts.resolved).toEqual(expect.arrayContaining(["backup.failed", "backup.missing"]));
    });
  });

  describe("disk", () => {
    it.each([
      [0.85, "disk.high:warning", "warning"],
      [0.93, "disk.high:critical", "critical"],
    ])("at %s it raises %s", async (used, key, severity) => {
      const { sweep: s, alerts } = sweep({
        disk: { path: "/uploads", totalBytes: 40 * GB, usedBytes: used * 40 * GB },
      });
      await s.run();
      expect(alerts.ofKind("disk.high")).toHaveLength(1);
      expect(alerts.ofKind("disk.high")[0]).toMatchObject({ key, severity });
    });

    it("raises nothing and resolves both tiers below the warning threshold", async () => {
      const { sweep: s, alerts } = sweep({
        disk: { path: "/uploads", totalBytes: 40 * GB, usedBytes: 10 * GB },
      });
      await s.run();
      expect(alerts.ofKind("disk.high")).toHaveLength(0);
      expect(alerts.resolved).toEqual(expect.arrayContaining(["disk.high:warning", "disk.high:critical"]));
    });
  });

  describe("provider error rate", () => {
    it("raises when a quarter of at least ten calls failed", async () => {
      const { sweep: s, alerts } = sweep({
        providers: [{ providerId: "p1", name: "OpenRouter (platform)", total: 38, failed: 14 }],
      });
      await s.run();
      const [a] = alerts.ofKind("provider.error_rate");
      expect(a?.key).toBe("provider.error_rate:p1");
      expect(a?.message).toContain("14 of 38");
    });

    it("ignores a provider with too little traffic to say anything", async () => {
      const { sweep: s, alerts } = sweep({
        providers: [{ providerId: "p1", name: "x", total: 4, failed: 4 }],
      });
      await s.run();
      expect(alerts.ofKind("provider.error_rate")).toHaveLength(0);
      expect(alerts.resolved).toContain("provider.error_rate:p1");
    });
  });

  it("keeps going when one check throws", async () => {
    const admin = new MemoryJobAdmin();
    admin.stuck = async () => {
      throw new Error("pgboss unreachable");
    };
    const { sweep: s, alerts } = sweep({
      admin,
      backup: { state: "present", status: { lastResult: "failed" } },
    });
    await s.run();
    expect(alerts.ofKind("backup.failed")).toHaveLength(1);
  });
});

describe("PrismaHealthInputs files", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  const inputs = async (opsStateDir?: string): Promise<PrismaHealthInputs> =>
    new PrismaHealthInputs({
      db: {} as PrismaClient,
      admin: new MemoryJobAdmin(),
      ...(opsStateDir ? { opsStateDir } : {}),
    });

  it("reports unconfigured, absent, unreadable and present", async () => {
    expect(await (await inputs()).backup()).toEqual({ state: "unconfigured" });

    const dir = await mkdtemp(join(tmpdir(), "ops-state-"));
    dirs.push(dir);
    const i = await inputs(dir);
    expect(await i.backup()).toEqual({ state: "absent" });

    await mkdir(join(dir, "status"));
    await writeFile(join(dir, "status", "backup.json"), "{not json");
    expect(await i.backup()).toEqual({ state: "unreadable" });

    await writeFile(join(dir, "status", "backup.json"), JSON.stringify({ lastResult: "ok", sizeBytes: 5 }));
    expect(await i.backup()).toEqual({ state: "present", status: { lastResult: "ok", sizeBytes: 5 } });
  });

  it("measures the disk the way df does", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ops-disk-"));
    dirs.push(dir);
    const reading = await (await inputs(dir)).disk();
    expect(reading?.path).toBe(dir);
    expect(reading?.totalBytes).toBeGreaterThan(0);
    expect(reading?.usedBytes).toBeGreaterThan(0);
    expect(reading?.usedBytes).toBeLessThanOrEqual(reading?.totalBytes ?? 0);
  });
});
