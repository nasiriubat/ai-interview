import { hkdfSync } from "node:crypto";

/**
 * The credential of the web-to-API machine routes, derived from `AUTH_SECRET` (D-260).
 *
 * `AUTH_SECRET` signs every staff session. Sending it as the internal credential meant that a
 * leak of the header (a log line, a proxy dump, a misconfigured upstream) was a leak of the key
 * that forges sessions. The credential on the wire is now an HKDF-SHA256 output bound to this
 * purpose: it opens `/internal/*` and nothing else, and it cannot be turned back into
 * `AUTH_SECRET`. Both processes hold `AUTH_SECRET` already, so nothing new is deployed.
 *
 * This file is Node-only and is a separate package entry point
 * (`@aidp/shared/internal-secret`), so the browser bundles that import `@aidp/shared` never pull
 * `node:crypto` in.
 */
export const INTERNAL_AUTH_INFO = "aidp/internal-auth";

export function deriveInternalSecret(authSecret: string): string {
  if (authSecret.length === 0) return "";
  const key = hkdfSync(
    "sha256",
    Buffer.from(authSecret, "utf8"),
    Buffer.alloc(0),
    Buffer.from(INTERNAL_AUTH_INFO, "utf8"),
    32,
  );
  return Buffer.from(key).toString("base64url");
}
