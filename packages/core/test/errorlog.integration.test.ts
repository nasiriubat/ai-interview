import { randomBytes } from "node:crypto";
import { withSystemTenant, withTenant, withTenantScope } from "@aidp/db";
import { APP_ROLE_TEST_PASSWORD, APP_ROLE_TEST_USER, describeDb, setAppRolePassword } from "@aidp/testing";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  ErrorRecorder,
  PrismaErrorStore,
  hourKey,
  sanitizeError,
  sweepErrorLog,
  type ErrorEvent,
  type ErrorWrite,
} from "../src/index.js";

/**
 * The error log against Postgres, as `app_api` (D-477): the atomic group upsert, the newest-20
 * window, reopening, the tenant fence, the retention sweep and the global ceilings.
 */
describeDb("error log store and sweep", () => {
  const owner = new PrismaClient();
  const tag = `errlog_${randomBytes(4).toString("hex")}`;
  let api: PrismaClient;
  let scoped: PrismaClient;
  let tenantA = "";
  let tenantB = "";

  const apiUrl = (): string => {
    const u = new URL(process.env.DATABASE_URL ?? "");
    u.username = APP_ROLE_TEST_USER;
    u.password = APP_ROLE_TEST_PASSWORD;
    return u.toString();
  };

  const write = (event: Partial<ErrorEvent>, count = 1, storeOccurrence = true, at?: Date): ErrorWrite => ({
    record: sanitizeError({ source: "api", message: `${tag} boom`, route: `/${tag}`, ...event }, at),
    count,
    storeOccurrence,
  });

  const groupsOf = (where: Record<string, unknown> = {}) =>
    owner.errorGroup.findMany({
      where: { message: { startsWith: tag }, ...where },
      orderBy: { lastSeenAt: "asc" },
    });

  beforeAll(async () => {
    await setAppRolePassword(owner);
    api = new PrismaClient({ datasources: { db: { url: apiUrl() } } });
    scoped = withTenantScope(api);
    tenantA = (await owner.company.create({ data: { name: `Errors A ${tag}` } })).id;
    tenantB = (await owner.company.create({ data: { name: `Errors B ${tag}` } })).id;
  });

  afterAll(async () => {
    await owner.errorGroup.deleteMany({ where: { message: { startsWith: tag } } });
    await owner.company.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
    await api.$disconnect();
    await owner.$disconnect();
  });

  it("counts into one group, keeps the newest 20 occurrences, and reopens a resolved group", async () => {
    const store = new PrismaErrorStore(scoped);
    const batch = Array.from({ length: 25 }, (_, i) =>
      write({ companyId: tenantA, requestId: `r${i}` }, 1, true, new Date(Date.now() + i)),
    );
    await store.write(batch);
    await store.write([write({ companyId: tenantA }, 7, false)]);
    const [group] = await groupsOf({ companyId: tenantA });
    expect(group).toMatchObject({ count: 32, companyId: tenantA, resolvedAt: null });
    const kept = await owner.errorOccurrence.findMany({
      where: { groupId: group!.id },
      orderBy: { occurredAt: "desc" },
    });
    expect(kept).toHaveLength(20);
    expect(kept[0]?.requestId).toBe("r24");
    expect((group!.hourly as Record<string, number>)[hourKey(new Date())]).toBeGreaterThanOrEqual(7);

    await owner.errorGroup.update({
      where: { id: group!.id },
      data: { resolvedAt: new Date(), resolvedById: "u" },
    });
    await store.write([write({ companyId: tenantA })]);
    const reopened = await owner.errorGroup.findUniqueOrThrow({ where: { id: group!.id } });
    expect(reopened.resolvedAt).toBeNull();
    expect(reopened.count).toBe(33);
  });

  it("keeps one fault apart per tenant, and records a tenant that does not exist as the platform's", async () => {
    const store = new PrismaErrorStore(scoped);
    await store.write([
      write({ companyId: tenantB, message: `${tag} split` }),
      write({ companyId: null, message: `${tag} split` }),
      write({ companyId: "no-such-company", message: `${tag} split` }),
    ]);
    const groups = await groupsOf({ message: `${tag} split` });
    expect(groups.map((g) => g.companyId).sort()).toEqual([null, tenantB].sort());
    expect(new Set(groups.map((g) => g.fingerprint)).size).toBe(1);
    expect(groups.find((g) => g.companyId === null)?.count).toBe(2);
  });

  it("is fenced: a tenant sees only its own rows, no tenant sees nothing, the system sees all", async () => {
    const mine = await withTenant(tenantB, () =>
      scoped.errorGroup.findMany({ where: { message: { startsWith: tag } } }),
    );
    expect(mine.every((g) => g.companyId === tenantB)).toBe(true);
    expect(mine.length).toBeGreaterThan(0);
    expect(await scoped.errorGroup.count({ where: { message: { startsWith: tag } } })).toBe(0);
    const all = await withSystemTenant(() =>
      scoped.errorGroup.count({ where: { message: { startsWith: tag } } }),
    );
    expect(all).toBeGreaterThanOrEqual(3);
  });

  it("writes through the recorder without the caller waiting, and survives a store that fails", async () => {
    const rec = new ErrorRecorder({ store: new PrismaErrorStore(scoped), autoFlush: false });
    rec.capture({ source: "browser", message: `${tag} from a browser`, path: "/admin/x" });
    await rec.flush();
    expect(
      await owner.errorGroup.count({ where: { message: `${tag} from a browser`, source: "browser" } }),
    ).toBe(1);
  });

  it("sweeps what was not seen within the retention, and enforces the ceilings oldest first", async () => {
    const store = new PrismaErrorStore(scoped);
    const old = new Date(Date.now() - 10 * 86_400_000);
    await store.write([write({ message: `${tag} stale` }, 1, true, old)]);
    // A group still seen, with an occurrence older than the retention: the occurrence goes, the group stays.
    await store.write([
      write({ message: `${tag} lively` }, 1, true, old),
      write({ message: `${tag} lively` }),
    ]);
    const before = await groupsOf({ message: `${tag} stale` });
    expect(before).toHaveLength(1);

    const r = await sweepErrorLog(scoped, { retentionDays: 7 });
    expect(r.groups).toBeGreaterThanOrEqual(1);
    expect(await groupsOf({ message: `${tag} stale` })).toHaveLength(0);
    const lively = (await groupsOf({ message: `${tag} lively` }))[0]!;
    expect(await owner.errorOccurrence.count({ where: { groupId: lively.id } })).toBe(1);
    // Hourly counters older than eight days are trimmed.
    expect(
      Object.keys(lively.hourly as object).every((k) => k >= hourKey(new Date(Date.now() - 8 * 86_400_000))),
    ).toBe(true);

    // The ceilings remove the oldest first. Other suites share this database and write as they
    // run, so the rows this proves on are made the oldest in it (six days, inside the retention),
    // and the ceiling is set to one less than what is there.
    const sixDays = new Date(Date.now() - 6 * 86_400_000);
    await store.write([write({ message: `${tag} oldest` }, 1, true, sixDays)]);
    const oldest = (await groupsOf({ message: `${tag} oldest` }))[0]!;
    const occurrences = await owner.errorOccurrence.count();
    const capped = await sweepErrorLog(scoped, { retentionDays: 7, maxOccurrences: occurrences - 1 });
    expect(capped.capped).toBeGreaterThanOrEqual(1);
    expect(await owner.errorOccurrence.count({ where: { groupId: oldest.id } })).toBe(0);
    expect(await owner.errorOccurrence.count({ where: { groupId: lively.id } })).toBe(1);

    const groups = await owner.errorGroup.count();
    const groupsCapped = await sweepErrorLog(scoped, { retentionDays: 7, maxGroups: groups - 1 });
    expect(groupsCapped.groups).toBeGreaterThanOrEqual(1);
    expect(await owner.errorGroup.count({ where: { id: oldest.id } })).toBe(0);
    expect(await owner.errorGroup.count({ where: { id: lively.id } })).toBe(1);
  });
});
