import type { Crypto, TenantGate } from "@aidp/core";
import { decode } from "@auth/core/jwt";
import type { PrismaClient } from "@prisma/client";

export type Role = "platform_operator" | "admin" | "member";

export type Principal =
  | {
      kind: "staff";
      userId: string;
      companyId: string;
      role: Role;
      email: string;
      /**
       * The organization is suspended. The principal is still resolved, so the guard can answer 403
       * `tenant_suspended` and `GET /me` can say why, instead of an anonymous 401 that sends the
       * person round the sign-in loop. The platform operator is never suspended.
       */
      suspended: boolean;
    }
  | {
      kind: "participant";
      sessionId: string;
      companyId: string;
      participantId: string;
      /** null for a person invited into a requirements session or previewing a template. */
      campaignId: string | null;
    }
  | { kind: "anonymous" };

const AUTHJS_SALTS = ["authjs.session-token", "__Secure-authjs.session-token"];

/**
 * Resolves who is calling. Staff present the Auth.js session JWT issued by the web app
 * (same AUTH_SECRET); participants present a `pt.` token issued by the participant flow.
 */
export class PrincipalResolver {
  constructor(
    private readonly db: PrismaClient,
    private readonly crypto: Crypto,
    private readonly authSecret: string,
    private readonly tenants: TenantGate,
  ) {}

  async fromBearer(token: string | undefined): Promise<Principal> {
    if (!token) return { kind: "anonymous" };
    if (token.startsWith("pt.")) return this.participant(token.slice(3));
    return this.staff(token);
  }

  private async staff(token: string): Promise<Principal> {
    for (const salt of AUTHJS_SALTS) {
      try {
        const jwt = await decode({ token, secret: this.authSecret, salt });
        const email = typeof jwt?.email === "string" ? jwt.email : undefined;
        if (!email) continue;
        // `User.email` is globally unique and lower-case (D-84), so this is one row or none; there
        // is no ordering to get wrong and no way for a second tenant to answer to the address.
        const user = await this.db.user.findUnique({
          where: { email: email.toLowerCase() },
          include: { company: true },
        });
        if (!user) return { kind: "anonymous" };
        // Withdrawn access is immediate (D-161): the resolver reads the row on every request, so
        // a 30-day JWT cannot outlive the decision. A token issued before the revocation
        // watermark is refused even after the user is re-enabled; they sign in again.
        if (user.disabledAt) return { kind: "anonymous" };
        if (user.tokensValidAfter) {
          const issuedAt = typeof jwt?.iat === "number" ? jwt.iat * 1000 : 0;
          if (issuedAt < user.tokensValidAfter.getTime()) return { kind: "anonymous" };
        }
        return {
          kind: "staff",
          userId: user.id,
          companyId: user.companyId,
          role: user.role as Role,
          email: user.email,
          suspended: user.role !== "platform_operator" && user.company.status !== "active",
        };
      } catch {
        // try the next salt
      }
    }
    return { kind: "anonymous" };
  }

  private async participant(token: string): Promise<Principal> {
    const p = await this.db.participant.findUnique({
      where: { tokenHash: this.crypto.hashToken(token) },
      include: { sessions: { select: { id: true, status: true }, take: 1 } },
    });
    const session = p?.sessions[0];
    if (!p || !session) return { kind: "anonymous" };
    // A deleted session has no participant left to answer to (the row is erased with it), and a
    // token that somehow outlives that is refused here as well: two layers, one answer (S3).
    if (session.status === "deleted") return { kind: "anonymous" };
    // A suspended tenant's participants are told nothing more than a stranger is (S8).
    if (!(await this.tenants.isActive(p.companyId))) return { kind: "anonymous" };
    return {
      kind: "participant",
      sessionId: session.id,
      companyId: p.companyId,
      participantId: p.id,
      campaignId: p.campaignId,
    };
  }
}

export function bearerFrom(
  header: string | undefined,
  cookies: Record<string, string | undefined>,
): string | undefined {
  if (header?.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  // The participant credential: the `__Host-` cookie the web app sets in production (D-263), or the
  // bare name it set before that and still sets in development.
  const participantCookie = cookies["__Host-aidp_participant"] ?? cookies.aidp_participant;
  return participantCookie
    ? `pt.${participantCookie}`
    : (cookies["__Secure-authjs.session-token"] ?? cookies["authjs.session-token"]);
}
