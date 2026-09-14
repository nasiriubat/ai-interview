import { enterSystemTenant, enterTenant } from "@aidp/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { forbidden, unauthenticated } from "../lib/errors.js";
import { bearerFrom, type PrincipalResolver, type Principal, type Role } from "./principal.js";

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
  app.addHook("onRequest", async (request) => {
    // Resolving a bearer token has to look across tenants: which tenant it belongs to is the
    // answer, not the question. Everything after this point is pinned to one company.
    enterSystemTenant();
    request.principal = await opts.resolver.fromBearer(
      bearerFrom(request.headers.authorization, request.cookies),
    );
    const p = request.principal;
    const override = request.headers["x-company-id"];
    request.companyId =
      p.kind === "anonymous"
        ? ""
        : p.kind === "staff" && p.role === "platform_operator" && typeof override === "string"
          ? override
          : p.companyId;
    // A platform operator without a chosen tenant works across all of them by design; everyone
    // else is fenced in by Postgres itself from here on (packages/db/src/tenancy.ts).
    const operatorAcrossTenants =
      p.kind === "staff" && p.role === "platform_operator" && typeof override !== "string";
    if (!operatorAcrossTenants && request.companyId) enterTenant(request.companyId);
  });
});

export function requireStaff(...roles: Role[]) {
  return async (request: FastifyRequest): Promise<void> => {
    const p = request.principal;
    if (p.kind !== "staff") throw unauthenticated();
    if (roles.length && !roles.includes(p.role) && p.role !== "platform_operator") throw forbidden();
  };
}

export async function requireParticipant(request: FastifyRequest): Promise<void> {
  if (request.principal.kind !== "participant") throw unauthenticated("Participant token required");
}

export function staff(request: FastifyRequest): Extract<Principal, { kind: "staff" }> {
  if (request.principal.kind !== "staff") throw unauthenticated();
  return request.principal;
}

export function participant(request: FastifyRequest): Extract<Principal, { kind: "participant" }> {
  if (request.principal.kind !== "participant") throw unauthenticated("Participant token required");
  return request.principal;
}
