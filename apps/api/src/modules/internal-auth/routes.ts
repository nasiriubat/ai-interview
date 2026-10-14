import {
  INTERNAL_AUTH_HEADER,
  VerificationTokenCreateSchema,
  VerificationTokenLookupSchema,
  VerificationTokenPruneSchema,
  VerificationTokenResponseSchema,
} from "@aidp/shared";
import { deriveInternalSecret } from "@aidp/shared/internal-secret";
import type { FastifyRequest } from "fastify";
import type { App } from "../../app.js";
import { guard } from "../../auth/access.js";
import type { RouteContext } from "../../context.js";
import { notFound, unauthenticated } from "../../lib/errors.js";
import { internalLimit } from "../../lib/rate-limit.js";
import { secretMatches } from "./service.js";

/**
 * Machine-to-machine routes for Auth.js magic-link sign-in (D-56). Not staff routes: a session,
 * of any role, gets nothing here. The only credential is the `AUTH_SECRET` both processes
 * already share, presented in `x-internal-auth` and compared in constant time. What travels is an
 * HKDF derivation of it (D-260), never `AUTH_SECRET` itself.
 *
 * They are hidden from the OpenAPI document because they are not part of the public contract and
 * the web app generates its client from it.
 */
export async function internalAuthRoutes(app: App, ctx: RouteContext): Promise<void> {
  const svc = ctx.services.verificationTokens;
  const base = "/internal/auth/verification-tokens";

  /** The whole of the authorization: no principal is consulted, so no session can stand in. */
  const internalSecret = deriveInternalSecret(ctx.config.AUTH_SECRET);
  const requireInternalSecret = (req: FastifyRequest): void => {
    const header = req.headers[INTERNAL_AUTH_HEADER];
    const presented = typeof header === "string" ? header : undefined;
    if (!secretMatches(presented, internalSecret)) {
      throw unauthenticated("Internal secret required");
    }
  };
  const guarded = guard.internal(requireInternalSecret, internalLimit(ctx.config));

  app.post(
    base,
    {
      ...guarded,
      schema: {
        hide: true,
        body: VerificationTokenCreateSchema,
        response: { 201: VerificationTokenResponseSchema },
      },
    },
    async (req, reply) => reply.status(201).send({ token: await svc.create(req.body) }),
  );

  app.post(
    `${base}/consume`,
    {
      ...guarded,
      schema: {
        hide: true,
        body: VerificationTokenLookupSchema,
        response: { 200: VerificationTokenResponseSchema },
      },
    },
    async (req) => {
      const token = await svc.consume(req.body);
      // A token already used, never issued, or issued for another address is all one answer, and
      // the message names nothing: the token itself is never echoed back or logged.
      if (!token) throw notFound("Verification token");
      return { token };
    },
  );

  app.post(
    `${base}/prune`,
    { ...guarded, schema: { hide: true, response: { 200: VerificationTokenPruneSchema } } },
    async () => ({ deleted: await svc.prune() }),
  );
}
