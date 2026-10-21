import { z } from "zod";

/**
 * The built-in error log's wire contracts (D-477): what a browser and the web server send to the
 * API, and the vocabulary the operator's pages read. The API redacts, truncates and fingerprints
 * every report itself (packages/core/src/errorlog); these schemas only bound what may arrive.
 */

/** Where a failure happened. */
export const ERROR_SOURCES = ["api", "worker", "web", "browser"] as const;
export type ErrorSource = (typeof ERROR_SOURCES)[number];

/** `warning` is a failure something recovers from: a retried job, a provider's 502. */
export const ERROR_SEVERITIES = ["error", "warning"] as const;
export type ErrorSeverity = (typeof ERROR_SEVERITIES)[number];

/** The largest browser report the web proxy and the API accept, in bytes. */
export const ERROR_REPORT_MAX_BYTES = 8 * 1024;

/** What is kept of a message and of a stack; the client trims to these before sending. */
export const ERROR_MESSAGE_MAX = 1000;
export const ERROR_STACK_MAX = 8 * 1024;

const text = (max: number) => z.string().max(max);

/**
 * A failure in someone's browser: an uncaught error, an unhandled rejection, or a React error
 * boundary. `path` is the page's pathname and query as the browser saw it; the API removes the
 * tokens in it before anything is stored.
 */
export const BrowserErrorReportSchema = z.object({
  kind: z.enum(["error", "unhandledrejection", "boundary"]),
  name: text(200).optional(),
  message: text(ERROR_MESSAGE_MAX),
  stack: text(ERROR_STACK_MAX).optional(),
  path: text(2000),
  /** Next.js's server-side reference for a boundary error, when there is one. */
  digest: text(100).optional(),
});
export type BrowserErrorReport = z.infer<typeof BrowserErrorReportSchema>;

/** A failure while the web server rendered a page or ran a route handler (`onRequestError`). */
export const WebErrorReportSchema = z.object({
  name: text(200).optional(),
  message: text(ERROR_MESSAGE_MAX),
  stack: text(ERROR_STACK_MAX).optional(),
  path: text(2000),
  method: text(16).optional(),
  /** The route's pattern (`/admin/campaigns/[id]`), from Next's request context. */
  routePath: text(300).optional(),
  routeType: text(40).optional(),
  digest: text(100).optional(),
  userAgent: text(500).optional(),
  release: text(100).optional(),
});
export type WebErrorReport = z.infer<typeof WebErrorReportSchema>;

/** The periods the operator's list filters on. */
export const ERROR_PERIODS = ["24h", "7d", "all"] as const;
export type ErrorPeriod = (typeof ERROR_PERIODS)[number];

export const ERROR_STATUSES = ["open", "resolved", "all"] as const;
export type ErrorStatusFilter = (typeof ERROR_STATUSES)[number];
