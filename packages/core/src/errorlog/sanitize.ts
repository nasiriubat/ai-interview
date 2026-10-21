import { createHash } from "node:crypto";
import { ERROR_MESSAGE_MAX, ERROR_STACK_MAX, type ErrorSeverity } from "@aidp/shared";
import { redactPath, scrubLogText } from "../telemetry/redaction.js";
import type { ErrorEvent, ErrorRecord } from "./types.js";

/**
 * Redaction, truncation and fingerprinting for the error log (D-477).
 *
 * The path rules are the Caddy access-log filter's (deploy/Caddyfile, D-223): participant link
 * and invitation tokens in the path become `<token>`, and the values of `token`, `code`, `email`
 * and `callbackUrl` in the query become `REDACTED`. Message and stack go through the same scrub
 * as every log line (bearer tokens, token-like query values, link tokens, addresses).
 */

export const ERROR_NAME_MAX = 120;
export const ERROR_PATH_MAX = 500;
export const ERROR_ROUTE_MAX = 300;
export const ERROR_UA_MAX = 300;

/** The Caddyfile's query rule: these values are credentials or identify a person. */
const SECRET_QUERY = /([?&](?:token|code|email|callbackUrl)=)[^&#]*/gi;
/** The Caddyfile's path rule, for a token that `redactPath` would not see (a path inside a message). */
const LINK_TOKEN = /(\/p\/(?:r\/)?)[A-Za-z0-9_-]{16,}/g;

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** A URL or path as it may be stored: origin and fragment dropped, tokens and secret values hidden. */
export function redactErrorPath(raw: string): string {
  let value = raw.slice(0, ERROR_PATH_MAX * 4).trim();
  // A full URL keeps only its path and query: the host is ours, and a fragment is never sent.
  const origin = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(value);
  if (origin) value = value.slice(origin[0].length) || "/";
  const hash = value.indexOf("#");
  if (hash !== -1) value = value.slice(0, hash);
  const q = value.indexOf("?");
  const path = q === -1 ? value : value.slice(0, q);
  const query = q === -1 ? "" : value.slice(q);
  // The log scrub first, then the Caddy rules, so a value both hide reads as the Caddy log does.
  const cleaned = scrubLogText(redactPath(path) + query)
    .replace(LINK_TOKEN, "$1<token>")
    .replace(SECRET_QUERY, "$1REDACTED");
  return truncate(cleaned, ERROR_PATH_MAX);
}

/**
 * A random credential standing on its own ("link Lk7Qx2… failed"): twenty or more URL-safe
 * characters mixing upper case, lower case and digits, which is what the platform's tokens look
 * like (base64url) and what its ids (cuid, lower case; uuid, hex with hyphens) do not.
 */
const BARE_TOKEN =
  /\b(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}\b/g;

/** Free text (a message, a stack) with tokens, secret query values and addresses hidden. */
export function redactErrorText(text: string, max: number): string {
  // Cut before scrubbing, with a margin for what the scrub shortens: the patterns are linear on
  // ordinary text but not on a pathological run, and this runs on the request's own tick.
  return truncate(
    scrubLogText(text.slice(0, max + 256))
      .replace(LINK_TOKEN, "$1<token>")
      .replace(SECRET_QUERY, "$1REDACTED")
      .replace(BARE_TOKEN, "<token>"),
    max,
  );
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const CUID = /\bc[a-z0-9]{20,30}\b/g;
const HEX = /\b[0-9a-f]{8,}\b/gi;
const LONG_TOKEN = /\b(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{24,}\b/g;
const NUMBER = /\d+(?:\.\d+)?/g;

/**
 * A message with what varies between two occurrences of one fault taken out: ids, hashes, tokens
 * and numbers. "Session cm2x… not found" and "Session cm2y… not found" are the same fault.
 */
export function normalizeMessage(message: string): string {
  return message
    .replace(/<email:[0-9a-f]+>/g, "<email>")
    .replace(UUID, "<id>")
    .replace(CUID, "<id>")
    .replace(HEX, "<hex>")
    .replace(LONG_TOKEN, "<token>")
    .replace(NUMBER, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/**
 * The first frame of a stack, without line and column numbers or build hashes, so a rebuild or a
 * moved line does not split one fault in two. V8 (`at fn (file:1:2)`) and Firefox and Safari
 * (`fn@file:1:2`) shapes; null when there is no frame.
 */
export function topFrame(stack: string | null | undefined): string | null {
  if (!stack) return null;
  for (const raw of stack.split("\n")) {
    const line = raw.trim();
    const v8 = /^at\s+(.+)$/.exec(line);
    const gecko = /^([^@\s]*)@(.+:\d+(?::\d+)?)$/.exec(line);
    const frame =
      v8?.[1] ??
      (gecko
        ? `${gecko[1] === undefined || gecko[1] === "" ? "<anonymous>" : gecko[1]} (${gecko[2]})`
        : null);
    if (!frame) continue;
    return (
      frame
        .replace(/:\d+(?::\d+)?(?=\)?$)/, "")
        .replace(/\?[^)\s]*/g, "")
        // A bundler's content hash in a chunk name first (`page-3f2a9c81d0.js`), then any hash left.
        .replace(/[-.](?=[A-Za-z0-9_]*\d)[A-Za-z0-9_]{8,}\.(js|mjs|cjs)\b/g, ".$1")
        .replace(/\b[0-9a-f]{8,}\b/gi, "<hash>")
        .slice(0, 200)
    );
  }
  return null;
}

/** A path segment that names one record rather than a page: a uuid, a cuid, a number, a long token. */
const ID_SEGMENT = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^\d+$/,
  /^c[a-z0-9]{20,30}$/,
  // A digit is required, so a long hyphenated page name (`verification-tokens`) is not taken for one.
  /^(?=.*\d)[A-Za-z0-9_-]{16,}$/,
];

/** A path's id-like segments as `:id`, for a browser report that has a page but no route pattern. */
export function normalizeRoute(path: string): string {
  const bare = path.split(/[?#]/)[0] ?? "";
  const segments = bare
    .split("/")
    .map((s) => (s !== "<token>" && ID_SEGMENT.some((re) => re.test(s)) ? ":id" : s));
  return truncate(segments.join("/") || "/", ERROR_ROUTE_MAX);
}

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");

/** One fault across tenants. A retried job and a dead-lettered one are told apart by severity. */
export function fingerprintOf(input: {
  source: string;
  name: string;
  message: string;
  route: string | null;
  stack: string | null;
  severity: ErrorSeverity;
  jobName: string | null;
}): string {
  const where = input.route ?? topFrame(input.stack) ?? "";
  const parts = [input.source, input.name, normalizeMessage(input.message), where];
  if (input.source === "worker") parts.push(input.jobName ?? "", input.severity);
  return sha(parts.join("\n")).slice(0, 32);
}

/** The fault within one tenant, or within the platform when there is none. */
export function groupKeyOf(fingerprint: string, companyId: string | null): string {
  return sha(`${fingerprint}\n${companyId ?? "platform"}`).slice(0, 40);
}

const opt = (v: string | undefined | null, max: number): string | null =>
  v === undefined || v === null || v.trim() === "" ? null : truncate(v.trim(), max);

/** An event as it may be stored: redacted, bounded, fingerprinted. */
export function sanitizeError(event: ErrorEvent, now: Date = new Date()): ErrorRecord {
  const name = truncate((event.name ?? "").trim() || "Error", ERROR_NAME_MAX);
  const message = redactErrorText(event.message || "(no message)", ERROR_MESSAGE_MAX);
  const stack = event.stack ? redactErrorText(event.stack, ERROR_STACK_MAX) : null;
  const path = event.path ? redactErrorPath(event.path) : null;
  // A route is a pattern the code declared (`/p/:linkToken`), not a URL, so it is kept as written;
  // only a literal link token, should a caller pass a path by mistake, is hidden.
  const route = event.route
    ? truncate(event.route.trim().replace(LINK_TOKEN, "$1<token>").split(/[?#]/)[0] ?? "", ERROR_ROUTE_MAX)
    : path
      ? normalizeRoute(path)
      : null;
  const severity: ErrorSeverity = event.severity ?? "error";
  const jobName = opt(event.jobName, 100);
  const fingerprint = fingerprintOf({ source: event.source, name, message, route, stack, severity, jobName });
  const companyId = opt(event.companyId, 64);
  return {
    fingerprint,
    groupKey: groupKeyOf(fingerprint, companyId),
    source: event.source,
    severity,
    name,
    message,
    stack,
    route,
    path,
    method: opt(event.method?.toUpperCase(), 16),
    status: typeof event.status === "number" && Number.isInteger(event.status) ? event.status : null,
    requestId: opt(event.requestId, 100),
    companyId,
    userId: opt(event.userId, 64),
    sessionId: opt(event.sessionId, 64),
    release: opt(event.release, 100),
    userAgent: opt(event.userAgent, ERROR_UA_MAX),
    jobName,
    jobAttempt: typeof event.jobAttempt === "number" ? event.jobAttempt : null,
    jobFinal: typeof event.jobFinal === "boolean" ? event.jobFinal : null,
    occurredAt: event.at ?? now,
  };
}

/** An unknown thrown value as a name, message and stack. */
export function describeThrown(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, ...(err.stack ? { stack: err.stack } : {}) };
  }
  if (typeof err === "string") return { name: "Error", message: err };
  try {
    const json: unknown = JSON.stringify(err);
    return { name: "Error", message: typeof json === "string" ? json : String(err) };
  } catch {
    return { name: "Error", message: String(err) };
  }
}
