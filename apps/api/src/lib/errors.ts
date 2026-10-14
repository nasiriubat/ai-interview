import { BudgetExceededError, ProviderError } from "@aidp/ai";
import { CeilingReachedError, SettingsError, StorageFull } from "@aidp/core";
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from "fastify-type-provider-zod";

export type ErrorCode =
  | "validation"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "tenant_suspended"
  | "blocked_address"
  | "too_large"
  | "rate_limited"
  | "budget_exceeded"
  /** A switch the tenant, the template or the platform turned off (`features.*`, `voice.enabled`). */
  | "feature_disabled"
  /** A tenant ceiling is used up: `details` is `{ limit, current, max }` (D-188). */
  | "limit_reached"
  | "provider_error"
  /** An API key the provider itself refused when it was checked (D-77). */
  | "invalid_api_key"
  /** Live voice cannot be turned on: `details.missing` names the purposes without a working route (D-77). */
  | "voice_not_ready"
  /** The server has no room to keep an upload; nothing the sender did, and the answers so far are kept (D-283). */
  | "storage_full"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  validation: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  // The organization is suspended: staff are told why instead of being shown a sign-in loop (S8).
  tenant_suspended: 403,
  // A provider or relay address that resolves somewhere the server must not connect (S4).
  blocked_address: 422,
  // An upload over the tenant's files.maxSizeMb, or over the hard ceiling above it.
  too_large: 413,
  rate_limited: 429,
  budget_exceeded: 402,
  feature_disabled: 403,
  limit_reached: 403,
  provider_error: 502,
  invalid_api_key: 422,
  voice_not_ready: 409,
  // 507 Insufficient Storage: the request is fine, the server cannot hold it right now.
  storage_full: 507,
  internal: 500,
};

export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
    this.status = STATUS[code];
  }
}

/** The refusal for an upload the server has no room for; the web app words it from the code, in the participant's language. */
export const storageFull = (): AppError =>
  new AppError("storage_full", "The service cannot store files right now. Your answers so far are kept.");
export const notFound = (what: string): AppError => new AppError("not_found", `${what} not found`);
export const forbidden = (message = "Forbidden"): AppError => new AppError("forbidden", message);
export const tenantSuspended = (): AppError =>
  new AppError("tenant_suspended", "This organization is suspended. Contact the platform operator.");
export const unauthenticated = (message = "Authentication required"): AppError =>
  new AppError("unauthenticated", message);

/** A Prisma unique-constraint violation (P2002), however the client wrapped it. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

/**
 * What a staff address that is already taken answers.
 *
 * One tenant per email (D-84) makes this a small cross-tenant existence oracle: an admin can learn
 * that an address is registered somewhere. It is accepted, because the alternative is silently
 * resolving a second identity, and bounded: the routes that can produce it are limited to 20 a
 * hour per admin and every refusal is audited.
 */
export const emailTaken = (): AppError =>
  new AppError("conflict", "That email address is already registered");

/** One shape for every error the API returns (contract 16). Never leaks internals in production. */
export function errorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const respond = (status: number, code: string, message: string, details?: unknown): void => {
    void reply
      .status(status)
      .send({ error: { code, message, ...(details !== undefined ? { details } : {}) } });
  };
  if (error instanceof AppError) {
    respond(error.status, error.code, error.message, error.details);
    return;
  }
  if (hasZodFastifySchemaValidationErrors(error)) {
    respond(
      400,
      "validation",
      "Request validation failed",
      error.validation.map((v) => ({ path: v.instancePath, message: v.message })),
    );
    return;
  }
  if (isResponseSerializationError(error)) {
    request.log.error({ err: error }, "response serialization failed");
    respond(500, "internal", "Response did not match its schema");
    return;
  }
  if (error instanceof BudgetExceededError) {
    respond(402, "budget_exceeded", error.message);
    return;
  }
  if (error instanceof ProviderError) {
    request.log.warn({ err: error, code: error.code }, "provider error");
    respond(
      502,
      "provider_error",
      error.code === "refusal" ? "The model declined this request" : "The model provider failed",
    );
    return;
  }
  if (error instanceof StorageFull) {
    // Something else already tells the operator (`disk.high`); this is only the participant's side.
    request.log.error({ err: error }, "object store full");
    respond(507, "storage_full", storageFull().message);
    return;
  }
  if (error instanceof CeilingReachedError) {
    respond(403, "limit_reached", error.message, {
      limit: error.metric,
      current: error.current,
      max: error.max,
    });
    return;
  }
  if (error instanceof SettingsError) {
    respond(400, "validation", error.message);
    return;
  }
  const fastify = error as FastifyError;
  if (fastify.statusCode === 429) {
    respond(429, "rate_limited", "Too many requests");
    return;
  }
  if (typeof fastify.statusCode === "number" && fastify.statusCode < 500) {
    respond(fastify.statusCode, "validation", error.message);
    return;
  }
  request.log.error({ err: error }, "unhandled error");
  respond(500, "internal", "Internal error");
}
