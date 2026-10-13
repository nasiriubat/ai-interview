import { isIP } from "node:net";

/**
 * The address of the person on the other end, as the edge proxy reported it.
 *
 * The API rate-limits anonymous callers by address, and it only ever sees this web process as the
 * peer. Without the real address forwarded, every visitor shares one bucket (status review,
 * finding 1). Caddy sits in front of the web app, overwrites `X-Forwarded-For` for untrusted
 * clients, and so presents exactly one value; where several are present the last one is the entry
 * the nearest trusted proxy appended, which is the one worth believing. The API's `trustProxy`
 * hop count is the matching half of that decision (D-82).
 *
 * Returns undefined when there is nothing usable (local development, a request not from a
 * browser), in which case nothing is forwarded and the API falls back to the socket address. A
 * value that is not an IP address is dropped rather than passed on: it would be a header the API
 * parses as an address, and there is no reason to carry arbitrary text across the boundary.
 */
export function clientAddressFrom(headers: { get(name: string): string | null }): string | undefined {
  const raw = headers.get("x-forwarded-for");
  if (!raw) return undefined;
  const last = raw.split(",").at(-1)?.trim();
  if (!last) return undefined;
  // An IPv6 literal may arrive bracketed or with a zone; neither belongs in a rate-limit key.
  const bare = last.replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  return isIP(bare) ? bare : undefined;
}
