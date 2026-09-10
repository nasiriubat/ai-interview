import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { forCompany } from "../src/index.js";

/** Runs only when DATABASE_URL points at a migrated database. */
const url = process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;

suite("tenant-scoped client", () => {
  const db = new PrismaClient();
  let a = "";
  let b = "";

  beforeAll(async () => {
    a = (await db.company.create({ data: { name: "A" } })).id;
    b = (await db.company.create({ data: { name: "B" } })).id;
    await db.user.create({ data: { companyId: a, email: "a@a.test", role: "admin" } });
    await db.user.create({ data: { companyId: b, email: "b@b.test", role: "admin" } });
  });

  afterAll(async () => {
    await db.user.deleteMany({ where: { companyId: { in: [a, b] } } });
    await db.company.deleteMany({ where: { id: { in: [a, b] } } });
    await db.$disconnect();
  });

  it("never returns another tenant's rows and stamps companyId on writes", async () => {
    const scoped = forCompany(db, a);
    const users = await scoped.user.findMany();
    expect(users.map((u) => u.companyId)).toEqual([a]);
    expect(await scoped.user.findFirst({ where: { email: "b@b.test" } })).toBeNull();
    const created = await scoped.user.create({ data: { email: "c@a.test", role: "member", companyId: b } });
    expect(created.companyId).toBe(a);
    expect(await scoped.user.count()).toBe(2);
  });
});
