import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSystemTenant, withTenant, withTenantScope } from "../src/index.js";

/**
 * Proves the second fence actually holds: connected as `app_api`, Postgres itself refuses another
 * tenant's rows even when the application forgets to filter. Needs DATABASE_URL on a migrated
 * database whose owner can create a login role.
 */
const url = process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;

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
});
