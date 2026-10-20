import type { Server } from "node:http";
import { withSystemTenant } from "@aidp/db";
import { describeDb } from "@aidp/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { headerSafe, PILOT_MIN_FILL_MS, PilotRequestService } from "../src/modules/pilot/service.js";
import { PilotTickets } from "../src/modules/pilot/ticket.js";
import { fakeModelServer, testWorld, TEST_AUTH_SECRET, type TestWorld } from "./helpers.js";

/*
 * The public "Request a pilot" form (POST /public/pilot-requests): who receives it, what the mail
 * looks like, and the three fences in front of it (honeypot, signed fill time, five an hour).
 */

const URL_ = "/api/v1/public/pilot-requests";
const PILOT_ENV = "pilot-env@example.com";
const ALERT_ENV = "alerts-env@example.com";

/** A ticket issued `ageMs` ago with the suite's secret: what the page would hold after that long. */
const tickets = new PilotTickets(TEST_AUTH_SECRET, PILOT_MIN_FILL_MS, 24 * 60 * 60 * 1000);
const ticketAged = (ageMs: number): string => tickets.issue(Date.now() - ageMs);

const valid = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "Aino Virtanen",
  email: "aino@customer.example",
  company: "Example Oy",
  role: "Head of Operations",
  companySize: "50-249",
  interest: "both",
  participants: "11-30",
  message: "We would like to try this with two teams.\nIs March possible?",
  consent: true,
  locale: "fi",
  website: "",
  ticket: ticketAged(10_000),
  ...over,
});

let addressSeq = 0;
/** A fresh client address per call site, so one test's rate-limit bucket is not another's. */
const freshAddress = (): string => `203.0.113.${String(++addressSeq)}`;

describeDb("public pilot requests", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };

  const post = (payload: unknown, address = freshAddress()) =>
    world.app.inject({
      method: "POST",
      url: URL_,
      headers: { "x-forwarded-for": address, "user-agent": "vitest" },
      payload: payload as Record<string, unknown>,
    });

  const setPlatform = async (values: Record<string, string>): Promise<void> => {
    await withSystemTenant(() => world.ctx.settings.set({ scope: "platform", scopeId: "" }, values, null));
  };

  beforeAll(async () => {
    model = await fakeModelServer(() => "ok");
    world = await testWorld(model.url, { PILOT_REQUEST_EMAIL: PILOT_ENV, ALERT_EMAIL: ALERT_ENV });
  });
  afterEach(async () => {
    world.email.sent.length = 0;
    vi.restoreAllMocks();
    await world.db.setting.deleteMany({
      where: { scope: "platform", key: { in: ["sales.pilotRequestEmail", "ops.alertEmail"] } },
    });
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  it("emails the operator, with Reply-To set to the requester and every field in the body", async () => {
    const res = await post(valid());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(world.email.sent).toHaveLength(1);
    const mail = world.email.sent[0]!;
    expect(mail.to).toBe(PILOT_ENV);
    expect(mail.replyTo).toBe("aino@customer.example");
    expect(mail.subject).toBe("Pilot request: Example Oy (Aino Virtanen)");
    expect(mail.companyId).toBeUndefined();
    for (const text of [
      "Aino Virtanen",
      "aino@customer.example",
      "Example Oy",
      "Head of Operations",
      "50–249",
      "Both",
      "11–30",
      "fi",
      "We would like to try this with two teams.\nIs March possible?",
      "203.0.113.",
      "vitest",
    ]) {
      expect(mail.text).toContain(text);
    }
  });

  it("never sends anything to the requester's address", async () => {
    await post(valid());
    expect(world.email.sent.map((m) => m.to)).not.toContain("aino@customer.example");
  });

  describe("recipient resolution", () => {
    it("prefers the platform setting over every fallback", async () => {
      await setPlatform({
        "sales.pilotRequestEmail": "sales@example.com",
        "ops.alertEmail": "ops@example.com",
      });
      await post(valid());
      expect(world.email.sent[0]?.to).toBe("sales@example.com");
    });

    it("falls back to PILOT_REQUEST_EMAIL, then ops.alertEmail, then ALERT_EMAIL", async () => {
      await setPlatform({ "ops.alertEmail": "ops@example.com" });
      expect(await world.ctx.services.pilot.recipient()).toBe(PILOT_ENV);
      const log = { info: () => undefined, warn: () => undefined };
      const noPilotEnv = new PilotRequestService({
        settings: world.ctx.settings,
        email: world.email,
        authSecret: TEST_AUTH_SECRET,
        env: { alertEmail: ALERT_ENV },
        log,
      });
      expect(await noPilotEnv.recipient()).toBe("ops@example.com");
      await world.db.setting.deleteMany({ where: { scope: "platform", key: "ops.alertEmail" } });
      expect(await noPilotEnv.recipient()).toBe(ALERT_ENV);
    });

    it("answers 503 and sends nothing when no address is configured anywhere", async () => {
      const bare = await testWorld(model.url, { PILOT_REQUEST_EMAIL: "", ALERT_EMAIL: "" });
      try {
        const res = await bare.app.inject({
          method: "POST",
          url: URL_,
          headers: { "x-forwarded-for": freshAddress() },
          payload: valid(),
        });
        expect(res.statusCode).toBe(503);
        expect(res.json().error.code).toBe("unavailable");
        expect(bare.email.sent).toHaveLength(0);
      } finally {
        await bare.close();
      }
    });
  });

  describe("the operator's setting", () => {
    it("is editable by the operator at platform scope, audited, and wins over the environment", async () => {
      const res = await world.app.inject({
        method: "PUT",
        url: "/api/v1/settings?scope=platform",
        headers: { authorization: `Bearer ${world.operatorToken}`, "x-company-id": world.companyId },
        payload: { values: { "sales.pilotRequestEmail": "from-admin@example.com" } },
      });
      expect(res.statusCode).toBe(200);
      const audit = await world.db.auditLog.findFirst({
        where: { action: "settings.update", targetType: "settings:platform" },
        orderBy: { createdAt: "desc" },
      });
      expect(JSON.stringify(audit?.diff)).toContain("sales.pilotRequestEmail");
      expect(JSON.stringify(audit?.diff)).not.toContain("from-admin@example.com");

      await post(valid());
      expect(world.email.sent[0]?.to).toBe("from-admin@example.com");
    });

    it("is listed in the operator's platform catalog and refused for a tenant admin", async () => {
      const read = await world.app.inject({
        method: "GET",
        url: "/api/v1/settings?scope=platform",
        headers: { authorization: `Bearer ${world.operatorToken}`, "x-company-id": world.companyId },
      });
      expect(read.statusCode).toBe(200);
      const catalog = read.json<{ catalog: { key: string; scopes: string[] }[] }>().catalog;
      expect(catalog.find((c) => c.key === "sales.pilotRequestEmail")?.scopes).toEqual(["platform"]);

      const denied = await world.app.inject({
        method: "PUT",
        url: "/api/v1/settings?scope=platform",
        headers: { authorization: `Bearer ${world.adminToken}` },
        payload: { values: { "sales.pilotRequestEmail": "tenant@example.com" } },
      });
      expect(denied.statusCode).toBe(403);
    });

    it("refuses a value that is not an email address", async () => {
      const res = await world.app.inject({
        method: "PUT",
        url: "/api/v1/settings?scope=platform",
        headers: { authorization: `Bearer ${world.operatorToken}`, "x-company-id": world.companyId },
        payload: { values: { "sales.pilotRequestEmail": "not an address" } },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("validation", () => {
    it.each(["name", "email", "company", "role", "companySize", "interest", "consent"])(
      "refuses a request without %s",
      async (field) => {
        const body = Object.fromEntries(Object.entries(valid()).filter(([k]) => k !== field));
        const res = await post(body);
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe("validation");
        expect(world.email.sent).toHaveLength(0);
      },
    );

    it("refuses a malformed email, consent other than true and an over-long message", async () => {
      expect((await post(valid({ email: "nope" }))).statusCode).toBe(400);
      expect((await post(valid({ consent: false }))).statusCode).toBe(400);
      expect((await post(valid({ message: "x".repeat(2001) }))).statusCode).toBe(400);
      expect(world.email.sent).toHaveLength(0);
    });

    it("refuses a body over the route's limit before reading it", async () => {
      const res = await post(valid({ message: "x".repeat(20_000) }));
      expect(res.statusCode).toBe(413);
    });
  });

  describe("header injection", () => {
    it("refuses CR/LF in the fields that become headers", async () => {
      for (const over of [
        { email: "a@example.com\r\nBcc: victim@example.com" },
        { company: "Acme\r\nBcc: victim@example.com" },
        { name: "Aino\nBcc: victim@example.com" },
      ]) {
        const res = await post(valid(over));
        expect(res.statusCode).toBe(400);
      }
      expect(world.email.sent).toHaveLength(0);
    });

    it("strips control characters at the place the header is made", () => {
      expect(headerSafe("Acme\r\nBcc: x@y.z")).toBe("Acme Bcc: x@y.z");
      expect(headerSafe("a b\u0000c")).toBe("a b c");
      expect(headerSafe("x".repeat(500)).length).toBe(200);
    });
  });

  describe("anti-abuse", () => {
    it("answers a filled honeypot as a success and sends nothing", async () => {
      const res = await post(valid({ website: "http://spam.example" }));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(world.email.sent).toHaveLength(0);
    });

    it("refuses a form sent faster than a person could fill it", async () => {
      const res = await post(valid({ ticket: ticketAged(500) }));
      expect(res.statusCode).toBe(400);
      expect(res.json().error.details).toEqual({ reason: "too_fast" });
      expect(world.email.sent).toHaveLength(0);
    });

    it("refuses a missing, forged or expired ticket", async () => {
      const forged = `${String(Date.now() - 10_000)}.${"A".repeat(43)}`;
      const expired = ticketAged(25 * 60 * 60 * 1000);
      for (const ticket of [undefined, "garbage", forged, expired]) {
        const res = await post(valid({ ticket }));
        expect(res.statusCode).toBe(400);
        expect(res.json().error.details).toEqual({ reason: "stale" });
      }
      expect(world.email.sent).toHaveLength(0);
    });

    it("issues a ticket the form can use once it has been open long enough", async () => {
      const res = await world.app.inject({
        method: "GET",
        url: `${URL_}/ticket`,
        headers: { "x-forwarded-for": freshAddress() },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      const { ticket } = res.json<{ ticket: string }>();
      expect(tickets.check(ticket, Date.now()).ok).toBe(false);
      expect(tickets.check(ticket, Date.now() + PILOT_MIN_FILL_MS + 100).ok).toBe(true);
    });

    it("lets one address send five an hour, then answers 429", async () => {
      const address = freshAddress();
      const codes: number[] = [];
      for (let i = 0; i < 7; i++) codes.push((await post(valid(), address)).statusCode);
      expect(codes).toEqual([200, 200, 200, 200, 200, 429, 429]);
      expect(world.email.sent).toHaveLength(5);
      // Another address is not affected.
      expect((await post(valid())).statusCode).toBe(200);
    });
  });

  it("answers 503 when the mail cannot be sent, so the visitor retries instead of losing the lead", async () => {
    vi.spyOn(world.email, "send").mockRejectedValueOnce(new Error("relay down"));
    const res = await post(valid());
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("unavailable");
  });
});
