import { createHash, randomBytes } from "node:crypto";
import { withSystemTenant, withTenant } from "@aidp/db";
import type { PrismaClient } from "@prisma/client";
import { audit } from "../../lib/audit.js";
import { VerificationTokenService } from "./service.js";

/**
 * The break-glass sign-in link (D-440 to D-444).
 *
 * A person with a shell on the server mints the same one-time link that Auth.js's email provider
 * would have mailed, for a staff user who already exists, and reads it off the terminal. It exists
 * for the morning the relay is wrong: a fresh install whose `EMAIL_SMTP_URL` was mistyped, or a
 * relay that is down while the only admin is signed out. Shell access to the server is already full
 * control (it reads `deploy/.env`, which holds `AUTH_SECRET`), so this adds no privilege; it only
 * saves that person from forging a token by hand.
 *
 * What it does is exactly what `@auth/core`'s `sendToken` does, minus the email:
 * - a 32-byte random token, hex, like Auth.js's `randomString(32)`;
 * - stored as `sha256(token + AUTH_SECRET)` in hex, in `VerificationToken`, through the same service
 *   the web adapter reaches over `/internal/auth/verification-tokens`, so the callback's
 *   `useVerificationToken` consumes it once and it is gone;
 * - a link to `<web>/api/auth/callback/nodemailer?callbackUrl&token&email`, which is the route the
 *   emailed link opens.
 * The only difference is the lifetime: 15 minutes, not Auth.js's 24 hours, because this link is
 * read off a screen and pasted, not sitting in the person's own mailbox.
 */

/** How long a break-glass link stays valid (D-441). */
export const SIGNIN_LINK_TTL_MS = 15 * 60 * 1000;

/** The audit action, written in the user's own tenant with the actor `cli` and no token (D-442). */
export const SIGNIN_LINK_AUDIT_ACTION = "auth.signin_link_issued";

/** The Auth.js email provider the web app configures (`next-auth/providers/nodemailer`). */
const EMAIL_PROVIDER_ID = "nodemailer";

/** next-auth's default base path; the web sets `AUTH_URL` to an origin with no path, which keeps it. */
const AUTH_BASE_PATH = "/api/auth";

/** Where a freshly signed-in staff member lands, the same default the sign-in page uses. */
const LANDING_PATH = "/admin";

const STAFF_ROLES: ReadonlySet<string> = new Set(["platform_operator", "admin", "member"]);

export type SigninLinkRefusal =
  | "invalid_email"
  | "unknown_user"
  | "not_staff"
  | "user_disabled"
  | "tenant_suspended";

export type SigninLinkResult =
  | { ok: true; url: string; expires: Date; userId: string; companyId: string; role: string }
  | { ok: false; reason: SigninLinkRefusal };

export interface SigninLinkInput {
  email: string;
  /** The web process's `AUTH_SECRET`; the API and the web are given the same value. */
  authSecret: string;
  /** The public origin of the web app (`PUBLIC_WEB_URL`). */
  webUrl: string;
  now?: Date;
  ttlMs?: number;
}

/** What each refusal means, for the person at the terminal. Never echoes anything secret. */
export const REFUSAL_TEXT: Readonly<Record<SigninLinkRefusal, string>> = {
  invalid_email: "That is not a valid email address.",
  unknown_user:
    "No staff user has that address. Only an existing user can be given a link; create users in the admin.",
  not_staff: "That address does not belong to a staff user (operator, admin or member).",
  user_disabled: "That user is disabled. Enable them in Users first, as another admin or the operator.",
  tenant_suspended:
    "That user's organization is suspended. The platform operator can reactivate it, or sign in as the operator.",
};

/**
 * The address the way Auth.js's default normalizer writes it (`@auth/core`, `defaultNormalizer`):
 * NFKC, lower-case, trimmed, no quotes, exactly one `@`, anything after a comma in the domain
 * dropped. The callback compares the link's `email` against the stored identifier, so the two have
 * to be spelled identically. Null when Auth.js itself would refuse the address.
 */
export function normalizeEmail(raw: string): string | null {
  const email = raw.normalize("NFKC").toLowerCase().trim();
  if (email.includes('"')) return null;
  const parts = email.split("@");
  if (parts.length !== 2) return null;
  const [local, rawDomain] = parts as [string, string];
  const domain = rawDomain.split(",")[0] ?? "";
  if (!local || !domain) return null;
  return `${local}@${domain}`;
}

/** Auth.js's `createHash(`${token}${secret}`)`: SHA-256, lower-case hex. */
export function hashVerificationToken(token: string, secret: string): string {
  return createHash("sha256").update(`${token}${secret}`, "utf8").digest("hex");
}

export async function issueSigninLink(db: PrismaClient, input: SigninLinkInput): Promise<SigninLinkResult> {
  const email = normalizeEmail(input.email);
  if (!email) return { ok: false, reason: "invalid_email" };

  // Before any tenant is known, like the principal resolver: one row by its unique address. The
  // `await` inside matters: a Prisma query is lazy, and one merely returned from the callback would
  // run after the tenant context has been left, where the policies show no users at all.
  const user = await withSystemTenant(
    async () =>
      await db.user.findUnique({ where: { email }, include: { company: { select: { status: true } } } }),
  );
  if (!user) return { ok: false, reason: "unknown_user" };
  if (!STAFF_ROLES.has(user.role)) return { ok: false, reason: "not_staff" };
  if (user.disabledAt) return { ok: false, reason: "user_disabled" };
  // The operator is never suspended (principal.ts); a tenant user of a suspended tenant would sign
  // in only to be told so, so they are refused here instead.
  if (user.role !== "platform_operator" && user.company.status !== "active") {
    return { ok: false, reason: "tenant_suspended" };
  }

  const now = input.now ?? new Date();
  const expires = new Date(now.getTime() + (input.ttlMs ?? SIGNIN_LINK_TTL_MS));
  const token = randomBytes(32).toString("hex");
  await new VerificationTokenService(db).create({
    identifier: email,
    token: hashVerificationToken(token, input.authSecret),
    expires: expires.toISOString(),
  });

  await withTenant(user.companyId, () =>
    audit(db, user.companyId, {
      actorId: "cli",
      action: SIGNIN_LINK_AUDIT_ACTION,
      targetType: "user",
      targetId: user.id,
      diff: { via: "signin-link", expires: expires.toISOString() },
    }),
  );

  const web = new URL(input.webUrl);
  const callback = new URL(`${AUTH_BASE_PATH}/callback/${EMAIL_PROVIDER_ID}`, web.origin);
  callback.search = new URLSearchParams({
    callbackUrl: new URL(LANDING_PATH, web.origin).toString(),
    token,
    email,
  }).toString();
  return {
    ok: true,
    url: callback.toString(),
    expires,
    userId: user.id,
    companyId: user.companyId,
    role: user.role,
  };
}
