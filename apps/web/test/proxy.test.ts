import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bodyLimitFor,
  DEFAULT_BODY_LIMIT_BYTES,
  forwardToApi,
  UPLOAD_BODY_LIMIT_BYTES,
} from "@/lib/api/proxy";

/**
 * The proxy is the trust boundary between the browser and an API that is not on the internet, so
 * what it refuses to carry matters as much as what it carries.
 */
type Fetch = typeof globalThis.fetch;

const originalFetch: Fetch = globalThis.fetch;
let seen: { url: string; init: RequestInit } | undefined;

/**
 * A NextRequest is more than these tests need; the proxy reads only these members. `arrayBuffer`
 * throws on purpose: the proxy must stream the body, never buffer it.
 */
const request = (
  headers: Record<string, string>,
  method = "GET",
  body: ReadableStream | null = null,
): never =>
  ({
    method,
    headers: new Headers(headers),
    nextUrl: { search: "" },
    body,
    arrayBuffer: async () => {
      throw new Error("the proxy must not buffer the request body");
    },
  }) as never;

/** A body that yields `chunks` chunks of `size` bytes and records how many were pulled. */
function chunkedBody(
  chunks: number,
  size: number,
): { stream: ReadableStream<Uint8Array>; pulled: () => number } {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunks) {
        controller.close();
        return;
      }
      sent++;
      controller.enqueue(new Uint8Array(size));
    },
  });
  return { stream, pulled: () => sent };
}

beforeEach(() => {
  seen = undefined;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    // A real fetch drains the body; an error in the stream rejects the call.
    const body = init.body as ReadableStream<Uint8Array> | undefined;
    if (body) await body.pipeTo(new WritableStream());
    return new Response(null, { status: 204 });
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

  describe("client address", () => {
    it("forwards the one address the edge proxy wrote, as the rate-limit identity", async () => {
      await forwardToApi(request({ "x-forwarded-for": "203.0.113.9" }), ["p", "x"], undefined);
      expect(sentHeaders().get("x-forwarded-for")).toBe("203.0.113.9");
    });

    it("takes the last entry when several are present, so a browser-supplied prefix is ignored", async () => {
      await forwardToApi(request({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }), ["p", "x"], undefined);
      expect(sentHeaders().get("x-forwarded-for")).toBe("203.0.113.9");
    });

    it("sends nothing when the header is absent or is not an address", async () => {
      await forwardToApi(request({}), ["p", "x"], undefined);
      expect(sentHeaders().get("x-forwarded-for")).toBeNull();
      await forwardToApi(request({ "x-forwarded-for": "not-an-ip" }), ["p", "x"], undefined);
      expect(sentHeaders().get("x-forwarded-for")).toBeNull();
    });

    it("carries an IPv6 address without brackets", async () => {
      await forwardToApi(request({ "x-forwarded-for": "[2001:db8::7]" }), ["p", "x"], undefined);
      expect(sentHeaders().get("x-forwarded-for")).toBe("2001:db8::7");
    });
  });

  describe("body limits (S6)", () => {
    it("rejects an oversize content-length with 413 before anything is read or sent", async () => {
      const { stream } = chunkedBody(1, 10);
      const res = await forwardToApi(
        request({ "content-length": String(DEFAULT_BODY_LIMIT_BYTES + 1) }, "POST", stream),
        ["campaigns"],
        "jwt",
      );
      expect(res.status).toBe(413);
      expect(seen).toBeUndefined();
      // Never locked, so never read: the refusal came from the header alone.
      expect(stream.locked).toBe(false);
    });

    it("aborts a chunked body with no declared length once it passes the cap", async () => {
      // 40 chunks of 64 KiB is 2.5 MiB against a 1 MiB cap, and the stream must be cut well before the end.
      const { stream, pulled } = chunkedBody(40, 64 * 1024);
      const res = await forwardToApi(request({}, "POST", stream), ["campaigns"], "jwt");
      expect(res.status).toBe(413);
      expect(pulled()).toBeLessThan(40);
    });

    it("streams a body under the cap through to the API", async () => {
      const { stream } = chunkedBody(4, 1024);
      const res = await forwardToApi(
        request({ "content-type": "application/json" }, "POST", stream),
        ["campaigns"],
        "jwt",
      );
      expect(res.status).toBe(204);
      expect(seen?.init.body).toBeDefined();
      expect((seen?.init as { duplex?: string }).duplex).toBe("half");
    });

    it("allows the platform upload size only on the two upload routes", () => {
      expect(bodyLimitFor(["p", "session", "attachments"])).toBe(UPLOAD_BODY_LIMIT_BYTES);
      expect(bodyLimitFor(["p", "session", "voice-turns"])).toBe(UPLOAD_BODY_LIMIT_BYTES);
      expect(bodyLimitFor(["campaigns"])).toBe(DEFAULT_BODY_LIMIT_BYTES);
      expect(bodyLimitFor(["p", "session", "turns"])).toBe(DEFAULT_BODY_LIMIT_BYTES);
    });
  });

  describe("cross-site requests (S6)", () => {
    it("refuses a state-changing request the browser marks cross-site", async () => {
      const res = await forwardToApi(
        request({ "sec-fetch-site": "cross-site", host: "app.example.test" }, "POST"),
        ["campaigns"],
        "jwt",
      );
      expect(res.status).toBe(403);
      expect(seen).toBeUndefined();
    });

    it("refuses a foreign Origin when Sec-Fetch-Site is absent", async () => {
      const res = await forwardToApi(
        request({ origin: "https://evil.example", host: "app.example.test" }, "DELETE"),
        ["campaigns", "x"],
        "jwt",
      );
      expect(res.status).toBe(403);
    });

    it("accepts same-origin writes, and reads from anywhere", async () => {
      const same = await forwardToApi(
        request({ "sec-fetch-site": "same-origin" }, "POST"),
        ["campaigns"],
        "jwt",
      );
      expect(same.status).toBe(204);
      const origin = await forwardToApi(
        request({ origin: "https://app.example.test", host: "app.example.test" }, "POST"),
        ["campaigns"],
        "jwt",
      );
      expect(origin.status).toBe(204);
      const read = await forwardToApi(request({ "sec-fetch-site": "cross-site" }), ["campaigns"], "jwt");
      expect(read.status).toBe(204);
    });
  });
});
