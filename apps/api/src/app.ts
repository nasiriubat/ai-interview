import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from "fastify";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { authPlugin } from "./auth/plugin.js";
import { PrincipalResolver } from "./auth/principal.js";
import type { AppContext } from "./context.js";
import { errorHandler } from "./lib/errors.js";
import { analysisRoutes } from "./modules/analysis/routes.js";
import { auditRoutes } from "./modules/audit/routes.js";
import { campaignRoutes } from "./modules/campaigns/routes.js";
import { healthRoutes } from "./modules/health/routes.js";
import { operatorRoutes } from "./modules/operator/routes.js";
import { participantRoutes } from "./modules/participant/routes.js";
import { providerRoutes } from "./modules/providers/routes.js";
import { requirementsRoutes } from "./modules/requirements/routes.js";
import { sessionRoutes } from "./modules/sessions/routes.js";
import { settingsRoutes } from "./modules/settings/routes.js";
import { statsRoutes } from "./modules/stats/routes.js";
import { templateRoutes } from "./modules/templates/routes.js";
import { userRoutes } from "./modules/users/routes.js";

export type App = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export const API_PREFIX = "/api/v1";

/** Builds the HTTP app from a context. No I/O at build time, so tests construct it freely. */
export async function buildApp(ctx: AppContext): Promise<App> {
  const app = Fastify({
    loggerInstance: ctx.log,
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);
  // The first turn of an interview carries no body (contracts 16 and 18). A client that still
  // sends `content-type: application/json` must not be rejected, so an empty body parses as {}.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const raw = typeof body === "string" ? body.trim() : "";
    if (raw === "") {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(raw));
    } catch (err) {
      done(err as Error, undefined);
    }
  });
  app.setNotFoundHandler(
    (_req, reply) =>
      void reply.status(404).send({ error: { code: "not_found", message: "Route not found" } }),
  );

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: ctx.config.WEB_ORIGIN,
    credentials: true,
    exposedHeaders: ["x-request-id"],
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(swagger, {
    openapi: {
      info: { title: "AI Discovery Platform API", version: "1.0.0" },
      servers: [{ url: API_PREFIX }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(authPlugin, {
    resolver: new PrincipalResolver(ctx.db, ctx.crypto, ctx.config.AUTH_SECRET),
  });

  await app.register(
    async (api) => {
      const a = api as unknown as App;
      await healthRoutes(a, ctx);
      await userRoutes(a, ctx);
      await templateRoutes(a, ctx);
      await settingsRoutes(a, ctx);
      await campaignRoutes(a, ctx);
      await participantRoutes(a, ctx);
      await sessionRoutes(a, ctx);
      await providerRoutes(a, ctx);
      await statsRoutes(a, ctx);
      await auditRoutes(a, ctx);
      await analysisRoutes(a, ctx);
      await requirementsRoutes(a, ctx);
      await operatorRoutes(a, ctx);
      a.get("/openapi.json", async () => a.swagger());
    },
    { prefix: API_PREFIX },
  );
  return app as unknown as App;
}
