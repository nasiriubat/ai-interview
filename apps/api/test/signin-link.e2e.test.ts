import type { Server } from "node:http";
import { describeDb } from "@aidp/testing";
import { Auth, type AuthConfig } from "@auth/core";
import type { Adapter, AdapterUser } from "@auth/core/adapters";
import { decode } from "@auth/core/jwt";
import type { EmailConfig } from "@auth/core/providers/email";
import { afterAll, beforeAll, expect, it } from "vitest";
import { VerificationTokenService } from "../src/modules/internal-auth/service.js";
import {
  hashVerificationToken,
  issueSigninLink,
  normalizeEmail,
  SIGNIN_LINK_AUDIT_ACTION,
  SIGNIN_LINK_TTL_MS,
} from "../src/modules/internal-auth/signin-link.js";
import { fakeModelServer, TEST_AUTH_SECRET, testWorld, type TestWorld } from "./helpers.js";

const WEB = "http://localhost:3000";

/**
 * The break-glass sign-in link (D-440 to D-444), held to the real thing: the link is opened against
 * `@auth/core` itself, configured the way the web app configures it (JWT sessions, the `nodemailer`
 * email provider, the `/api/auth` base path, `AUTH_SECRET`), with an adapter whose token methods are
 * the same service the web reaches over `/internal/auth/verification-tokens`. So "it signs in" means
 * Auth.js accepted the hash and the identifier, not that this file agrees with itself.
 */
describeDb("break-glass sign-in link (D-440)", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };

  beforeAll(async () => {
    model = await fakeModelServer(() => "ready");
    world = await testWorld(model.url);
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  /** The web app's Auth.js, minus mail. Users live in memory, as in apps/web/src/lib/auth/adapter.ts. */
  function webAuth(): AuthConfig {
    const tokens = new VerificationTokenService(world.ctx.db);
    const users = new Map<string, AdapterUser>();
    const adapter: Adapter = {
      createUser: async (user) => {
        const created = { ...user, id: user.id || crypto.randomUUID() };
        users.set(created.id, created);
        return created;
      },
      getUser: async (id) => users.get(id) ?? null,
      getUserByEmail: async (email) => [...users.values()].find((u) => u.email === email) ?? null,
      getUserByAccount: async () => null,
      updateUser: async (user) => {
        const merged = { ...(users.get(user.id) ?? { email: "", emailVerified: null }), ...user };
        users.set(user.id, merged);
        return merged;
      },
      linkAccount: async (account) => account,
      createVerificationToken: async (t) => {
        const row = await tokens.create({ ...t, expires: t.expires.toISOString() });
        return { ...row, expires: new Date(row.expires) };
      },
      useVerificationToken: async ({ identifier, token }) => {
        const row = await tokens.consume({ identifier, token });
        return row ? { ...row, expires: new Date(row.expires) } : null;
      },
    };
    const email: EmailConfig = {
      id: "nodemailer",
      type: "email",
      name: "Email",
      maxAge: 24 * 60 * 60,
      // Never called: the callback route does not send mail, and that is the only route opened here.
      sendVerificationRequest: () => Promise.resolve(),
      options: {},
    };
    return {
      secret: TEST_AUTH_SECRET,
      basePath: "/api/auth",
      trustHost: true,
      session: { strategy: "jwt" },
      providers: [email],
      adapter,
    };
  }

  async function open(url: string): Promise<{ location: string; sessionCookie: string | null }> {
    const res = await Auth(new Request(url), webAuth());
    const cookies = res.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith("authjs.session-token="));
    return {
      location: res.headers.get("location") ?? "",
      sessionCookie: session ? (session.split(";")[0]?.split("=").slice(1).join("=") ?? null) : null,
    };
  }

  const issue = (email: string, extra: { now?: Date } = {}) =>
    issueSigninLink(world.ctx.db, { email, authSecret: TEST_AUTH_SECRET, webUrl: WEB, ...extra });

  async function newUser(
    role: "admin" | "member",
    opts: { disabled?: boolean; suspended?: boolean } = {},
  ): Promise<{ id: string; email: string }> {
    const suffix = Math.random().toString(36).slice(2);
    const companyId = opts.suspended
      ? (await world.db.company.create({ data: { name: `Suspended ${suffix}`, status: "suspended" } })).id
      : world.companyId;
    const user = await world.db.user.create({
      data: {
        companyId,
        email: `${role}-${suffix}@signin-link.test`,
        role,
        ...(opts.disabled ? { disabledAt: new Date() } : {}),
      },
    });
    return { id: user.id, email: user.email };
  }

  it("signs the user in exactly once, as Auth.js would after an emailed link", async () => {
    const result = await issue(world.adminEmail);
    if (!result.ok) throw new Error(`refused: ${result.reason}`);
    const url = new URL(result.url);
    expect(url.origin).toBe(WEB);
    expect(url.pathname).toBe("/api/auth/callback/nodemailer");
    expect(url.searchParams.get("email")).toBe(world.adminEmail);
    expect(url.searchParams.get("callbackUrl")).toBe(`${WEB}/admin`);
    // 15 minutes, not Auth.js's day.
    expect(result.expires.getTime() - Date.now()).toBeLessThanOrEqual(SIGNIN_LINK_TTL_MS);
    expect(result.expires.getTime() - Date.now()).toBeGreaterThan(SIGNIN_LINK_TTL_MS - 60_000);

    // Only the digest is stored, the same digest Auth.js computes from the link.
    const token = url.searchParams.get("token") ?? "";
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const row = await world.db.verificationToken.findUniqueOrThrow({
      where: {
        identifier_token: {
          identifier: world.adminEmail,
          token: hashVerificationToken(token, TEST_AUTH_SECRET),
        },
      },
    });
    expect(row.token).not.toBe(token);

    const first = await open(result.url);
    expect(first.location).toBe(`${WEB}/admin`);
    expect(first.sessionCookie).toBeTruthy();
    const jwt = await decode({
      token: first.sessionCookie ?? "",
      secret: TEST_AUTH_SECRET,
      salt: "authjs.session-token",
    });
    expect(jwt?.email).toBe(world.adminEmail);

    // The callback consumed it: the row is gone, and the same link is now an invalid link.
    expect(
      await world.db.verificationToken.count({ where: { identifier: world.adminEmail, token: row.token } }),
    ).toBe(0);
    const second = await open(result.url);
    expect(second.sessionCookie).toBeNull();
    expect(second.location).toContain("error=Verification");
  });

  it("works for the platform operator, whose company status is never in question", async () => {
    const result = await issue(world.operatorEmail.toUpperCase());
    expect(result.ok).toBe(true);
    if (result.ok) expect((await open(result.url)).sessionCookie).toBeTruthy();
  });

  it("expires after 15 minutes", async () => {
    const result = await issue(world.adminEmail, { now: new Date(Date.now() - SIGNIN_LINK_TTL_MS - 1000) });
    if (!result.ok) throw new Error(`refused: ${result.reason}`);
    const opened = await open(result.url);
    expect(opened.sessionCookie).toBeNull();
    expect(opened.location).toContain("error=Verification");
  });

  it("refuses unknown, disabled and suspended users, and stores nothing for them", async () => {
    const before = await world.db.verificationToken.count();
    const disabled = await newUser("member", { disabled: true });
    const suspended = await newUser("admin", { suspended: true });

    expect(await issue("nobody@signin-link.test")).toEqual({ ok: false, reason: "unknown_user" });
    expect(await issue(disabled.email)).toEqual({ ok: false, reason: "user_disabled" });
    expect(await issue(suspended.email)).toEqual({ ok: false, reason: "tenant_suspended" });
    expect(await issue("not-an-address")).toEqual({ ok: false, reason: "invalid_email" });
    expect(await issue('"x"@signin-link.test')).toEqual({ ok: false, reason: "invalid_email" });

    expect(await world.db.verificationToken.count()).toBe(before);
    const audits = await world.db.auditLog.count({
      where: { action: SIGNIN_LINK_AUDIT_ACTION, targetId: { in: [disabled.id, suspended.id] } },
    });
    expect(audits).toBe(0);
  });

  it("writes the audit row in the user's tenant, actor cli, and never the token", async () => {
    const member = await newUser("member");
    const result = await issue(member.email);
    if (!result.ok) throw new Error(`refused: ${result.reason}`);
    const token = new URL(result.url).searchParams.get("token") ?? "";

    const rows = await world.db.auditLog.findMany({
      where: { action: SIGNIN_LINK_AUDIT_ACTION, targetId: member.id },
    });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({ companyId: world.companyId, actorId: "cli", targetType: "user" });
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(hashVerificationToken(token, TEST_AUTH_SECRET));
  });

  it("spells the address the way Auth.js's normalizer does", () => {
    expect(normalizeEmail("  Admin@Example.COM ")).toBe("admin@example.com");
    expect(normalizeEmail("a@example.com,evil.test")).toBe("a@example.com");
    expect(normalizeEmail("a@b@c")).toBeNull();
    expect(normalizeEmail("a＠example.com")).toBe("a@example.com");
  });
});
