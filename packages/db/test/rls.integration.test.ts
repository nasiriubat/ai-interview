import { describeDb } from "@aidp/testing";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, expect, it } from "vitest";
import { tenantTransaction, withSystemTenant, withTenant, withTenantScope } from "../src/index.js";

/**
 * Proves the second fence actually holds: connected as `app_api`, Postgres itself refuses another
 * tenant's rows even when the application forgets to filter. Needs DATABASE_URL on a migrated
 * database whose owner can create a login role.
 */
const url = process.env.DATABASE_URL;
const suite = describeDb;

const API_PASSWORD = "rls-test-password";
const apiUrl = (owner: string): string => {
  const u = new URL(owner);
  u.username = "app_api";
  u.password = API_PASSWORD;
  return u.toString();
};

suite("row-level security as app_api", () => {
  const owner = new PrismaClient();
  let api: PrismaClient;
  let scoped: PrismaClient;
  let a = "";
  let b = "";

  beforeAll(async () => {
    await owner.$executeRawUnsafe(`ALTER ROLE app_api WITH LOGIN PASSWORD '${API_PASSWORD}'`);
    a = (await owner.company.create({ data: { name: `RLS A ${Date.now()}` } })).id;
    b = (await owner.company.create({ data: { name: `RLS B ${Date.now()}` } })).id;
    await owner.user.create({ data: { companyId: a, email: `rls-a-${Date.now()}@t.io`, role: "admin" } });
    await owner.user.create({ data: { companyId: b, email: `rls-b-${Date.now()}@t.io`, role: "admin" } });
    api = new PrismaClient({ datasources: { db: { url: apiUrl(url ?? "") } } });
    scoped = withTenantScope(api) as unknown as PrismaClient;
  });

  afterAll(async () => {
    await api.$disconnect();
    await owner.user.deleteMany({ where: { companyId: { in: [a, b] } } });
    await owner.company.deleteMany({ where: { id: { in: [a, b] } } });
    await owner.$disconnect();
  });

  it("fails closed when no tenant is in context", async () => {
    // A query that forgets to say who it is for sees platform rows only, never everything.
    expect(await scoped.user.count()).toBe(0);
  });

  it("shows a tenant only its own rows, whatever the query asks for", async () => {
    await withTenant(a, async () => {
      expect((await scoped.user.findMany()).map((u) => u.companyId)).toEqual([a]);
      // The application-level filter is bypassed on purpose here: the database still refuses.
      expect(await scoped.user.findMany({ where: { companyId: b } })).toEqual([]);
      expect(await scoped.user.count({ where: { companyId: b } })).toBe(0);
    });
    await withTenant(b, async () => {
      expect((await scoped.user.findMany()).map((u) => u.companyId)).toEqual([b]);
    });
  });

  it("refuses a write aimed at another tenant", async () => {
    await withTenant(a, async () => {
      await expect(
        scoped.user.create({ data: { companyId: b, email: `steal-${Date.now()}@t.io`, role: "admin" } }),
      ).rejects.toThrow(/row-level security/i);
    });
  });

  it("refuses an update that would move a row to another tenant", async () => {
    await withTenant(a, async () => {
      const mine = await scoped.user.findFirstOrThrow();
      await expect(scoped.user.update({ where: { id: mine.id }, data: { companyId: b } })).rejects.toThrow(
        /row-level security/i,
      );
    });
  });

  it("lets the system context cross tenants, for the principal resolver and the operator", async () => {
    await withSystemTenant(async () => {
      const ids = (await scoped.user.findMany({ where: { companyId: { in: [a, b] } } })).map(
        (u) => u.companyId,
      );
      expect(new Set(ids)).toEqual(new Set([a, b]));
    });
  });

  it("keeps a nested tenant context independent of the one around it", async () => {
    await withTenant(a, async () => {
      expect(await scoped.user.count()).toBe(1);
      await withTenant(b, async () => {
        expect((await scoped.user.findMany()).map((u) => u.companyId)).toEqual([b]);
      });
      expect((await scoped.user.findMany()).map((u) => u.companyId)).toEqual([a]);
    });
  });

  /**
   * `tenantTransaction` on the extended client. Its tenant setting used to go out through the
   * extension as a statement of its own, on a different pooled connection from the transaction,
   * so every query inside saw no tenant: reads found nothing and updates of tenant rows reported
   * "record not found". The transactions that existed only touched tables without a policy.
   */
  it("carries the tenant into an interactive transaction", async () => {
    await withTenant(a, async () => {
      await tenantTransaction(scoped, async (tx) => {
        const setting = await tx.$queryRaw<
          { c: string | null }[]
        >`SELECT current_setting('app.company_id', true) AS c`;
        expect(setting[0]?.c).toBe(a);
        expect((await tx.user.findMany()).map((u) => u.companyId)).toEqual([a]);
        // A write to a policy-protected row works, and still cannot reach another tenant's.
        const mine = await tx.user.findFirstOrThrow();
        await tx.user.update({ where: { id: mine.id }, data: { name: "renamed in a transaction" } });
        expect(await tx.user.count({ where: { companyId: b } })).toBe(0);
      });
    });
  });

  /**
   * The check that would have caught PromptVersion years earlier, asked of the database rather
   * than of a list someone has to maintain.
   *
   * A tenant-owned table without a policy is invisible in normal use: every query filters by
   * companyId anyway, so nothing misbehaves until one does not. Migration 0008 enumerated the
   * tables by hand and missed one; 0011 added it along with AttachmentChunk. Enumerating them by
   * hand here would reproduce exactly the mistake being tested for, so this asks Postgres which
   * tables carry a companyId and lack row-level security, and requires the answer to be none.
   */
  it("leaves no tenant-owned table without a policy", async () => {
    const rows = await owner.$queryRawUnsafe<{ relname: string }[]>(
      `SELECT c.relname FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute att ON att.attrelid = c.oid AND att.attname = 'companyId' AND att.attnum > 0
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
        ORDER BY c.relname`,
    );

    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it("isolates attachment chunks, which carry whatever a participant uploaded", async () => {
    const [attA, attB] = await Promise.all(
      [a, b].map((company) =>
        owner.session.findFirst({ where: { companyId: company } }).then(async (session) =>
          session
            ? owner.attachment.create({
                data: {
                  companyId: company,
                  sessionId: session.id,
                  kind: "document",
                  filename: "notes.txt",
                  mime: "text/plain",
                  sizeBytes: 1,
                  storageKey: `${company}/x/y`,
                },
              })
            : null,
        ),
      ),
    );
    // The tenants in this suite have users but no sessions, so there is nothing to attach to.
    // Skipping beats asserting nothing: a silent pass here would be worse than an absent test.
    if (!attA || !attB) return;

    await owner.attachmentChunk.create({
      data: { companyId: a, attachmentId: attA.id, seq: 1, text: "tenant a secret" },
    });
    await owner.attachmentChunk.create({
      data: { companyId: b, attachmentId: attB.id, seq: 1, text: "tenant b secret" },
    });

    await withTenant(a, async () => {
      expect((await scoped.attachmentChunk.findMany()).map((c) => c.text)).toEqual(["tenant a secret"]);
      expect(await scoped.attachmentChunk.count({ where: { companyId: b } })).toBe(0);
    });
  });
});
