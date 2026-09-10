import { z } from "zod";

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
    default:
      return status >= 500 ? "server_error" : "request_failed";
  }
}

/** Human-safe message for any thrown value. */
export function errorMessage(e: unknown, fallback: string): string {
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}
