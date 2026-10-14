import type { Server } from "node:http";
import { describeDb } from "@aidp/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fakeModelServer, testWorld, type TestWorld } from "./helpers.js";

/**
 * Key rotation from the operator's side (P9, D-164): a status that says what each key still seals,
 * and a re-key that is queued, audited and refused to everyone else.
 */
describeDb("operator crypto status and re-key", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };

  beforeAll(async () => {
    model = await fakeModelServer(() => "x");
    world = await testWorld(model.url, { RATE_LIMIT_MAX: "100000" });
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  const as = (token: string) => ({ authorization: `Bearer ${token}` });

  it("reports the ring and how many stored secrets each key seals, without any key material", async () => {
    const res = await world.app.inject({
      method: "GET",
      url: "/api/v1/operator/crypto/status",
      headers: as(world.operatorToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      ring: { id: string; active: boolean }[];
      columns: { table: string; column: string; purpose: string; byKey: Record<string, number> }[];
      pending: number;
    }>();
    expect(body.ring).toHaveLength(1);
    expect(body.ring[0]).toEqual({ id: world.crypto.activeKeyId, active: true });
    const apiKeys = body.columns.find((c) => c.column === "apiKeyEnc");
    // The world's provider key was sealed by the application, under the active key, as v2.
    expect(apiKeys?.byKey[world.crypto.activeKeyId]).toBeGreaterThanOrEqual(1);
    // (Other suites leave values of their own in a shared database, so only this key is asserted.)
    // Nothing secret travels: no base64 key, no plaintext.
    expect(res.body).not.toContain("fake-model");
    expect(res.body).not.toMatch(/"(key|apiKey|plaintext)"/);
  });

  it("queues the re-key job once, and audits who asked and what the ring was", async () => {
    const before = world.jobs.published.length;
    const res = await world.app.inject({
      method: "POST",
      url: "/api/v1/operator/crypto/rekey",
      headers: as(world.operatorToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, queued: "crypto.rekey" });
    expect(world.jobs.published.slice(before)).toEqual([
      expect.objectContaining({ name: "crypto.rekey", payload: {} }),
    ]);

    const op = await world.db.user.findFirstOrThrow({ where: { email: world.operatorEmail } });
    const row = await world.db.auditLog.findFirstOrThrow({
      where: { action: "crypto.rekey_requested", actorId: op.id },
      orderBy: { createdAt: "desc" },
    });
    expect(row.diff).toMatchObject({ activeKeyId: world.crypto.activeKeyId });
  });

  it("is the operator's alone", async () => {
    for (const [method, url] of [
      ["GET", "/api/v1/operator/crypto/status"],
      ["POST", "/api/v1/operator/crypto/rekey"],
    ] as const) {
      expect((await world.app.inject({ method, url })).statusCode).toBe(401);
      expect((await world.app.inject({ method, url, headers: as(world.adminToken) })).statusCode).toBe(403);
    }
  });
});
