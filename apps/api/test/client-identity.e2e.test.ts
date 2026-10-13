import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addressBucket } from "../src/lib/rate-limit.js";
import { fakeModelServer, testWorld, type TestWorld } from "./helpers.js";

const suite = process.env.DATABASE_URL ? describe : describe.skip;

const MAX = 5;

describe("addressBucket", () => {
  it("keeps IPv4 as it is and unwraps the mapped form", () => {
    expect(addressBucket("203.0.113.5")).toBe("203.0.113.5");
    expect(addressBucket("::ffff:203.0.113.5")).toBe("203.0.113.5");
  });

  it("reduces IPv6 to its /64", () => {
    expect(addressBucket("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:0db8:0001:0002::/64");
    expect(addressBucket("2001:DB8:1:2::1")).toBe("2001:0db8:0001:0002::/64");
    expect(addressBucket("2001:db8::1")).toBe("2001:0db8:0000:0000::/64");
    expect(addressBucket("::1")).toBe("0000:0000:0000:0000::/64");
    expect(addressBucket("fe80::1%eth0")).toBe("fe80:0000:0000:0000::/64");
  });
});

/**
 * Client identity (S1, D-82). The web process forwards the address Caddy saw; the API trusts a
 * stated number of proxy hops and no more, so a caller cannot pick its own bucket by sending a
 * header, and a visitor is not billed for everyone else behind the same web container.
 */
suite("rate-limit identity of anonymous callers", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };

  beforeAll(async () => {
    model = await fakeModelServer(() => "ready");
    world = await testWorld(model.url, { RATE_LIMIT_MAX: String(MAX), TRUST_PROXY_HOPS: "1" });
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  /** Unknown paths are limited by the global bucket, keyed by caller address, and need no setup. */
  const hit = async (forwardedFor: string | undefined, n = 1): Promise<number[]> => {
    const codes: number[] = [];
    for (let i = 0; i < n; i++) {
      const res = await world.app.inject({
        method: "GET",
        url: `/api/v1/nowhere-${Math.random().toString(36).slice(2)}`,
        ...(forwardedFor ? { headers: { "x-forwarded-for": forwardedFor } } : {}),
      });
      codes.push(res.statusCode);
    }
    return codes;
  };

  it("gives two addresses behind the same proxy separate buckets", async () => {
    const a = await hit("198.51.100.10", MAX + 2);
    expect(a.at(-1)).toBe(429);
    // Another visitor, same web container, same socket peer: untouched.
    expect(await hit("198.51.100.11")).toEqual([404]);
  });

  it("does not let a caller choose its bucket by prepending addresses to the header", async () => {
    // The proxy appended the real address last. Whatever the client put before it is ignored, so
    // a flood that varies the leftmost entry still lands in one bucket and is stopped.
    const codes: number[] = [];
    for (let i = 0; i < MAX + 2; i++) codes.push(...(await hit(`10.0.0.${i}, 198.51.100.20`)));
    expect(codes.at(-1)).toBe(429);
    // And a victim the attacker names in the prefix is not harmed.
    expect(await hit("198.51.100.99")).toEqual([404]);
  });

  it("buckets IPv6 by /64, so rotating the interface identifier buys nothing", async () => {
    const codes: number[] = [];
    for (let i = 0; i < MAX + 2; i++) codes.push(...(await hit(`2001:db8:1:2:${i.toString(16)}::${i + 1}`)));
    expect(codes.at(-1)).toBe(429);
    // A different /64 is a different subscriber.
    expect(await hit("2001:db8:1:3::1")).toEqual([404]);
  });

  it("treats an IPv4-mapped IPv6 address and the IPv4 address as one client", async () => {
    await hit("203.0.113.5", MAX + 1);
    expect(await hit("::ffff:203.0.113.5")).toEqual([429]);
  });
});

suite("a deployment with no trusted proxy", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };

  beforeAll(async () => {
    model = await fakeModelServer(() => "ready");
    world = await testWorld(model.url, { RATE_LIMIT_MAX: String(MAX), TRUST_PROXY_HOPS: "0" });
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  it("ignores X-Forwarded-For entirely and uses the socket address", async () => {
    const codes: number[] = [];
    for (let i = 0; i < MAX + 2; i++) {
      const res = await world.app.inject({
        method: "GET",
        url: `/api/v1/nowhere-${i}`,
        headers: { "x-forwarded-for": `192.0.2.${i}` },
      });
      codes.push(res.statusCode);
    }
    expect(codes.at(-1)).toBe(429);
  });
});
