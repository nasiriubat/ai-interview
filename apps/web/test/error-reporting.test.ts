import { BrowserErrorReportSchema, WebErrorReportSchema } from "@aidp/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BODY_MAX_BYTES,
  BrowserReporter,
  isNoise,
  REPORTS_PER_PAGE,
  reportBody,
} from "@/lib/errors/browser-report";
import { reportServerError, webErrorReport } from "@/lib/errors/server-report";

/*
 * Capture for the error log (D-477): what a browser sends and what it leaves out, the relay's
 * limits and its choice of credential, and the web server's report.
 */

const cookies = vi.hoisted(() => ({
  staff: undefined as string | undefined,
  participant: undefined as string | undefined,
}));
vi.mock("@/lib/api/server", () => ({
  staffTokenFromCookies: async () => cookies.staff,
  participantTokenFromCookies: async () => cookies.participant,
}));

describe("the browser reporter", () => {
  it("ignores extensions, the ResizeObserver notice, aborted fetches and an opaque script error", () => {
    expect(
      isNoise({ message: "x is undefined", stack: "at f (chrome-extension://abc/content.js:1:2)" }),
    ).toBe(true);
    expect(isNoise({ message: "boom", source: "moz-extension://abc/x.js" })).toBe(true);
    expect(isNoise({ message: "ResizeObserver loop completed with undelivered notifications." })).toBe(true);
    expect(isNoise({ name: "AbortError", message: "The operation was aborted." })).toBe(true);
    expect(isNoise({ message: "The user aborted a request." })).toBe(true);
    expect(isNoise({ message: "Failed to fetch" })).toBe(true);
    expect(isNoise({ message: "Load failed" })).toBe(true);
    expect(isNoise({ message: "NetworkError when attempting to fetch resource." })).toBe(true);
    expect(isNoise({ message: "Script error." })).toBe(true);
    expect(
      isNoise({ name: "TypeError", message: "Cannot read properties of undefined (reading 'id')" }),
    ).toBe(false);
  });

  it("sends one error once per page load, and at most a handful in all", () => {
    const sent: string[] = [];
    const r = new BrowserReporter(
      (b) => sent.push(b),
      () => "/admin/campaigns/c1?tab=results",
    );
    const err = new TypeError("Cannot read properties of undefined (reading 'id')");
    expect(r.report(err, "error")).toBe(true);
    expect(r.report(err, "error")).toBe(false);
    expect(r.report(new Error("ResizeObserver loop limit exceeded"), "error")).toBe(false);
    for (let i = 0; i < 30; i++) r.report(new Error(`distinct ${String(i)}`), "unhandledrejection");
    expect(sent).toHaveLength(REPORTS_PER_PAGE);
    const first = BrowserErrorReportSchema.parse(JSON.parse(sent[0] ?? "{}"));
    expect(first).toMatchObject({
      kind: "error",
      name: "TypeError",
      path: "/admin/campaigns/c1?tab=results",
    });
  });

  it("keeps a report under the body cap however long its message and stack are", () => {
    const body = reportBody({
      kind: "error",
      name: "Error",
      message: "m".repeat(50_000),
      stack: "at frame\n".repeat(10_000),
      path: "/p/session",
    });
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(BODY_MAX_BYTES);
    expect(() => BrowserErrorReportSchema.parse(JSON.parse(body))).not.toThrow();
  });

  it("never throws, even for a value that cannot be described", () => {
    const r = new BrowserReporter(
      () => {
        throw new Error("send failed");
      },
      () => "/",
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => r.report(cyclic, "unhandledrejection")).not.toThrow();
  });
});

describe("the /api/errors relay", () => {
  const originalFetch = globalThis.fetch;
  let calls: { url: string; init: RequestInit }[] = [];
  let answers: number[] = [];

  beforeEach(() => {
    calls = [];
    answers = [204];
    cookies.staff = undefined;
    cookies.participant = undefined;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: answers.shift() ?? 204 });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const post = async (body: string, headers: Record<string, string> = {}): Promise<Response> => {
    const { POST } = await import("@/app/api/errors/route");
    const req = new Request("http://app.test/api/errors", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", ...headers },
      body,
    });
    return POST(req as never);
  };
  const report = (path: string): string => JSON.stringify({ kind: "error", message: "boom", path });
  const auth = (i: number): string | undefined =>
    (calls[i]?.init.headers as Record<string, string> | undefined)?.authorization;

  it("refuses a cross-site post and a body over 8 KB", async () => {
    expect((await post(report("/admin"), { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await post("x".repeat(9000))).status).toBe(413);
    expect((await post(report("/"), { "content-length": "20000" })).status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it("sends the staff credential for an admin page and the participant one for an interview", async () => {
    cookies.staff = "staff-jwt";
    cookies.participant = "pt.part";
    expect((await post(report("/admin/campaigns"))).status).toBe(204);
    expect(auth(0)).toBe("Bearer staff-jwt");
    await post(report("/p/session"));
    expect(auth(1)).toBe("Bearer pt.part");
    expect(calls[0]?.url).toMatch(/\/api\/v1\/public\/errors$/);
  });

  it("sends anonymously with no credential, and retries anonymously after a 401", async () => {
    await post(report("/"));
    expect(auth(0)).toBeUndefined();
    cookies.staff = "expired";
    answers = [401, 204];
    expect((await post(report("/admin"))).status).toBe(204);
    expect(auth(1)).toBe("Bearer expired");
    expect(auth(2)).toBeUndefined();
  });

  it("passes the API's refusal on without a body", async () => {
    answers = [429];
    const res = await post(report("/"));
    expect(res.status).toBe(429);
    expect(await res.text()).toBe("");
  });
});

describe("the web server's report", () => {
  it("carries the route pattern, the digest and the release, in the shape the API accepts", () => {
    const err = Object.assign(new Error("fetch failed"), { digest: "2338392498" });
    const report = webErrorReport(
      err,
      { path: "/p/abcdefghijklmnopqrstuv/open", method: "GET", headers: { "user-agent": "UA" } },
      { routePath: "/p/[token]/open", routeType: "render" },
      "2026.10.3",
    );
    expect(WebErrorReportSchema.parse(report)).toMatchObject({
      name: "Error",
      message: "fetch failed",
      routePath: "/p/[token]/open",
      digest: "2338392498",
      userAgent: "UA",
      release: "2026.10.3",
    });
  });

  it("posts with the internal secret and swallows a failure", async () => {
    vi.stubEnv("AUTH_SECRET", "test-secret-test-secret-test-secret");
    const send = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    await reportServerError(new Error("x"), { path: "/", method: "GET", headers: {} }, {}, send);
    const [url, init] = send.mock.calls[0]!;
    expect(url).toMatch(/\/api\/v1\/internal\/errors$/);
    expect((init?.headers as Record<string, string>)["x-internal-auth"]).toBeTruthy();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failing = vi.fn(async () => {
      throw new Error("down");
    });
    await expect(
      reportServerError(new Error("x"), { path: "/", method: "GET", headers: {} }, {}, failing as never),
    ).resolves.toBeUndefined();
    await reportServerError(new Error("x"), { path: "/", method: "GET", headers: {} }, {}, failing);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    vi.unstubAllEnvs();
  });
});
