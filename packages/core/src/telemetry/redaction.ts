import { createHash } from "node:crypto";

/**
 * What is never logged (D-223, docs/OPERATIONS.md "What is never logged").
 *
 * A log line outlives the retention sweep, is shipped to places a participant's data is not
 * supposed to be, and is read by whoever debugs at 3 a.m. So, at every level and in every
 * environment except `NODE_ENV=development`:
 *
 *   1. tokens: bearer and cookie headers, participant link and invitation tokens in URLs, and
 *      every query string (the magic-link `token=` lands in logs otherwise);
 *   2. what a person said: message text, transcripts, summaries, facts, extracted file text;
 *   3. email addresses, replaced by a short hash so two lines about one address still correlate;
 *   4. secrets: API keys, passwords, SMTP URLs, custom provider headers (those are credentials);
 *   5. upload filenames, reduced to their extension.
 *
 * This module is the one definition. The API's logger, the worker's logger and the tests all take
 * their options from it, so a category cannot be added to one process and forgotten in the other.
 */

export const REDACTED = "[redacted]";

/** A short, stable, non-reversible stand-in for a value. */
export function shortHash(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex").slice(0, 8);
}

/**
 * A URL path with its token segments hidden. Participant routes carry a bearer-equivalent in the
 * path: `/p/<linkToken>[/...]` and `/p/r/<invitationToken>[/...]`, under whichever prefix the
 * hop used (`/api/v1`, `/api/participant`, none). `/p/session` and its children are not tokens.
 */
export function redactPath(path: string): string {
  return path
    .replace(/(^|\/)p\/r\/[^/?#]+/g, "$1p/r/<token>")
    .replace(/(^|\/)p\/(?!session(?:\/|$|\?)|r\/)[^/?#]+/g, "$1p/<token>");
}

/** A request URL as it may be logged: tokens in the path hidden, the whole query string dropped. */
export function redactUrl(url: string): string {
  const cut = url.search(/[?#]/);
  const path = cut === -1 ? url : url.slice(0, cut);
  return redactPath(path) + (cut === -1 ? "" : "?<redacted>");
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const TOKEN_PARAM = /([?&;](?:token|code|access_token|id_token|key|secret|password|signature)=)[^&\s"']+/gi;
const LONG_PATH_TOKEN = /(\/p\/(?:r\/)?)[A-Za-z0-9_-]{16,}/g;

/**
 * Free text with the identifying parts hidden. For error messages and strings that may have had a
 * URL or an address interpolated into them; never a substitute for not logging content.
 */
export function scrubLogText(text: string): string {
  return text
    .replace(BEARER, "$1 <token>")
    .replace(TOKEN_PARAM, "$1<redacted>")
    .replace(LONG_PATH_TOKEN, "$1<token>")
    .replace(EMAIL, (m) => `<email:${shortHash(m)}>`);
}

/** `report.pdf` -> `.pdf`; a name with no extension becomes `[file]`. */
export function extensionOnly(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 && dot < filename.length - 1 && filename.length - dot <= 12 ? filename.slice(dot) : "[file]";
}

/** Property names whose value is what a person said or wrote. */
const CONTENT_KEYS = [
  "text",
  "content",
  "transcript",
  "messages",
  "answer",
  "summary",
  "facts",
  "extractedText",
  "prompt",
  "system",
  "quote",
] as const;
const ADDRESS_KEYS = ["email", "to", "adminEmail", "identifier", "from", "recipient"] as const;
const SECRET_KEYS = [
  "apiKey",
  "apiKeyEnc",
  "password",
  "smtpUrl",
  "headers",
  "headersEnc",
  "authorization",
  "cookie",
  "token",
  "secret",
  "accessToken",
  "resumeToken",
  "linkToken",
] as const;
const FILENAME_KEYS = ["filename", "fileName"] as const;

const addressKeySet: ReadonlySet<string> = new Set(ADDRESS_KEYS);
const filenameKeySet: ReadonlySet<string> = new Set(FILENAME_KEYS);

/** fast-redact paths: the key at the top level and one level down (`*.key`), which is how pino objects nest. */
function paths(keys: readonly string[]): string[] {
  return keys.flatMap((k) => [k, `*.${k}`]);
}

export interface RedactionOptions {
  /**
   * Development prints addresses and message text so the console email and a local transcript
   * can be read. Tokens and secrets stay hidden there too.
   */
  development?: boolean;
}

/** The `redact` option for pino, plus the censor that hashes addresses and shortens filenames. */
export function pinoRedact(options: RedactionOptions = {}): {
  paths: string[];
  censor: (value: unknown, path: string[]) => unknown;
} {
  const dev = options.development === true;
  return {
    paths: [
      // `headers` is in SECRET_KEYS, which covers `req.headers` (authorization, cookie) and
      // `res.headers` (set-cookie) as a whole: the request line is enough for a log.
      ...paths(SECRET_KEYS),
      ...(dev ? [] : [...paths(CONTENT_KEYS), ...paths(ADDRESS_KEYS)]),
      ...paths(FILENAME_KEYS),
    ],
    censor: (value, path) => {
      const key = path[path.length - 1] ?? "";
      if (typeof value === "string" && addressKeySet.has(key)) return `<email:${shortHash(value)}>`;
      if (typeof value === "string" && filenameKeySet.has(key)) return extensionOnly(value);
      return REDACTED;
    },
  };
}

/** The `serializers` option for pino: the request line carries no token and no query. */
export function pinoSerializers(): Record<string, (value: unknown) => unknown> {
  return {
    req: (value) => {
      const r = value as { url?: string; method?: string; id?: string; remoteAddress?: string } | undefined;
      if (!r || typeof r !== "object") return value;
      return {
        method: r.method,
        url: typeof r.url === "string" ? redactUrl(r.url) : r.url,
        ...(r.id !== undefined ? { id: r.id } : {}),
        ...(r.remoteAddress !== undefined ? { remoteAddress: r.remoteAddress } : {}),
      };
    },
    err: (value) => {
      const e = value as Error | undefined;
      if (!(e instanceof Error)) return value;
      return {
        type: e.name,
        message: scrubLogText(e.message),
        stack: e.stack ? scrubLogText(e.stack) : undefined,
      };
    },
  };
}
