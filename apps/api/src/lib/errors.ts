import { BudgetExceededError, ProviderError } from "@aidp/ai";
import { SettingsError } from "@aidp/core";
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from "fastify-type-provider-zod";

export type ErrorCode =
  | "validation"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "too_large"
  | "rate_limited"
  | "budget_exceeded"
  | "provider_error"
  /** An API key the provider itself refused when it was checked (D-77). */
  | "invalid_api_key"
  /** Live voice cannot be turned on: `details.missing` names the purposes without a working route (D-77). */
  | "voice_not_ready"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  validation: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  // An upload over the tenant's files.maxSizeMb, or over the hard ceiling above it.
  too_large: 413,
  rate_limited: 429,
  budget_exceeded: 402,
  provider_error: 502,
  invalid_api_key: 422,
  voice_not_ready: 409,
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

export const notFound = (what: string): AppError => new AppError("not_found", `${what} not found`);
export const forbidden = (message = "Forbidden"): AppError => new AppError("forbidden", message);
export const unauthenticated = (message = "Authentication required"): AppError =>
  new AppError("unauthenticated", message);

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
