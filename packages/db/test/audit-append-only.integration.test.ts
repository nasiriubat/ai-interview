import { randomBytes } from "node:crypto";
import { describeDb, purgeAuditLog } from "@aidp/testing";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, expect, it } from "vitest";
import { withTenant, withTenantScope } from "../src/index.js";

/**
 * The audit log is append-only at the database and tamper-evident (A2, D-163).
 *
 * Proven against Postgres as both roles that matter: `app_api`, which the application connects
 * as and which has had UPDATE, DELETE and TRUNCATE revoked, and the owner, which the revoke does
 * not bind and which is held back by triggers unless the purge flag is set.
 */
describeDb("audit log: append-only and hash-chained", () => {
  const owner = new PrismaClient();
  const PASSWORD = "audit-append-only-password";
  let api: PrismaClient;
  let scoped: PrismaClient;
  let companyId = "";

  const entry = (n: number, extra: Record<string, unknown> = {}) => ({
    companyId,
    actorId: null,
    action: `test.event_${n}`,
    targetType: "test",
    targetId: `t-${n}`,
    diff: { n, ...extra },
  });

  beforeAll(async () => {
    const url = process.env.DATABASE_URL!;
    await owner.$executeRawUnsafe(`ALTER ROLE app_api WITH LOGIN PASSWORD '${PASSWORD}'`);
    const u = new URL(url);
    u.username = "app_api";
    u.password = PASSWORD;
    api = new PrismaClient({ datasources: { db: { url: u.toString() } } });
    scoped = withTenantScope(api);
    companyId = (await owner.company.create({ data: { name: `Audit ${randomBytes(3).toString("hex")}` } }))
      .id;
  });
  afterAll(async () => {
    await purgeAuditLog(owner, [companyId]);
    await owner.company.delete({ where: { id: companyId } });
    await api.$disconnect();
    await owner.$disconnect();
  });

  const verify = (db: PrismaClient = owner) =>
    db.$queryRaw<{ company: string; seq: number; id: string; problem: string }[]>`
      SELECT company, seq, id, problem FROM audit_chain_verify(${companyId}::text)`;

  it("lets the application append, and gives each row its place in the chain", async () => {
    await withTenant(companyId, async () => {
      for (let i = 1; i <= 3; i++) await scoped.auditLog.create({ data: entry(i) });
    });
    const rows = await owner.auditLog.findMany({ where: { companyId }, orderBy: { seq: "asc" } });
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(rows[0]?.prevHash).toBe("");
    expect(rows[1]?.prevHash).toBe(rows[0]?.hash);
    expect(rows[2]?.prevHash).toBe(rows[1]?.hash);
    expect(new Set(rows.map((r) => r.hash)).size).toBe(3);
    expect(await verify()).toEqual([]);
  });

  it("keeps one unbroken chain under concurrent writers", async () => {
    await withTenant(companyId, async () => {
      await Promise.all(
        Array.from({ length: 24 }, (_, i) => scoped.auditLog.create({ data: entry(100 + i) })),
      );
    });
    const rows = await owner.auditLog.findMany({ where: { companyId }, orderBy: { seq: "asc" } });
    expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: rows.length }, (_, i) => i + 1));
    expect(await verify()).toEqual([]);
  });

  it("refuses UPDATE, DELETE and TRUNCATE as the application role", async () => {
    const target = await owner.auditLog.findFirstOrThrow({ where: { companyId } });
    await withTenant(companyId, async () => {
      await expect(
        scoped.auditLog.update({ where: { id: target.id }, data: { action: "edited" } }),
      ).rejects.toThrow(/permission denied|append-only/i);
      await expect(scoped.auditLog.delete({ where: { id: target.id } })).rejects.toThrow(
        /permission denied|append-only/i,
      );
    });
    await expect(api.$executeRawUnsafe('TRUNCATE TABLE "AuditLog"')).rejects.toThrow(
      /permission denied|append-only/i,
    );
    const stillThere = await owner.auditLog.findUniqueOrThrow({ where: { id: target.id } });
    expect(stillThere.action).toBe(target.action);
  });

  it("refuses them as the owner too, unless the purge flag is set, and the flag never allows an edit", async () => {
    const target = await owner.auditLog.findFirstOrThrow({ where: { companyId } });
    await expect(
      owner.auditLog.update({ where: { id: target.id }, data: { action: "edited" } }),
    ).rejects.toThrow(/append-only/);
    await expect(owner.auditLog.delete({ where: { id: target.id } })).rejects.toThrow(/append-only/);
    await expect(owner.$executeRawUnsafe('TRUNCATE TABLE "AuditLog"')).rejects.toThrow(/append-only/);

    // With the purge flag a DELETE passes ... but an UPDATE still does not.
    await expect(
      owner.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL app.audit_purge = 'on'");
        await tx.$executeRawUnsafe(`UPDATE "AuditLog" SET action = 'edited' WHERE id = '${target.id}'`);
      }),
    ).rejects.toThrow(/append-only/);
  });

  it("finds a row that was edited by someone who switched the triggers off", async () => {
    const sentinel = new Error("rollback");
    let problems: Awaited<ReturnType<typeof verify>> = [];
    await owner
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe('ALTER TABLE "AuditLog" DISABLE TRIGGER "AuditLog_no_change"');
        const victim = await tx.auditLog.findFirstOrThrow({ where: { companyId, seq: 2 } });
        await tx.$executeRawUnsafe(
          `UPDATE "AuditLog" SET action = 'user.nothing_to_see' WHERE id = '${victim.id}'`,
        );
        problems = await tx.$queryRaw`
          SELECT company, seq, id, problem FROM audit_chain_verify(${companyId}::text)`;
        throw sentinel; // leave the table as it was
      })
      .catch((e: unknown) => {
        if (e !== sentinel) throw e;
      });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ seq: 2, problem: expect.stringMatching(/hash does not match/) });
    expect(await verify()).toEqual([]);
  });

  it("finds a row that was removed from the middle of the chain", async () => {
    const sentinel = new Error("rollback");
    let problems: Awaited<ReturnType<typeof verify>> = [];
    await owner
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL app.audit_purge = 'on'");
        await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "companyId" = '${companyId}' AND seq = 2`);
        problems = await tx.$queryRaw`
          SELECT company, seq, id, problem FROM audit_chain_verify(${companyId}::text)`;
        throw sentinel;
      })
      .catch((e: unknown) => {
        if (e !== sentinel) throw e;
      });
    expect(problems.map((p) => p.problem).join(";")).toMatch(/gap/);
    expect(await verify()).toEqual([]);
  });

  it("is also what the preflight asserts: no privilege, both triggers present", async () => {
    const [priv] = await owner.$queryRaw<{ u: boolean; d: boolean; t: boolean }[]>`
      SELECT has_table_privilege('app_api', '"AuditLog"', 'UPDATE') AS u,
             has_table_privilege('app_api', '"AuditLog"', 'DELETE') AS d,
             has_table_privilege('app_api', '"AuditLog"', 'TRUNCATE') AS t`;
    expect(priv).toEqual({ u: false, d: false, t: false });
    const triggers = await owner.$queryRaw<{ tgname: string }[]>`
      SELECT tgname FROM pg_trigger
       WHERE tgrelid = '"AuditLog"'::regclass AND NOT tgisinternal ORDER BY tgname`;
    expect(triggers.map((t) => t.tgname)).toEqual(
      expect.arrayContaining(["AuditLog_chain", "AuditLog_no_change", "AuditLog_no_truncate"]),
    );
  });
});
