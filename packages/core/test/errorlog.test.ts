import { describe, expect, it, vi } from "vitest";
import {
  ErrorRecorder,
  MemoryErrorStore,
  fingerprintOf,
  groupKeyOf,
  normalizeMessage,
  normalizeRoute,
  redactErrorPath,
  sanitizeError,
  topFrame,
  type ErrorEvent,
} from "../src/index.js";

/** The error log's pure half (D-477): what is kept of a failure, how faults group, and the throttle. */

const LINK = "Xk3n9Qp2Lr7Vb8Wm4Zt6Yc1";
const INVITE = "Rq8Lm2Np5Kd7Hs3Jf9Gt4Bx";

describe("redaction: tokens and personal data never reach the store", () => {
  it("hides link and invitation tokens in the path, and the Caddy filter's query values", () => {
    expect(redactErrorPath(`/p/${LINK}/open`)).toBe("/p/<token>/open");
    expect(redactErrorPath(`/api/v1/p/r/${INVITE}`)).toBe("/api/v1/p/r/<token>");
    expect(redactErrorPath("/p/session/turns")).toBe("/p/session/turns");
    expect(
      redactErrorPath(
        "https://aiscope.example/auth/verify?token=abc123&email=a.person%40x.fi&callbackUrl=%2Fadmin&code=123456&page=2#frag",
      ),
    ).toBe("/auth/verify?token=REDACTED&email=REDACTED&callbackUrl=REDACTED&code=REDACTED&page=2");
  });

  it("scrubs a message and a stack: link tokens, bearer tokens, token query values and addresses", () => {
    const r = sanitizeError({
      source: "api",
      name: "TypeError",
      message: `Failed for jane.doe@example.com on /p/${LINK}/open with Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig`,
      stack: `TypeError: boom\n    at open (/app/dist/participant.js:10:5)\n    url /verify?token=${LINK}&code=998877`,
      path: `/api/v1/p/${LINK}/open?email=jane.doe%40example.com`,
    });
    const stored = JSON.stringify(r);
    expect(stored).not.toContain(LINK);
    expect(stored).not.toContain("jane.doe");
    expect(stored).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(stored).not.toContain("998877");
    expect(r.path).toBe("/api/v1/p/<token>/open?email=REDACTED");
    expect(r.message).toMatch(/<email:[0-9a-f]{8}>/);
  });

  it("hides a token standing on its own, and keeps the ids worth debugging with", () => {
    const r = sanitizeError({
      source: "api",
      message: `invalid link ${LINK} for campaign cm2x9k1q20000abcd1234efgh, row 3f2a1b4c-1111-4222-8333-444455556666`,
    });
    expect(r.message).toBe(
      "invalid link <token> for campaign cm2x9k1q20000abcd1234efgh, row 3f2a1b4c-1111-4222-8333-444455556666",
    );
  });

  it("bounds every field: message, stack, user agent, path", () => {
    const r = sanitizeError({
      source: "browser",
      message: "m".repeat(5000),
      stack: "s".repeat(50_000),
      userAgent: "u".repeat(2000),
      path: `/${"a".repeat(3000)}`,
    });
    expect(r.message.length).toBeLessThanOrEqual(1000);
    expect(r.stack?.length).toBeLessThanOrEqual(8 * 1024);
    expect(r.userAgent?.length).toBeLessThanOrEqual(300);
    expect(r.path?.length).toBeLessThanOrEqual(500);
  });

  it("keeps ids, never names: a staff user id and a participant session id, and drops empty strings", () => {
    const r = sanitizeError({ source: "api", message: "x", userId: "u1", sessionId: " ", companyId: "" });
    expect(r).toMatchObject({
      userId: "u1",
      sessionId: null,
      companyId: null,
      severity: "error",
      name: "Error",
    });
  });
});

describe("fingerprinting", () => {
  const base: ErrorEvent = { source: "api", name: "Error", message: "x", route: "/campaigns/:id" };
  const fp = (e: Partial<ErrorEvent>): string => sanitizeError({ ...base, ...e }).fingerprint;

  it("strips what varies between two occurrences of one fault", () => {
    expect(normalizeMessage("Session cm2x9k1q20000abcd1234efgh not found after 1500 ms")).toBe(
      "Session <id> not found after <n> ms",
    );
    expect(normalizeMessage("row 3f2a1b4c-1111-4222-8333-444455556666 locked")).toBe("row <id> locked");
    expect(normalizeMessage("hash deadbeefcafe0123 mismatch")).toBe("hash <hex> mismatch");
    expect(fp({ message: "Campaign c123456789012345678901234 not found (42)" })).toBe(
      fp({ message: "Campaign c999999999999999999999999 not found (7)" }),
    );
  });

  it("separates faults by source, name, message and route", () => {
    expect(fp({ source: "worker" })).not.toBe(fp({}));
    expect(fp({ name: "TypeError" })).not.toBe(fp({}));
    expect(fp({ message: "y" })).not.toBe(fp({}));
    expect(fp({ route: "/sessions/:id" })).not.toBe(fp({}));
  });

  it("uses the top stack frame, without line numbers or build hashes, when there is no route", () => {
    const a = "TypeError: x\n    at render (/app/.next/server/chunks/page-3f2a9c81d0.js:12:34)\n    at y";
    const b = "TypeError: x\n    at render (/app/.next/server/chunks/page-77aa00bb11.js:99:1)\n    at z";
    expect(topFrame(a)).toBe(topFrame(b));
    expect(topFrame("Error: x\nrender@https://x.test/_next/static/chunks/app-1a2b3c4d5e.js:3:9")).toBe(
      "render (https://x.test/_next/static/chunks/app.js)",
    );
    const noRoute = (stack: string): string =>
      fingerprintOf({
        source: "worker",
        name: "Error",
        message: "x",
        route: null,
        stack,
        severity: "error",
        jobName: "analysis.run",
      });
    expect(noRoute(a)).toBe(noRoute(b));
  });

  it("tells a retried job from a dead-lettered one", () => {
    const w = (severity: "error" | "warning"): string =>
      sanitizeError({ source: "worker", message: "provider timed out", jobName: "analysis.run", severity })
        .fingerprint;
    expect(w("warning")).not.toBe(w("error"));
  });

  it("derives a browser report's route from its page, ids as :id", () => {
    expect(normalizeRoute("/admin/campaigns/cm2x9k1q20000abcd1234efgh/sessions/42")).toBe(
      "/admin/campaigns/:id/sessions/:id",
    );
    expect(normalizeRoute("/admin/operator/verification-tokens")).toBe("/admin/operator/verification-tokens");
    expect(sanitizeError({ source: "browser", message: "x", path: `/p/${LINK}?x=1` }).route).toBe(
      "/p/<token>",
    );
  });

  it("groups per tenant: one fault, a group per tenant and one for the platform", () => {
    const f = fp({});
    expect(groupKeyOf(f, "a")).not.toBe(groupKeyOf(f, "b"));
    expect(groupKeyOf(f, null)).not.toBe(groupKeyOf(f, "a"));
    expect(sanitizeError({ ...base, companyId: "a" }).groupKey).toBe(groupKeyOf(f, "a"));
  });
});

describe("the recorder: fire and forget, bounded, throttled", () => {
  const event: ErrorEvent = { source: "api", message: "boom", route: "/x" };

  it("stores one occurrence per group per throttle window and counts the rest", async () => {
    let now = 1_000_000;
    const store = new MemoryErrorStore();
    const rec = new ErrorRecorder({ store, autoFlush: false, now: () => now, throttleMs: 10_000 });
    for (let i = 0; i < 25; i++) rec.capture(event);
    await rec.flush();
    const key = sanitizeError(event).groupKey;
    expect(store.stored()).toHaveLength(1);
    expect(store.countFor(key)).toBe(25);
    now += 10_000;
    rec.capture(event);
    await rec.flush();
    expect(store.stored()).toHaveLength(2);
    expect(store.countFor(key)).toBe(26);
  });

  it("does not throttle distinct faults against each other", async () => {
    const store = new MemoryErrorStore();
    const rec = new ErrorRecorder({ store, autoFlush: false });
    rec.capture(event);
    rec.capture({ ...event, message: "other" });
    rec.capture({ ...event, companyId: "tenant-b" });
    await rec.flush();
    expect(store.stored()).toHaveLength(3);
  });

  it("keeps the queue bounded: past the limit occurrences are counted, not stored", async () => {
    const store = new MemoryErrorStore();
    const rec = new ErrorRecorder({ store, autoFlush: false, maxQueue: 5, maxPending: 3 });
    for (let i = 0; i < 20; i++) rec.capture({ ...event, route: `/r${String.fromCharCode(97 + i)}` });
    expect(rec.backlog().queued).toBe(5);
    await rec.flush();
    expect(store.stored()).toHaveLength(5);
    expect(store.writes.filter((w) => !w.storeOccurrence)).toHaveLength(3);
    expect(rec.dropped).toBe(12);
  });

  it("never throws from capture, and says a failed write once until one succeeds", async () => {
    const store = new MemoryErrorStore();
    store.fail = true;
    const warn = vi.fn();
    const rec = new ErrorRecorder({ store, autoFlush: false, warn });
    expect(() => {
      rec.capture(event);
      rec.capture(null as unknown as ErrorEvent);
    }).not.toThrow();
    await rec.flush();
    rec.capture({ ...event, message: "second" });
    await rec.flush();
    expect(warn).toHaveBeenCalledTimes(1);
    store.fail = false;
    rec.capture({ ...event, message: "third" });
    await rec.flush();
    store.fail = true;
    rec.capture({ ...event, message: "fourth" });
    await rec.flush();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("writes on its own, in a batch, after the flush delay", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryErrorStore();
      const rec = new ErrorRecorder({ store, flushMs: 500 });
      rec.capture(event);
      rec.capture({ ...event, message: "two" });
      expect(store.writes).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(600);
      expect(store.writes).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
