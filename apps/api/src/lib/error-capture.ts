import { describeThrown, type ErrorEvent, type ErrorLogPort } from "@aidp/core";
import type { FastifyInstance, FastifyRequest } from "fastify";

/**
 * The API's half of the error log (D-477): every response with a 5xx status is recorded, with
 * the error that caused it when there was one, and nothing else is. A validation error, a refused
 * credential, a rate limit or a missing record is the API working, not failing, so the 4xx answers
 * never reach the log.
 *
 * The capture is an `onResponse` hook, after the reply has gone out, and `capture` only queues:
 * the request that failed is neither slowed nor changed by being recorded.
 */

const thrown = new WeakMap<FastifyRequest, unknown>();

/** Called by the error handler, so the response hook can say what was thrown and not only the status. */
export function rememberError(request: FastifyRequest, error: unknown): void {
  thrown.set(request, error);
}

/** The ids a request may carry into the log: a tenant, a staff user or an interview, never an address. */
function who(request: FastifyRequest): Pick<ErrorEvent, "companyId" | "userId" | "sessionId"> {
  const p = request.principal as FastifyRequest["principal"] | null;
  return {
    ...(request.companyId ? { companyId: request.companyId } : {}),
    ...(p?.kind === "staff" ? { userId: p.userId } : {}),
    ...(p?.kind === "participant" ? { sessionId: p.sessionId } : {}),
  };
}

/** What a 5xx response becomes in the log. Exported for the unit test. */
export function responseFailureEvent(
  request: FastifyRequest,
  status: number,
  release: string | undefined,
): ErrorEvent {
  const error = thrown.get(request);
  const described =
    error === undefined ? { name: "HttpError", message: `HTTP ${status}` } : describeThrown(error);
  const ua = request.headers["user-agent"];
  return {
    source: "api",
    // A 500 is a fault in the API; a 502, 503 or 507 is something it depends on being down.
    severity: status === 500 ? "error" : "warning",
    ...described,
    route: request.routeOptions.url ?? "unmatched",
    path: request.url,
    method: request.method,
    status,
    requestId: request.id,
    ...who(request),
    ...(release ? { release } : {}),
    ...(typeof ua === "string" ? { userAgent: ua } : {}),
  };
}

export function installErrorCapture(
  app: FastifyInstance,
  errors: ErrorLogPort,
  release: string | undefined,
): void {
  app.addHook("onResponse", (request, reply, done) => {
    try {
      if (reply.statusCode >= 500) errors.capture(responseFailureEvent(request, reply.statusCode, release));
    } catch {
      // Recording a failure must never become one.
    }
    done();
  });
}
