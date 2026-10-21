import { INTERNAL_AUTH_HEADER } from "@aidp/shared";
import { deriveInternalSecret } from "@aidp/shared/internal-secret";
import { apiBaseUrl } from "@/lib/env";

/**
 * The web server's half of the error log (D-477): a failure while a page rendered or a route
 * handler ran, as Next reports it to `onRequestError`, sent to the API's internal route with the
 * secret both processes share. Fire and forget: the request that failed has already been
 * answered, and a report that cannot be delivered is said once on the console and dropped.
 */

export interface RequestErrorInfo {
  path: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface RequestErrorContext {
  routePath?: string;
  routeType?: string;
}

const trim = (v: string, max: number): string => (v.length <= max ? v : `${v.slice(0, max - 1)}…`);

/** The report the API's `/internal/errors` accepts (WebErrorReportSchema in @aidp/shared). */
export function webErrorReport(
  err: unknown,
  request: RequestErrorInfo,
  context: RequestErrorContext,
  release: string | undefined,
): Record<string, string> {
  const e = err instanceof Error ? err : new Error(typeof err === "string" ? err : "Unknown error");
  const digest = (err as { digest?: unknown } | null)?.digest;
  const ua = request.headers["user-agent"];
  const out: Record<string, string> = {
    name: trim(e.name || "Error", 200),
    message: trim(e.message || "(no message)", 1000),
    path: trim(request.path, 2000),
    method: trim(request.method, 16),
  };
  if (e.stack) out.stack = trim(e.stack, 8000);
  if (context.routePath) out.routePath = trim(context.routePath, 300);
  if (context.routeType) out.routeType = trim(context.routeType, 40);
  if (typeof digest === "string") out.digest = trim(digest, 100);
  if (typeof ua === "string") out.userAgent = trim(ua, 500);
  if (release) out.release = trim(release, 100);
  return out;
}

let warned = false;

export async function reportServerError(
  err: unknown,
  request: RequestErrorInfo,
  context: RequestErrorContext,
  send: typeof fetch = fetch,
): Promise<void> {
  try {
    const res = await send(`${apiBaseUrl()}/internal/errors`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [INTERNAL_AUTH_HEADER]: deriveInternalSecret(process.env.AUTH_SECRET ?? ""),
      },
      body: JSON.stringify(webErrorReport(err, request, context, process.env.AIDP_VERSION)),
      cache: "no-store",
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    warned = false;
  } catch (e) {
    if (warned) return;
    warned = true;
    console.warn(
      JSON.stringify({
        event: "errorlog",
        message: "could not report a web server error to the API",
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  }
}
