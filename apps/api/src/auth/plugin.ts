import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { forbidden, unauthenticated } from "../lib/errors.js";
import { bearerFrom, PrincipalResolver, type Principal, type Role } from "./principal.js";

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
