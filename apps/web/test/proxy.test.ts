import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forwardToApi } from "@/lib/api/proxy";

/**
 * The proxy is the trust boundary between the browser and an API that is not on the internet, so
 * what it refuses to carry matters as much as what it carries.
 */
type Fetch = typeof globalThis.fetch;

const originalFetch: Fetch = globalThis.fetch;
let seen: { url: string; init: RequestInit } | undefined;

/** A NextRequest is more than these tests need; the proxy reads only these members. */
const request = (headers: Record<string, string>, method = "GET"): never =>
  ({
    method,
    headers: new Headers(headers),
    nextUrl: { search: "" },
    arrayBuffer: async () => new ArrayBuffer(0),
  }) as never;

beforeEach(() => {
  seen = undefined;
  globalThis.fetch = ((url: string, init: RequestInit) => {
    seen = { url, init };
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as unknown as Fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const sentHeaders = (): Headers => new Headers(seen?.init.headers);

describe("forwardToApi", () => {
  it("carries the headers the API legitimately needs from the caller", async () => {
    await forwardToApi(
      request({ accept: "text/event-stream", "content-type": "application/json" }),
      ["campaigns"],
      "jwt",
    );

    expect(sentHeaders().get("accept")).toBe("text/event-stream");
    expect(sentHeaders().get("content-type")).toBe("application/json");
  });

  it("attaches the bearer token server-side and ignores one from the browser", async () => {
    await forwardToApi(request({ authorization: "Bearer attacker-supplied" }), ["campaigns"], "jwt");

    expect(sentHeaders().get("authorization")).toBe("Bearer jwt");
  });

  it("drops the internal sign-in secret header, which a browser must never be able to present", async () => {
    await forwardToApi(
      request({ "x-internal-auth": "guessed-secret" }),
      ["internal", "auth", "verification-tokens"],
      "jwt",
    );

    expect(sentHeaders().get("x-internal-auth")).toBeNull();
  });

  it("drops a tenant override the browser sets directly, and keeps the one the route passes", async () => {
    // The staff route reads `x-company-id` and passes it through `extraHeaders` on purpose; the
    // API honours it only for a platform operator. The point here is that the two paths are
    // distinguishable at all, rather than every browser header arriving by default.
    await forwardToApi(request({ "x-company-id": "someone-elses-tenant" }), ["campaigns"], "jwt");
    expect(sentHeaders().get("x-company-id")).toBeNull();

    await forwardToApi(request({}), ["campaigns"], "jwt", { "X-Company-Id": "chosen-tenant" });
    expect(sentHeaders().get("x-company-id")).toBe("chosen-tenant");
  });

  it("never forwards the session cookie", async () => {
    await forwardToApi(request({ cookie: "authjs.session-token=secret" }), ["campaigns"], "jwt");

    expect(sentHeaders().get("cookie")).toBeNull();
  });
});
