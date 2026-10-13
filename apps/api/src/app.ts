import { PLATFORM_MAX_UPLOAD_MB } from "@aidp/shared";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import websocket from "@fastify/websocket";
import Fastify, {
  type FastifyBaseLogger,
  type preHandlerAsyncHookHandler,
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
import { guard, installAccessGuard } from "./auth/access.js";
import { authPlugin } from "./auth/plugin.js";
import { PrincipalResolver } from "./auth/principal.js";
import type { AppContext, RouteContext } from "./context.js";
import { errorHandler } from "./lib/errors.js";
import { principalKey, RATE_LIMIT_WINDOW } from "./lib/rate-limit.js";
import { analysisRoutes } from "./modules/analysis/routes.js";
import { auditRoutes } from "./modules/audit/routes.js";
import { campaignRoutes } from "./modules/campaigns/routes.js";
import { healthRoutes } from "./modules/health/routes.js";
import { internalAuthRoutes } from "./modules/internal-auth/routes.js";
import { operatorRoutes } from "./modules/operator/routes.js";
import { participantAttachmentRoutes } from "./modules/participant/attachments.js";
import { participantRoutes } from "./modules/participant/routes.js";
import { participantVoiceLiveRoutes } from "./modules/participant/voice-live/routes.js";
import { participantVoiceRoutes } from "./modules/participant/voice.js";
import { privacyRoutes } from "./modules/privacy/routes.js";
import { providerRoutes } from "./modules/providers/routes.js";
import { requirementsRoutes } from "./modules/requirements/routes.js";
import { sessionRoutes } from "./modules/sessions/routes.js";
import { settingsRoutes } from "./modules/settings/routes.js";
import { statsRoutes } from "./modules/stats/routes.js";
import { templateRoutes } from "./modules/templates/routes.js";
import { userRoutes } from "./modules/users/routes.js";
import { voiceAdminRoutes } from "./modules/voice/routes.js";

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
    // A hop count, never `true`: with `true` the leftmost X-Forwarded-For entry is believed, and
    // any client could choose its own rate-limit bucket by sending one (S1, D-82).
    // Written as a function because Fastify's typings omit the numeric form; it is the numeric
    // form exactly (hop 0 is the socket peer, so `hop < N` trusts N proxies).
    trustProxy: (_address: string, hop: number): boolean => hop < ctx.config.TRUST_PROXY_HOPS,
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
  // A request with no body and no content type arrives with `body === null`, and zod's
  // `.default({})` fills in `undefined` only, so every route whose body is all-optional refused a
  // bare POST with 400. The admin's "Preview" button was one of them. The parser above covers an
  // empty body sent *with* a JSON content type; this covers the one sent without. Routes that
  // require fields still reject `{}`, with a message naming the field instead of "received null".
  app.addHook("preValidation", async (request) => {
    if (request.body == null && ["POST", "PUT", "PATCH"].includes(request.method)) request.body = {};
  });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: ctx.config.WEB_ORIGIN,
    credentials: true,
    exposedHeaders: ["x-request-id"],
  });
  await app.register(cookie);
  // Uploads (FR-30, FR-31). The per-route limit is the real one (the tenant's files.maxSizeMb,
  // resolved before the body is read); this ceiling is the platform maximum, so no handler can
  // be made to hold more than that whatever the tenant has configured.
  await app.register(multipart, {
    limits: { fileSize: PLATFORM_MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 8, parts: 12 },
  });
  // Live voice (FR-30a). The only upgraded connection the API serves; see voice-live.ts for why
  // it is reached directly rather than through the web app's proxy.
  await app.register(websocket, {
    options: { maxPayload: 1024 * 1024, clientTracking: false },
  });
  // The auth plugin first, so the limiter below can key on the principal it resolves. Its hook is
  // instance-level and the limiter's is route-level, which settles the order regardless, but the
  // dependency is real and reads better stated.
  await app.register(authPlugin, {
    resolver: new PrincipalResolver(ctx.db, ctx.crypto, ctx.config.AUTH_SECRET, ctx.tenants),
  });
  // Global by default (spec 11): before this, only the participant routes opted in and every
  // staff and operator route was unlimited, so one leaked admin token could hammer the
  // model-calling endpoints and the database. Routes that spend money per call narrow it further
  // with `expensiveLimit`; health checks opt out entirely with `noLimit`. `enableDraftSpec` emits
  // the standard `RateLimit-*` headers, and exceeding the limit throws a 429 that the error
  // handler renders as the contract's `rate_limited` shape.
  await app.register(rateLimit, {
    global: true,
    max: ctx.config.RATE_LIMIT_MAX,
    timeWindow: RATE_LIMIT_WINDOW,
    enableDraftSpec: true,
    keyGenerator: principalKey,
  });
  // After the limiter, so the guard is ordered behind its hook; before every route, so none escapes.
  installAccessGuard(app as unknown as FastifyInstance);
  // A path with no route has no route-level hook, so the 404 handler carries the limiter itself:
  // otherwise scanning for endpoints that do not exist is the one thing left without a ceiling.
  // The cast only drops the plugin's pino-specific `Logger` generic for Fastify's own
  // `FastifyBaseLogger`; the handler it returns is unchanged.
  const limitUnknownRoutes = app.rateLimit() as preHandlerAsyncHookHandler;
  app.setNotFoundHandler(
    { preHandler: limitUnknownRoutes },
    (_req, reply) =>
      void reply.status(404).send({ error: { code: "not_found", message: "Route not found" } }),
  );
  await app.register(swagger, {
    openapi: {
      info: { title: "AI Discovery Platform API", version: "1.0.0" },
      servers: [{ url: API_PREFIX }],
    },
    transform: jsonSchemaTransform,
  });

  // Route files get the context without its database client, at runtime as well as in the type
  // (AGENTS.md rule 4): reaching a table from a route is not possible, only a service method is.
  const { db: _db, ...withoutDb } = ctx;
  const routes: RouteContext = withoutDb;
  await app.register(
    async (api) => {
      const a = api as unknown as App;
      await healthRoutes(a, routes);
      await internalAuthRoutes(a, routes);
      await userRoutes(a, routes);
      await templateRoutes(a, routes);
      await settingsRoutes(a, routes);
      await campaignRoutes(a, routes);
      await participantRoutes(a, routes);
      await participantAttachmentRoutes(a, routes);
      await participantVoiceRoutes(a, routes);
      await participantVoiceLiveRoutes(a, routes);
      await sessionRoutes(a, routes);
      await providerRoutes(a, routes);
      await voiceAdminRoutes(a, routes);
      await statsRoutes(a, routes);
      await auditRoutes(a, routes);
      await privacyRoutes(a, routes);
      await analysisRoutes(a, routes);
      await requirementsRoutes(a, routes);
      await operatorRoutes(a, routes);
      a.get("/openapi.json", { ...guard.public() }, async () => a.swagger());
    },
    { prefix: API_PREFIX },
  );
  return app as unknown as App;
}
