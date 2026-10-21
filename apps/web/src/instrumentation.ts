import type { Instrumentation } from "next";

/**
 * Next calls this for every error thrown while the server renders a page or runs a route handler
 * (D-477). It is forwarded to the API's error log; the reporter is imported only on the Node
 * runtime, because it reads the shared secret and the edge runtime has neither.
 */
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { reportServerError } = await import("./lib/errors/server-report");
    await reportServerError(err, request, context);
  } catch {
    // Reporting a failure must never become one.
  }
};
