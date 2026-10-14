import type { AlertPort } from "../alerts/port.js";
import type { DeadJob, QueueSummary, StuckJobs } from "../jobs/admin.js";
import { JOBS, type JobName } from "../jobs/definitions.js";
import type { Metrics } from "../telemetry/metrics.js";

/** What `deploy/backup/backup.sh` writes to `<ops_state>/status/backup.json` after every run. */
export interface BackupStatus {
  /** When the scheduler started; the clock a fresh install is measured from before its first run. */
  startedAt?: string;
  lastRunAt?: string;
  lastResult?: "ok" | "failed" | "none";
  lastSuccessAt?: string;
  /** Plain text for a human: what failed and where to look. */
  error?: string;
  dump?: string;
  sizeBytes?: number;
  offsite?: "ok" | "failed" | "not_configured";
  offsiteLastSuccessAt?: string;
  counts?: Record<string, number>;
  /**
   * The weekly restore drill (D-227): `deploy/backup/restore-drill.sh` restores the latest dump into a
   * scratch database, compares the row counts to the manifest above, and writes what it found.
   */
  drill?: {
    at?: string;
    result?: "ok" | "failed";
    /** What did not match, or what failed; plain text. */
    error?: string;
    durationS?: number;
    dump?: string;
    lastSuccessAt?: string;
  };
}

export type BackupStatusRead =
  /** No ops state directory is configured (development): the sweep has nothing to say. */
  | { state: "unconfigured" }
  /** The directory exists and the backup container has never reported. */
  | { state: "absent" }
  | { state: "unreadable" }
  | { state: "present"; status: BackupStatus };

export interface DiskReading {
  path: string;
  totalBytes: number;
  usedBytes: number;
}

export interface ProviderCallStats {
  providerId: string;
  /** Display name, for the message only. */
  name: string;
  total: number;
  failed: number;
}

/** Everything the sweep looks at, as a port, so each alert source is provoked in a test with a fake. */
export interface HealthInputs {
  queues(): Promise<QueueSummary[]>;
  stuck(): Promise<StuckJobs[]>;
  deadLetters(queue: JobName, limit: number): Promise<DeadJob[]>;
  backup(): Promise<BackupStatusRead>;
  /** Null when no volume is configured to measure. */
  disk(): Promise<DiskReading | null>;
  /** Calls made since `since`, grouped by provider. */
  providerCalls(since: Date): Promise<ProviderCallStats[]>;
  /** Per-tenant gauges for the metrics endpoint; absent in inputs that have no database. */
  tenantActivity?(): Promise<{ companyId: string; activeSessions: number; storageBytes: number }[]>;
  /** Age in seconds of the worker's own liveness file, or null when it is not configured. */
  heartbeatAgeSeconds?(): Promise<number | null>;
}

export interface HealthThresholds {
  diskWarnPercent: number;
  diskCriticalPercent: number;
  providerErrorRate: number;
  backupMaxAgeHours: number;
}

export interface SweepResult {
  raised: string[];
  resolved: string[];
}

/** The window the provider error rate is measured over, and the least traffic that says anything. */
export const PROVIDER_WINDOW_MINUTES = 10;
export const PROVIDER_MIN_CALLS = 10;
const DEAD_LETTERS_PER_QUEUE = 20;

const gb = (bytes: number): string => (bytes / 1024 ** 3).toFixed(1);
const hours = (ms: number): number => Math.floor(ms / 3_600_000);

/**
 * The sweep that makes "nothing fails silently" true (D-92). Runs every five minutes in the
 * worker, and on demand from the operator jobs page. It only reads and raises: it never fails a
 * job or touches a backup, so a bug here can cost a false page and not an outage.
 *
 * Everything it raises it also resolves, as soon as the condition is gone, so the next occurrence
 * is announced again instead of being swallowed as a duplicate of yesterday's.
 */
export class HealthSweep {
  private readonly now: () => Date;

  constructor(
    private readonly deps: {
      inputs: HealthInputs;
      alerts: AlertPort;
      thresholds: () => Promise<HealthThresholds>;
      /** Where the readings are published as gauges (D-222). */
      metrics?: Metrics;
      now?: () => Date;
      log?: { warn: (message: string, meta?: Record<string, unknown>) => void };
    },
  ) {
    this.now = deps.now ?? (() => new Date());
  }

  async run(): Promise<SweepResult> {
    const out: SweepResult = { raised: [], resolved: [] };
    const t = await this.deps.thresholds();
    // Each check is independent: a failing disk read must not hide a failed backup.
    for (const [name, check] of [
      ["stuck jobs", () => this.stuckJobs(out)],
      ["dead letters", () => this.deadLetters(out)],
      ["backup", () => this.backup(t, out)],
      ["disk", () => this.disk(t, out)],
      ["providers", () => this.providers(t, out)],
      ["drill", () => this.drill(out)],
      ["gauges", () => this.gauges()],
    ] as const) {
      try {
        await check();
      } catch (err) {
        this.deps.log?.warn("health sweep check failed", { check: name, err: String(err) });
      }
    }
    return out;
  }

  private async raise(out: SweepResult, alert: Parameters<AlertPort["raise"]>[0]): Promise<void> {
    await this.deps.alerts.raise(alert);
    out.raised.push(alert.key);
  }

  private async clear(out: SweepResult, key: string): Promise<void> {
    await this.deps.alerts.resolve(key);
    out.resolved.push(key);
  }

  private async stuckJobs(out: SweepResult): Promise<void> {
    const stuck = await this.deps.inputs.stuck();
    const byName = new Map(stuck.map((s) => [s.name, s.count]));
    for (const name of Object.keys(JOBS)) {
      const count = byName.get(name);
      if (count) {
        await this.raise(out, {
          kind: "job.stuck",
          key: `job.stuck:${name}`,
          title: `${count} ${name} job${count === 1 ? "" : "s"} stuck`,
          message: `${count} job${count === 1 ? " is" : "s are"} still active in ${name} well past the expiry of ${JOBS[name as JobName].expireInSeconds} s. The queue's own maintenance should have failed them, so it may not be running; restarting the worker restarts it.`,
          context: { queue: name, count },
        });
      } else {
        await this.clear(out, `job.stuck:${name}`);
      }
    }
  }

  /**
   * Dead letters the consumer did not see: a job that died by expiry (the worker was killed
   * mid-run) never passes through the handler's catch, so nothing raised for it. The key is the
   * one the handler uses, built from the original job id, so a job both report is one alert.
   */
  private async deadLetters(out: SweepResult): Promise<void> {
    const queues = await this.deps.inputs.queues();
    for (const q of queues) {
      if (q.deadLettered === 0) continue;
      const dead = await this.deps.inputs.deadLetters(q.name, DEAD_LETTERS_PER_QUEUE);
      for (const job of dead) {
        await this.raise(out, {
          kind: "job.dead_lettered",
          key: deadLetterKey(q.name, job.sourceId ?? job.id),
          title: `Job dead-lettered: ${q.name}`,
          message: `A ${q.name} job failed its last attempt and is waiting in ${q.name}.dead. Retry or discard it from the operator jobs page.`,
          context: {
            queue: q.name,
            jobId: job.sourceId ?? job.id,
            attempts: job.retryCount + 1,
            ...(job.companyId ? { tenantId: job.companyId } : {}),
          },
          ...(job.companyId ? { companyId: job.companyId } : {}),
          audience: ["operator"],
        });
      }
    }
  }

  private async backup(t: HealthThresholds, out: SweepResult): Promise<void> {
    const read = await this.deps.inputs.backup();
    if (read.state === "unconfigured") return;
    if (read.state === "absent" || read.state === "unreadable") {
      await this.raise(out, {
        kind: "backup.missing",
        key: "backup.missing",
        title: "No backup status",
        message:
          read.state === "absent"
            ? "The backup container has not written a status report, so there is no evidence a backup has ever run. Check `dc logs backup`."
            : "The backup status file exists but cannot be read, so the last backup cannot be verified. Check `dc logs backup`.",
      });
      return;
    }
    const s = read.status;
    if (s.lastResult === "failed") {
      await this.raise(out, {
        kind: "backup.failed",
        key: "backup.failed",
        title: "Backup failed",
        message: `The backup run at ${s.lastRunAt ?? "an unknown time"} failed${s.error ? `: ${s.error}` : ""}. Last good backup: ${s.lastSuccessAt ?? "none recorded"}.`,
        context: { lastSuccessAt: s.lastSuccessAt ?? "none" },
      });
    } else {
      await this.clear(out, "backup.failed");
    }
    const since = s.lastSuccessAt ?? s.startedAt;
    const sinceMs = since ? Date.parse(since) : Number.NaN;
    if (Number.isNaN(sinceMs)) return;
    const age = this.now().getTime() - sinceMs;
    if (age > t.backupMaxAgeHours * 3_600_000) {
      await this.raise(out, {
        kind: "backup.missing",
        key: "backup.missing",
        title: `No successful backup for ${hours(age)} h`,
        message: `The last successful backup was ${s.lastSuccessAt ?? "never"}; the limit is ${t.backupMaxAgeHours} h.`,
        context: { hoursSince: hours(age), limitHours: t.backupMaxAgeHours },
      });
    } else {
      await this.clear(out, "backup.missing");
    }
  }

  /**
   * The weekly restore drill (D-227). A failed drill is as serious as a failed backup: it means the
   * newest dump may not restore. Cleared by the next drill that matches its manifest.
   */
  private async drill(out: SweepResult): Promise<void> {
    const read = await this.deps.inputs.backup();
    if (read.state !== "present") return;
    const d = read.status.drill;
    if (!d?.result) return;
    if (d.result === "failed") {
      await this.raise(out, {
        kind: "backup.drill_failed",
        key: "backup.drill_failed",
        title: "Restore drill failed",
        message: `The restore drill at ${d.at ?? "an unknown time"} failed${d.error ? `: ${d.error}` : ""}. The newest backup may not restore; run deploy/backup/restore-drill.sh by hand and read its output.`,
        context: { ...(d.dump ? { dump: d.dump } : {}), lastSuccessAt: d.lastSuccessAt ?? "none" },
      });
    } else {
      await this.clear(out, "backup.drill_failed");
    }
  }

  /** Publishes what the sweep already reads as gauges; every reading is optional and best-effort. */
  private async gauges(): Promise<void> {
    const m = this.deps.metrics;
    if (!m) return;
    const { inputs } = this.deps;
    const now = this.now().getTime();
    for (const q of await inputs.queues())
      m.queue(
        q.name,
        q.queued,
        q.active,
        q.deadLettered,
        q.oldestQueuedAt ? Math.max(0, Math.round((now - Date.parse(q.oldestQueuedAt)) / 1000)) : 0,
      );
    const read = await inputs.backup();
    if (read.state === "present") {
      const s = read.status;
      const sec = (iso?: string): number | undefined => {
        const t = iso ? Date.parse(iso) : Number.NaN;
        return Number.isNaN(t) ? undefined : Math.floor(t / 1000);
      };
      const ok = sec(s.lastSuccessAt);
      if (ok !== undefined) m.gauge("backup_last_success_timestamp_seconds", ok);
      if (s.sizeBytes !== undefined) m.gauge("backup_last_size_bytes", s.sizeBytes);
      const off = sec(s.offsiteLastSuccessAt);
      if (off !== undefined) m.gauge("backup_offsite_last_success_timestamp_seconds", off);
      const drill = sec(s.drill?.lastSuccessAt ?? (s.drill?.result === "ok" ? s.drill.at : undefined));
      if (drill !== undefined) m.gauge("restore_drill_last_success_timestamp_seconds", drill);
    }
    const disk = await inputs.disk();
    if (disk && disk.totalBytes > 0)
      m.gauge("disk_used_ratio", disk.usedBytes / disk.totalBytes, { mount: disk.path });
    if (inputs.tenantActivity) {
      for (const t of await inputs.tenantActivity()) {
        m.gauge("sessions_active", t.activeSessions, { tenant: t.companyId });
        m.gauge("storage_bytes", t.storageBytes, { tenant: t.companyId });
      }
    }
    const age = await inputs.heartbeatAgeSeconds?.();
    if (age !== null && age !== undefined) m.gauge("worker_heartbeat_age_seconds", age);
  }

  private async disk(t: HealthThresholds, out: SweepResult): Promise<void> {
    const d = await this.deps.inputs.disk();
    if (!d || d.totalBytes <= 0) return;
    const percent = Math.round((d.usedBytes / d.totalBytes) * 100);
    const message = `Disk is ${percent}% used (${gb(d.usedBytes)} of ${gb(d.totalBytes)} GB) at ${d.path}. See docs/OPERATIONS.md for what to prune first.`;
    const context = { percent, usedGb: Number(gb(d.usedBytes)), totalGb: Number(gb(d.totalBytes)) };
    if (percent >= t.diskCriticalPercent) {
      await this.raise(out, {
        kind: "disk.high",
        key: "disk.high:critical",
        severity: "critical",
        title: `Disk ${percent}% used`,
        message,
        context,
      });
      await this.clear(out, "disk.high:warning");
    } else if (percent >= t.diskWarnPercent) {
      await this.raise(out, {
        kind: "disk.high",
        key: "disk.high:warning",
        severity: "warning",
        title: `Disk ${percent}% used`,
        message,
        context,
      });
      await this.clear(out, "disk.high:critical");
    } else {
      await this.clear(out, "disk.high:warning");
      await this.clear(out, "disk.high:critical");
    }
  }

  private async providers(t: HealthThresholds, out: SweepResult): Promise<void> {
    const since = new Date(this.now().getTime() - PROVIDER_WINDOW_MINUTES * 60_000);
    for (const p of await this.deps.inputs.providerCalls(since)) {
      const key = `provider.error_rate:${p.providerId}`;
      const rate = p.total === 0 ? 0 : p.failed / p.total;
      if (p.total >= PROVIDER_MIN_CALLS && rate >= t.providerErrorRate) {
        await this.raise(out, {
          kind: "provider.error_rate",
          key,
          title: `Provider failing: ${p.name}`,
          message: `${p.failed} of ${p.total} calls to provider '${p.name}' failed in the last ${PROVIDER_WINDOW_MINUTES} minutes (${Math.round(rate * 100)}%).`,
          context: {
            providerId: p.providerId,
            failed: p.failed,
            total: p.total,
            percent: Math.round(rate * 100),
          },
        });
      } else {
        await this.clear(out, key);
      }
    }
  }
}

/** The key under which a dead-lettered job is announced and, once handled, resolved. */
export function deadLetterKey(queue: string, jobId: string): string {
  return `job.dead_lettered:${queue}:${jobId}`;
}
