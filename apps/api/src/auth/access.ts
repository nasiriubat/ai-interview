import type { FastifyInstance, FastifyRequest, onRequestAsyncHookHandler } from "fastify";
import { forbidden, tenantSuspended, unauthenticated } from "../lib/errors.js";
import type { Role } from "./principal.js";

/**
 * Who may call a route, declared on the route itself (security plan S2, spec 11).
 *
 * Every route states one of these in `config.access`. `buildApp` refuses to boot when a route
 * does not, so a new route fails closed instead of being silently public. The declaration is also
 * recorded in `app.routeTable`, which is what an authorization-matrix test is generated from.
 *
 * - `public`: no credential. Link open, email-code flow, health.
 * - `participant`: a participant session token.
 * - `staff`: any signed-in staff role (member, admin, operator).
 * - `admin`: admin, or the platform operator.
 * - `operator`: the platform operator only.
 * - `internal`: the web process, by the shared secret. No principal is consulted.
 */
export type Access = "public" | "participant" | "staff" | "admin" | "operator" | "internal";

export interface RouteEntry {
  method: string;
  url: string;
  access: Access;
}

declare module "fastify" {
  interface FastifyInstance {
    /** Every registered route and its declared access; what the authorization matrix is built from. */
    routeTable: RouteEntry[];
  }
  interface FastifyContextConfig {
    access?: Access;
    /** A staff route that must still answer for a suspended tenant (`GET /me`), so the UI can say why. */
    allowSuspended?: boolean;
  }
}

/** Marks a hook as an access guard so `buildApp` can keep it last in the `onRequest` chain. */
export const GUARD_MARK = Symbol.for("aidp.access-guard");

export interface RouteGuard {
  onRequest: onRequestAsyncHookHandler[];
  config: { access: Access; allowSuspended?: boolean } & Record<string, unknown>;
}

interface Extra {
  config?: Record<string, unknown>;
}

function build(access: Access, check: onRequestAsyncHookHandler, extra: Extra | undefined): RouteGuard {
  const fn = check as onRequestAsyncHookHandler & { [GUARD_MARK]?: true };
  fn[GUARD_MARK] = true;
  return { onRequest: [fn], config: { ...extra?.config, access } };
}

function staffCheck(roles: Role[]): onRequestAsyncHookHandler {
  return async (request: FastifyRequest): Promise<void> => {
    const p = request.principal;
    if (p.kind !== "staff") throw unauthenticated();
    if (p.suspended && !request.routeOptions.config.allowSuspended) throw tenantSuspended();
    if (roles.length && !roles.includes(p.role) && p.role !== "platform_operator") throw forbidden();
  };
}

const participantCheck: onRequestAsyncHookHandler = async (request) => {
  if (request.principal.kind !== "participant") throw unauthenticated("Participant token required");
};

/**
 * The guards. Each returns route options to spread into the route, and runs in `onRequest`, which
 * Fastify executes before the body is parsed or validated: an anonymous caller with a malformed
 * body gets a 401, not a schema error, and its body is never read.
 *
 * `extra.config` is merged into the route config (a rate-limit override, for example), because
 * two spreads of `config` would otherwise replace each other.
 */
export const guard = {
  public: (extra?: Extra): { config: RouteGuard["config"] } => ({
    config: { ...extra?.config, access: "public" },
  }),
  participant: (extra?: Extra): RouteGuard => build("participant", participantCheck, extra),
  /**
   * A participant WebSocket. There is no hook: a refused upgrade has to be closed with a status
   * code by the handler, which a thrown error cannot do once the connection is being upgraded.
   * The handler must check `request.principal.kind` itself; the declaration is still recorded.
   */
  participantSocket: (extra?: Extra): { config: RouteGuard["config"] } => ({
    config: { ...extra?.config, access: "participant" },
  }),
  staff: (extra?: Extra): RouteGuard => build("staff", staffCheck([]), extra),
  admin: (extra?: Extra): RouteGuard => build("admin", staffCheck(["admin"]), extra),
  operator: (extra?: Extra): RouteGuard => build("operator", staffCheck(["platform_operator"]), extra),
  /** `verify` throws to refuse. It sees the raw request; no principal is involved. */
  internal: (verify: (request: FastifyRequest) => void, extra?: Extra): RouteGuard =>
    build(
      "internal",
      async (request) => {
        verify(request);
      },
      extra,
    ),
};

/** Merges more route config (rate limits) into an existing guard without losing its access. */
export function withConfig<G extends RouteGuard | { config: Record<string, unknown> }>(
  base: G,
  extra: { config: Record<string, unknown> },
): G {
  return { ...base, config: { ...base.config, ...extra.config } };
}

/**
 * Fails closed: a route registered without an access declaration stops the app from booting, and
 * the guard is kept last in the `onRequest` chain so the rate limiter, which appends its own
 * hook, runs first and a flood of unauthenticated requests is throttled before it is answered.
 *
 * Install this before any route is registered, and after the rate-limit plugin.
 */
export function installAccessGuard(app: FastifyInstance): void {
  const table: RouteEntry[] = [];
  app.decorate("routeTable", table);
  app.addHook("onRoute", (route) => {
    const access = route.config?.access;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    if (!access) {
      throw new Error(
        `Route ${methods.join(",")} ${route.url} declares no access. Spread a guard from auth/access.ts ` +
          "(guard.public, guard.participant, guard.staff, guard.admin, guard.operator) into its options.",
      );
    }
    const existing = route.onRequest;
    if (existing) {
      const hooks = Array.isArray(existing) ? [...existing] : [existing];
      const isGuard = (h: unknown): boolean => (h as { [GUARD_MARK]?: boolean })[GUARD_MARK] === true;
      route.onRequest = [...hooks.filter((h) => !isGuard(h)), ...hooks.filter(isGuard)];
    }
    for (const method of methods) table.push({ method, url: route.url, access });
  });
}
