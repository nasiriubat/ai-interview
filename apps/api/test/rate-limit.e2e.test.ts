import type { Server } from "node:http";
import { describeDb } from "@aidp/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fakeModelServer, testWorld, type TestWorld } from "./helpers.js";

const suite = describeDb;

const MAX = 5;

suite("global rate limit (spec 11)", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };

  beforeAll(async () => {
    model = await fakeModelServer(() => "ready");
    // A ceiling small enough to burst past in a test; production defaults live in config.ts.
    world = await testWorld(model.url, { RATE_LIMIT_MAX: String(MAX), RATE_LIMIT_EXPENSIVE_MAX: "2" });
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  const get = (url: string, token: string) =>
    world.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

  it("answers a burst past the limit with the contract's rate_limited shape and RateLimit headers", async () => {
    const codes: number[] = [];
    let last = await get("/api/v1/me", world.adminToken);
    for (let i = 0; i < MAX + 2; i++) {
      last = await get("/api/v1/me", world.adminToken);
      codes.push(last.statusCode);
    }
    expect(codes).toContain(429);
    expect(last.statusCode).toBe(429);
    expect(last.json()).toEqual({
      error: { code: "rate_limited", message: "Too many requests" },
    });
    // The IETF draft-spec names, not the older x-prefixed ones.
    expect(last.headers["ratelimit-limit"]).toBe(String(MAX));
    expect(last.headers["ratelimit-remaining"]).toBe("0");
    expect(last.headers["ratelimit-reset"]).toBeDefined();
    expect(last.headers["retry-after"]).toBeDefined();
  });

  it("never limits the health checks", async () => {
    for (let i = 0; i < MAX * 4; i++) {
      const res = await world.app.inject({ method: "GET", url: "/api/v1/health/live" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["ratelimit-limit"]).toBeUndefined();
    }
    expect((await world.app.inject({ method: "GET", url: "/api/v1/health/ready" })).statusCode).toBe(200);
  });

  it("gives each principal its own bucket", async () => {
    // The admin is already over the limit from the burst above; the operator is untouched.
    expect((await get("/api/v1/me", world.adminToken)).statusCode).toBe(429);
    const operator = await get("/api/v1/me", world.operatorToken);
    expect(operator.statusCode).toBe(200);
    expect(operator.headers["ratelimit-remaining"]).toBe(String(MAX - 1));
  });

  it("holds a tighter, separate ceiling on routes that call a provider", async () => {
    // A fresh principal, so the global bucket is not what stops this.
    const preview = (): Promise<{ statusCode: number }> =>
      world.app.inject({
        method: "POST",
        url: `/api/v1/templates/${world.templateId}/preview`,
        headers: { authorization: `Bearer ${world.operatorToken}`, "x-company-id": world.companyId },
        payload: {},
      });
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await preview()).statusCode);
    // Two through at the expensive ceiling, then the door shuts — well short of the global five,
    // so the expensive bucket really is its own and not a share of the principal's allowance.
    expect(codes).toEqual([200, 200, 429, 429]);
  });

  it("limits paths that match no route, so scanning is not the one free ride", async () => {
    const codes: number[] = [];
    for (let i = 0; i < MAX + 2; i++) {
      const res = await world.app.inject({ method: "GET", url: `/api/v1/nope-${i}` });
      codes.push(res.statusCode);
    }
    expect(codes[0]).toBe(404);
    expect(codes.at(-1)).toBe(429);
  });
});
