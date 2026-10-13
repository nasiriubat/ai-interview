import { isIPv6 } from "node:net";
import type { FastifyRequest } from "fastify";
import type { Config } from "../config.js";

/**
 * Rate limiting for every route, not only the public ones (spec 11).
 *
 * The limit is global and keyed by the principal, so one leaked admin token or one looping
 * client cannot hammer the model-calling endpoints or the database on everyone else's behalf.
 * Routes that spend money or provider quota per call carry a much tighter limit of their own;
 * health checks carry none at all, so a load balancer never trips it.
 *
 * Ceilings come from configuration (`RATE_LIMIT_*`), not the settings catalog: this runs in an
 * `onRequest` hook before a tenant is resolved, it has to hold for anonymous callers as well,
 * and reading the catalog would put a database query in front of every request.
 */

/** Every ceiling below is "per this window". */
export const RATE_LIMIT_WINDOW = "1 minute";

/**
 * One bucket per principal: a staff user, a participant session, or — for anyone the API has
 * not identified — the source address. Two principals behind one NAT therefore get a bucket
 * each, and one principal spread over several addresses still gets only one.
 *
 * The auth plugin resolves the principal in an instance-level `onRequest` hook, which Fastify
 * runs before the route-level hook this feeds, so the principal is always settled by now.
 */
export function principalKey(req: FastifyRequest): string {
  const p = req.principal;
  if (p.kind === "staff") return `staff:${p.userId}`;
  if (p.kind === "participant") return `participant:${p.sessionId}`;
  return `ip:${addressBucket(req.ip)}`;
}

/**
 * The rate-limit identity of a client address.
 *
 * IPv4 is the address. IPv6 is the /64: one subscriber is routinely handed a whole /64 and can
 * rotate through its 2^64 addresses at will, so bucketing by the full address would give every
 * such client an unlimited supply of fresh buckets. An IPv4-mapped IPv6 address (what a dual-stack
 * listener reports for an IPv4 client) is unwrapped first so the two spellings share a bucket.
 */
export function addressBucket(address: string): string {
  const ip = address.split("%")[0] ?? address;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped?.[1]) return mapped[1];
  if (!isIPv6(ip)) return ip;
  return `${expandIpv6(ip).slice(0, 4).join(":")}::/64`;
}

/** Eight lower-case 4-digit groups; handles "::" and a trailing dotted-quad. */
function expandIpv6(ip: string): string[] {
  let text = ip.toLowerCase();
  const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number) as [number, number, number, number];
    const hex = (hi: number, lo: number): string => ((hi << 8) | lo).toString(16);
    text = text.slice(0, tail.index) + hex(a, b) + ":" + hex(c, d);
  }
  const [head = "", rest] = text.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = rest === undefined || rest === "" ? [] : rest.split(":");
  const fill = rest === undefined ? [] : Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0");
  return [...left, ...fill, ...right].map((g) => g.padStart(4, "0"));
}

/** Route options for a path that calls a model or a provider on every request. */
export function expensiveLimit(config: Config): {
  config: { rateLimit: { max: number; timeWindow: string } };
} {
  return { config: { rateLimit: { max: config.RATE_LIMIT_EXPENSIVE_MAX, timeWindow: RATE_LIMIT_WINDOW } } };
}

/** Route options for the internal shared-secret routes, which get a bucket of their own. */
export function internalLimit(config: Config): {
  config: { rateLimit: { max: number; timeWindow: string } };
} {
  return { config: { rateLimit: { max: config.RATE_LIMIT_INTERNAL_MAX, timeWindow: RATE_LIMIT_WINDOW } } };
}

/** Route options for a path that must never be limited: liveness and readiness. */
export const noLimit: { config: { rateLimit: false } } = { config: { rateLimit: false } };
