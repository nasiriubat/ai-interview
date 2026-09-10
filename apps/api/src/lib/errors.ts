import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from "fastify-type-provider-zod";
import { BudgetExceededError, ProviderError } from "@aidp/ai";
import { SettingsError } from "@aidp/core";

export type ErrorCode =
  | "validation"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "budget_exceeded"
  | "provider_error"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  validation: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  budget_exceeded: 402,
  provider_error: 502,
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
  if (error instanceof AppError) return respond(error.status, error.code, error.message, error.details);
  if (hasZodFastifySchemaValidationErrors(error)) {
    return respond(
      400,
      "validation",
      "Request validation failed",
      error.validation.map((v) => ({ path: v.instancePath, message: v.message })),
    );
  }
  if (isResponseSerializationError(error)) {
    request.log.error({ err: error }, "response serialization failed");
    return respond(500, "internal", "Response did not match its schema");
  }
  if (error instanceof BudgetExceededError) return respond(402, "budget_exceeded", error.message);
  if (error instanceof ProviderError) {
    request.log.warn({ err: error, code: error.code }, "provider error");
    return respond(
      502,
      "provider_error",
      error.code === "refusal" ? "The model declined this request" : "The model provider failed",
    );
  }
  if (error instanceof SettingsError) return respond(400, "validation", error.message);
  const fastify = error as FastifyError;
  if (fastify.statusCode === 429) return respond(429, "rate_limited", "Too many requests");
  if (typeof fastify.statusCode === "number" && fastify.statusCode < 500)
    return respond(fastify.statusCode, "validation", error.message);
  request.log.error({ err: error }, "unhandled error");
  respond(500, "internal", "Internal error");
}
