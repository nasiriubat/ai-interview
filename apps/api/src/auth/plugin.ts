import { SYSTEM_TENANT, withSystemTenant, withTenant } from "@aidp/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { unauthenticated } from "../lib/errors.js";
import { bearerFrom, type PrincipalResolver, type Principal } from "./principal.js";

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal;
    /** Tenant the request acts on: the principal's company, or X-Company-Id for platform operators. */
    companyId: string;
  }
}

export const authPlugin = fp(async (app: FastifyInstance, opts: { resolver: PrincipalResolver }) => {
  app.decorateRequest<Principal | null>("principal", null);
  app.decorateRequest("companyId", "");

  /**
   * Resolves who is calling and which tenant the rest of the request is fenced into.
   *
   * Resolving a bearer token has to look across tenants (which tenant it belongs to is the answer,
   * not the question), so it runs in the system context. The result is the tenant context the guards
   * and the handler then run in: the principal's company, or system for an anonymous caller (the
   * public participant routes look a campaign up by its link before any tenant is known) and for a
   * platform operator working across tenants.
   *
   * An operator is across tenants on every `/operator/*` route even when it also sent
   * `X-Company-Id`: those routes are platform-wide by definition, and pinning them to one tenant
   * hid every other tenant and refused writes to platform rows (D-141).
   */
  const resolve = async (request: FastifyRequest): Promise<string> => {
    request.principal = await withSystemTenant(() =>
      opts.resolver.fromBearer(bearerFrom(request.headers.authorization, request.cookies)),
    );
    const p = request.principal;
    const override = request.headers["x-company-id"];
    request.companyId =
      p.kind === "anonymous"
        ? ""
        : p.kind === "staff" && p.role === "platform_operator" && typeof override === "string"
          ? override
          : p.companyId;
    const operator = p.kind === "staff" && p.role === "platform_operator";
    const operatorRoute = request.routeOptions.config.access === "operator";
    const acrossTenants = operator && (typeof override !== "string" || operatorRoute);
    return acrossTenants || !request.companyId ? SYSTEM_TENANT : request.companyId;
  };

  // Callback style, on purpose. The tenant lives in AsyncLocalStorage, and a context only reaches
  // the guards and the handler if `done` is called inside the `run` that establishes it. Setting it
  // with `enterWith` from an async hook (what this did before) changes the context of that hook's
  // continuation only: the handler kept the system context, so every API query ran with the policies
  // stood down and the second fence held only for jobs. A test now fails on that (D-140).
  app.addHook("onRequest", (request, _reply, done) => {
    resolve(request).then(
      (tenant) => {
        const run =
          tenant === SYSTEM_TENANT ? withSystemTenant : (fn: () => Promise<void>) => withTenant(tenant, fn);
        void run(async () => {
          done();
        });
      },
      (err: unknown) => {
        done(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
});

export function staff(request: FastifyRequest): Extract<Principal, { kind: "staff" }> {
  if (request.principal.kind !== "staff") throw unauthenticated();
  return request.principal;
}

export function participant(request: FastifyRequest): Extract<Principal, { kind: "participant" }> {
  if (request.principal.kind !== "participant") throw unauthenticated("Participant token required");
  return request.principal;
}
