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
  return `ip:${req.ip}`;
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
