import { z } from "zod";
import { t } from "@/i18n";

export const ApiErrorBodySchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});

/** An error returned by the API in its `{ error: { code, message } }` envelope, or a transport failure. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  get isUnauthenticated(): boolean {
    return this.status === 401;
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/** Builds an ApiError from a non-2xx response, tolerating non-JSON bodies. */
export async function apiErrorFromResponse(res: Response): Promise<ApiError> {
  const text = await res.text().catch(() => "");
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  const body = ApiErrorBodySchema.safeParse(parsed);
  if (body.success) {
    return new ApiError(res.status, body.data.error.code, body.data.error.message, body.data.error.details);
  }
  return new ApiError(res.status, codeForStatus(res.status), text || res.statusText || "Request failed");
}

export function codeForStatus(status: number): string {
  switch (status) {
    case 400:
      return "validation";
    case 401:
      return "unauthenticated";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 429:
      return "rate_limited";
    case 507:
      return "storage_full";
    default:
      return status >= 500 ? "server_error" : "request_failed";
  }
}

/** Human-safe message for any thrown value. */
export function errorMessage(e: unknown, fallback: string): string {
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

export type ErrorContext = "arrival" | "interview" | "summary" | "none";

/**
 * What a participant reads for a failed request: what happened, what to do, what was kept, in
 * that order. The API's own message is never shown: it is English, written for a log, and may
 * name things a participant should not see. The code decides the words.
 */
export function participantErrorFor(code: string, context: ErrorContext): string {
  const p = t.participant.errors;
  const parts = ((): { what: string; next: string } => {
    switch (code) {
      case "domain_not_allowed":
        return { what: t.participant.verify.domainNotAllowed, next: "" };
      case "network_error":
        return p.network;
      case "rate_limited":
        return p.rateLimited;
      case "forbidden":
      case "tenant_suspended":
        return p.forbidden;
      case "unauthenticated":
      case "not_found":
        return p.expired;
      case "too_large":
        return p.tooLarge;
      case "storage_full":
        return p.storageFull;
      case "conflict":
        return p.conflict;
      case "provider_error":
        return p.provider;
      case "budget_exceeded":
        return p.budget;
      case "limit_reached":
        return p.limit;
      case "feature_disabled":
        return p.featureOff;
      case "validation":
        return p.validation;
      default:
        return p.server;
    }
  })();
  return [parts.what, parts.next, p.kept[context]].filter((s) => s !== "").join(" ");
}

/** `participantErrorFor` for a thrown value: a transport failure is a `TypeError` from `fetch`. */
export function participantErrorText(e: unknown, context: ErrorContext): string {
  if (e instanceof ApiError) return participantErrorFor(e.code, context);
  return participantErrorFor(e instanceof TypeError ? "network_error" : "internal", context);
}
