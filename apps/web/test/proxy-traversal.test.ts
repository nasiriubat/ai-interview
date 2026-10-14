import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forwardToApi } from "@/lib/api/proxy";

/**
 * Path traversal through the proxy (Security M3 probe). A browser chooses the path segments after
 * `/api/participant/` and `/api/staff/`; the proxy joins them onto the API's own prefix. A segment
 * that is `..` must not be able to climb out of `/api/v1/` or into the machine-to-machine
 * routes, whichever credential the handler attaches.
 */
type Fetch = typeof globalThis.fetch;
const originalFetch: Fetch = globalThis.fetch;
let seen = "";

beforeEach(() => {
  seen = "";
  globalThis.fetch = (async (url: string) => {
    seen = url;
    return new Response(null, { status: 204 });
  }) as unknown as Fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const request = (): never =>
  ({
    method: "GET",
    headers: new Headers(),
    nextUrl: { search: "" },
    body: null,
  }) as never;

describe("forwardToApi path segments", () => {
  it.each([
    [["p", "session", "..", "..", "internal", "auth", "verification-tokens"]],
    [["..", "..", "internal", "auth", "verification-tokens", "consume"]],
    [["p", "..", "operator", "tenants"]],
    [["p", ".", "session"]],
    [["p", "%2e%2e", "operator"]],
    [["p", "..%2F..%2Foperator"]],
    [["p", "a\r\nX-Injected: 1"]],
  ])("keeps %j under the API prefix and out of the operator and internal routes", async (segments) => {
    const res = await forwardToApi(request(), segments, "tok");
    // A dot segment is refused outright; anything else must still resolve under the prefix.
    if (segments.some((s) => s === "." || s === "..")) {
      expect(res.status).toBe(400);
      expect(seen).toBe("");
      return;
    }
    const resolved = new URL(seen);
    // Whatever the segments were, the request still lands under /api/v1/ and never on a route
    // that takes a different kind of credential than the handler meant.
    expect(resolved.pathname.startsWith("/api/v1/"), resolved.pathname).toBe(true);
    expect(resolved.pathname).not.toMatch(/^\/api\/v1\/(operator|internal)\b/);
    expect(seen).not.toMatch(/[\r\n]/);
  });
});
