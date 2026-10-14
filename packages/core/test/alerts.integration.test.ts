import { randomBytes } from "node:crypto";
import { withSystemTenant, withTenant, withTenantScope } from "@aidp/db";
import { purgeAuditLog } from "@aidp/testing";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AlertRouter,
  Crypto,
  MemoryAlertState,
  MemoryEmail,
  PrismaAlertState,
  SettingsService,
  type AlertState,
  type OccurrenceInput,
} from "../src/index.js";

const suite = process.env.DATABASE_URL ? describe : describe.skip;

const API_PASSWORD = "test-app-role";
const apiUrl = (owner: string): string => {
  const u = new URL(owner);
  u.username = "app_api";
  u.password = API_PASSWORD;
  return u.toString();
};

suite("alert state and routing against Postgres", () => {
  const owner = new PrismaClient();
  const tag = `alerts_${Date.now().toString(36)}`;
  let api: PrismaClient;
  let scoped: PrismaClient;
  let tenantA = "";
  let tenantB = "";
  const keys: string[] = [];

  const key = (name: string): string => {
    const k = `${tag}:${name}`;
    keys.push(k);
    return k;
  };

  beforeAll(async () => {
    await owner.$executeRawUnsafe(`ALTER ROLE app_api WITH LOGIN PASSWORD '${API_PASSWORD}'`);
    api = new PrismaClient({ datasources: { db: { url: apiUrl(process.env.DATABASE_URL ?? "") } } });
    scoped = withTenantScope(api);
    tenantA = (await owner.company.create({ data: { name: `Alerts A ${tag}` } })).id;
    tenantB = (await owner.company.create({ data: { name: `Alerts B ${tag}` } })).id;
  });

  afterAll(async () => {
    await owner.opsAlert.deleteMany({
      where: { OR: [{ key: { startsWith: tag } }, { key: { startsWith: `rate:${tag}` } }] },
    });
    await purgeAuditLog(owner, [tenantA, tenantB]);
    await owner.setting.deleteMany({ where: { scope: "tenant", scopeId: { in: [tenantA, tenantB] } } });
    await owner.user.deleteMany({ where: { companyId: { in: [tenantA, tenantB] } } });
    await owner.company.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
    await api.$disconnect();
    await owner.$disconnect();
  });

  const at = (minutes: number): Date => new Date(Date.UTC(2026, 9, 13, 10, minutes));
  const input = (k: string, over: Partial<OccurrenceInput> = {}): OccurrenceInput => ({
    key: k,
    kind: "job.dead_lettered",
    severity: "critical",
    title: "t",
    message: "m",
    context: {},
    now: at(0),
    repeatMs: 60 * 60_000,
    ...over,
  });

  // The same contract, run against both adapters: the in-memory one is what every other test
  // trusts, so it must not be allowed to drift from the table.
  const adapters: [string, () => AlertState][] = [
    ["MemoryAlertState", () => new MemoryAlertState()],
    ["PrismaAlertState (as app_api)", () => new PrismaAlertState(scoped)],
  ];

  describe.each(adapters)("%s", (_name, make) => {
    it("claims the first occurrence and counts the repeats inside the window", async () => {
      const s = make();
      const k = key(`claim-${_name}`);
      expect(await s.record(input(k))).toEqual({ notify: true, count: 1, alreadyDelivered: false });
      expect(await s.record(input(k, { now: at(10) }))).toEqual({
        notify: false,
        count: 2,
        alreadyDelivered: true,
      });
    });

    it("notifies again after the window, after a resolve, and on escalation", async () => {
      const s = make();
      const k = key(`again-${_name}`);
      await s.record(input(k, { severity: "warning" }));
      expect((await s.record(input(k, { now: at(61), severity: "warning" }))).notify).toBe(true);
      expect((await s.record(input(k, { now: at(62), severity: "warning" }))).notify).toBe(false);
      // Escalating inside the window is news.
      expect((await s.record(input(k, { now: at(63), severity: "critical" }))).notify).toBe(true);
      await s.resolve(k, at(64));
      const reopened = await s.record(input(k, { now: at(65), severity: "critical" }));
      expect(reopened).toEqual({ notify: true, count: 1, alreadyDelivered: false });
    });

    it("gives the claim back on release, so a failed send is retried at once", async () => {
      const s = make();
      const k = key(`release-${_name}`);
      await s.record(input(k));
      await s.release(k);
      expect((await s.record(input(k, { now: at(1) }))).notify).toBe(true);
    });

    it("counts notifications per bucket", async () => {
      const s = make();
      const bucket = `${tag}:${_name}:2026-10-13T10`;
      expect(await s.bump(bucket, at(0))).toBe(1);
      expect(await s.bump(bucket, at(1))).toBe(2);
      expect(await s.bump(`${bucket}:other`, at(1))).toBe(1);
    });
  });

  it("lets two writers race one key and gives exactly one of them the notification", async () => {
    const s = new PrismaAlertState(scoped);
    const k = key("race");
    const results = await Promise.all(Array.from({ length: 8 }, () => s.record(input(k))));
    expect(results.filter((r) => r.notify)).toHaveLength(1);
    const row = await owner.opsAlert.findUniqueOrThrow({ where: { key: k } });
    expect(row.count).toBe(8);
  });

  describe("row-level security on OpsAlert", () => {
    it("is enabled with a policy, which is what keeps the preflight from refusing the stack", async () => {
      const rows = await owner.$queryRaw<{ rowsecurity: boolean }[]>`
        select relrowsecurity as rowsecurity from pg_class where relname = 'OpsAlert'`;
      expect(rows[0]?.rowsecurity).toBe(true);
    });

    it("shows a tenant its own alerts and the platform's, never another tenant's", async () => {
      const kA = key("rls-a");
      const kB = key("rls-b");
      const kP = key("rls-p");
      await new PrismaAlertState(scoped).record(input(kA, { companyId: tenantA }));
      await new PrismaAlertState(scoped).record(input(kB, { companyId: tenantB }));
      await new PrismaAlertState(scoped).record(input(kP));
      const seen = await withTenant(tenantA, async () =>
        (await scoped.opsAlert.findMany({ where: { key: { in: [kA, kB, kP] } } })).map((r) => r.key).sort(),
      );
      expect(seen).toEqual([kA, kP].sort());
    });

    it("refuses a tenant a write that would create or change a platform row", async () => {
      await withTenant(tenantA, async () => {
        await expect(
          scoped.opsAlert.create({
            data: { key: key("rls-write"), kind: "x", severity: "info", title: "t", companyId: null },
          }),
        ).rejects.toThrow(/row-level security/i);
      });
    });

    it("lets the system context write both, which is how the router runs", async () => {
      await withSystemTenant(async () => {
        await scoped.opsAlert.create({
          data: { key: key("rls-system"), kind: "x", severity: "info", title: "t", companyId: tenantB },
        });
      });
      expect(await owner.opsAlert.count({ where: { key: `${tag}:rls-system` } })).toBe(1);
    });
  });

  it("routes a real alert end to end: row, mail to the operator, audit row", async () => {
    const platform = await owner.company.create({ data: { name: `Alerts platform ${tag}` } });
    const opEmail = `op-${tag}@example.com`;
    await owner.user.create({ data: { companyId: platform.id, email: opEmail, role: "platform_operator" } });
    const adminEmail = `admin-${tag}@example.com`;
    await owner.user.create({ data: { companyId: tenantA, email: adminEmail, role: "admin" } });
    try {
      const email = new MemoryEmail();
      const settings = new SettingsService(scoped, new Crypto(randomBytes(32).toString("base64")));
      const warnings: unknown[] = [];
      const router = new AlertRouter({
        db: scoped,
        state: new PrismaAlertState(scoped),
        settings,
        email,
        publicWebUrl: "https://pilot.example.com",
        log: { warn: (m, meta) => warnings.push({ m, meta }) },
      });
      const k = key("e2e");
      const result = await router.raise({
        kind: "budget.exceeded",
        key: k,
        companyId: tenantA,
        title: "Budget used up",
        message: "Used up.",
      });
      expect(result).toEqual({ delivered: true, suppressed: null });
      // This database may hold other operators; the tenant's mail is the part that must be exact.
      expect(email.sent.some((m) => m.to === adminEmail && m.companyId === tenantA)).toBe(true);
      const row = await owner.opsAlert.findUniqueOrThrow({ where: { key: k } });
      expect(row).toMatchObject({ kind: "budget.exceeded", companyId: tenantA, count: 1 });
      expect(row.notifiedAt).not.toBeNull();
      const audit = await owner.auditLog.findFirst({
        where: { companyId: tenantA, action: "alert.sent", targetId: k },
      });
      expect(warnings).toEqual([]);
      expect(audit?.diff).toMatchObject({ kind: "budget.exceeded" });

      // The same condition again is a duplicate, in the database, across router instances.
      const second = new AlertRouter({
        db: scoped,
        state: new PrismaAlertState(scoped),
        settings,
        email,
        publicWebUrl: "https://pilot.example.com",
      });
      const before = email.sent.length;
      expect(
        await second.raise({ kind: "budget.exceeded", key: k, companyId: tenantA, title: "t", message: "m" }),
      ).toEqual({
        delivered: true,
        suppressed: "duplicate",
      });
      expect(email.sent).toHaveLength(before);
    } finally {
      await owner.user.deleteMany({ where: { companyId: platform.id } });
      await owner.company.delete({ where: { id: platform.id } });
    }
  });
});
