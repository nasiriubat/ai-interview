import type { Server } from "node:http";
import { encode } from "@auth/core/jwt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeModelServer, testWorld, TEST_AUTH_SECRET, type TestWorld } from "./helpers.js";

const suite = process.env.DATABASE_URL ? describe : describe.skip;

/**
 * Staff identity (S9, D-84): one tenant per email address, so the address that signs in resolves
 * to exactly one user. Before this, `findFirst` picked whichever row it met first, and a tenant
 * admin could create a user with the platform operator's address.
 */
suite("one tenant per staff email", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };
  let operatorEmail = "";

  beforeAll(async () => {
    model = await fakeModelServer(() => "x");
    world = await testWorld(model.url, { RATE_LIMIT_MAX: "100000" });
    operatorEmail = (
      await world.db.user.findFirstOrThrow({
        where: { role: "platform_operator", email: { contains: "op-" } },
      })
    ).email;
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  const admin = () => ({ authorization: `Bearer ${world.adminToken}`, "content-type": "application/json" });
  const createUser = (email: string, role: "admin" | "member" = "member") =>
    world.app.inject({ method: "POST", url: "/api/v1/users", headers: admin(), payload: { email, role } });

  it("makes the database refuse a second row for an address, in any case", async () => {
    const email = `dup-${Date.now().toString(36)}@x.test`;
    await world.db.user.create({ data: { companyId: world.companyId, email, role: "member" } });
    const other = await world.db.company.create({ data: { name: "Other" } });
    await expect(
      world.db.user.create({ data: { companyId: other.id, email, role: "member" } }),
    ).rejects.toMatchObject({ code: "P2002" });
    await expect(
      world.db.user.create({ data: { companyId: other.id, email: email.toUpperCase(), role: "member" } }),
    ).rejects.toThrow();
  });

  it("answers 409 when an admin names an address that belongs to another tenant, including the operator's", async () => {
    const before = await world.db.user.count();
    const res = await createUser(operatorEmail);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: { code: "conflict", message: "That email address is already registered" },
    });
    // Case does not make a different person.
    expect((await createUser(operatorEmail.toUpperCase())).statusCode).toBe(409);
    expect(await world.db.user.count()).toBe(before);

    // The refusal is audited, and the audit row does not carry the other tenant's address.
    const entry = await world.db.auditLog.findFirstOrThrow({
      where: { companyId: world.companyId, action: "user.create_refused" },
      orderBy: { createdAt: "desc" },
    });
    expect(JSON.stringify(entry)).not.toContain(operatorEmail);
  });

  it("answers 409 for an address already in the admin's own tenant, and 201 for a new one", async () => {
    const email = `new-${Date.now().toString(36)}@x.test`;
    expect((await createUser(email)).statusCode).toBe(201);
    expect((await createUser(email)).statusCode).toBe(409);
    expect((await createUser(email.toUpperCase())).statusCode).toBe(409);
  });

  it("refuses to create a tenant whose admin address is taken, and leaves no half-made tenant", async () => {
    const tenants = await world.db.company.count();
    const res = await world.app.inject({
      method: "POST",
      url: "/api/v1/operator/tenants",
      headers: { authorization: `Bearer ${world.operatorToken}`, "content-type": "application/json" },
      payload: { name: "Clash", adminEmail: world.adminEmail.toUpperCase() },
    });
    expect(res.statusCode).toBe(409);
    expect(await world.db.company.count()).toBe(tenants);
  });

  it("resolves the same address, however the token spells it, to the same user in the same tenant", async () => {
    const spelled = await encode({
      token: { email: world.adminEmail.toUpperCase() },
      secret: TEST_AUTH_SECRET,
      salt: "authjs.session-token",
    });
    const a = await world.app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${spelled}` },
    });
    const b = await world.app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${world.adminToken}` },
    });
    expect(a.statusCode).toBe(200);
    expect(a.json()).toEqual(b.json());
    expect(a.json<{ user: { companyId: string } }>().user.companyId).toBe(world.companyId);
  });

  it("limits address probing through user creation to 20 an hour per admin", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 22; i++) {
      codes.push((await createUser(`probe-${i}-${Date.now().toString(36)}@x.test`)).statusCode);
    }
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(1);
    expect(codes.slice(0, 5).every((c) => c === 201 || c === 429)).toBe(true);
  });
});
