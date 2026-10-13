import type { Server } from "node:http";
import { INTERNAL_AUTH_HEADER } from "@aidp/shared";
import { describeDb } from "@aidp/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fakeModelServer, TEST_AUTH_SECRET, testWorld, type TestWorld } from "./helpers.js";

const suite = describeDb;

const PATH = "/api/v1/internal/auth/verification-tokens";

suite("internal verification-token routes (D-56)", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };

  beforeAll(async () => {
    model = await fakeModelServer(() => "ready");
    world = await testWorld(model.url);
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  const secret = { [INTERNAL_AUTH_HEADER]: TEST_AUTH_SECRET };
  const post = (url: string, payload: object, headers: Record<string, string> = secret) =>
    world.app.inject({ method: "POST", url, headers, payload });

  const inAnHour = (): string => new Date(Date.now() + 3_600_000).toISOString();
  const unique = (): string => `hash-${Math.random().toString(36).slice(2)}`;

  it("round-trips a token and consumes it exactly once", async () => {
    const identifier = `round-trip-${Date.now()}@test.io`;
    const token = unique();
    const expires = inAnHour();

    const created = await post(PATH, { identifier, token, expires });
    expect(created.statusCode).toBe(201);
    expect(created.json<{ token: { identifier: string } }>().token.identifier).toBe(identifier);

    // What is stored is exactly what Auth.js handed over: already a hash, never hashed again.
    const row = await world.db.verificationToken.findFirstOrThrow({ where: { identifier } });
    expect(row.token).toBe(token);

    const first = await post(`${PATH}/consume`, { identifier, token });
    expect(first.statusCode).toBe(200);
    expect(first.json<{ token: { token: string; expires: string } }>().token).toEqual({
      identifier,
      token,
      expires,
    });

    const second = await post(`${PATH}/consume`, { identifier, token });
    expect(second.statusCode).toBe(404);
    expect(second.json<{ error: { code: string } }>().error.code).toBe("not_found");
    // The 404 body says nothing about the token it was asked for.
    expect(second.body).not.toContain(token);
  });

  it("prunes expired tokens and leaves live ones alone", async () => {
    const live = { identifier: `live-${Date.now()}@test.io`, token: unique(), expires: inAnHour() };
    const stale = {
      identifier: `stale-${Date.now()}@test.io`,
      token: unique(),
      expires: new Date(Date.now() - 60_000).toISOString(),
    };
    // The live one first: a create sweeps expired rows on the way through, so creating it after
    // the stale one would prune the stale one before the route below gets a chance to.
    expect((await post(PATH, live)).statusCode).toBe(201);
    expect((await post(PATH, stale)).statusCode).toBe(201);

    const pruned = await post(`${PATH}/prune`, {});
    expect(pruned.statusCode).toBe(200);
    expect(pruned.json<{ deleted: number }>().deleted).toBeGreaterThanOrEqual(1);

    expect(
      (await post(`${PATH}/consume`, { identifier: stale.identifier, token: stale.token })).statusCode,
    ).toBe(404);
    expect(
      (await post(`${PATH}/consume`, { identifier: live.identifier, token: live.token })).statusCode,
    ).toBe(200);
  });

  it("refuses a missing, wrong, or session-shaped credential", async () => {
    const body = { identifier: "nobody@test.io", token: unique(), expires: inAnHour() };

    expect((await post(PATH, body, {})).statusCode).toBe(401);
    expect((await post(PATH, body, { [INTERNAL_AUTH_HEADER]: "" })).statusCode).toBe(401);
    // Same length as the real secret, so length alone never distinguishes the two.
    const sameLength = "x".repeat(TEST_AUTH_SECRET.length);
    expect((await post(PATH, body, { [INTERNAL_AUTH_HEADER]: sameLength })).statusCode).toBe(401);
    expect((await post(PATH, body, { [INTERNAL_AUTH_HEADER]: `${TEST_AUTH_SECRET}x` })).statusCode).toBe(401);

    // These are not staff routes: an admin session, with no shared secret, gets nothing.
    const asAdmin = await post(PATH, body, { authorization: `Bearer ${world.adminToken}` });
    expect(asAdmin.statusCode).toBe(401);

    // Nothing was written by any of the refused attempts.
    expect(await world.db.verificationToken.count({ where: { identifier: body.identifier } })).toBe(0);
  });

  it("stays out of the public OpenAPI document", async () => {
    const doc = await world.app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    const paths = Object.keys(doc.json<{ paths: Record<string, unknown> }>().paths);
    expect(paths.filter((p) => p.startsWith("/internal/"))).toEqual([]);
  });
});
