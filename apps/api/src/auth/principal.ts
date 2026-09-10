import type { Crypto } from "@aidp/core";
import { decode } from "@auth/core/jwt";
import type { PrismaClient } from "@prisma/client";

export type Role = "platform_operator" | "admin" | "member";

export type Principal =
  | { kind: "staff"; userId: string; companyId: string; role: Role; email: string }
  | { kind: "participant"; sessionId: string; companyId: string; participantId: string; campaignId: string }
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
        const user = await this.db.user.findFirst({
          where: { email: email.toLowerCase() },
          include: { company: true },
        });
        if (user?.company.status !== "active") return { kind: "anonymous" };
        return {
          kind: "staff",
          userId: user.id,
          companyId: user.companyId,
          role: user.role as Role,
          email: user.email,
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
      include: { sessions: { select: { id: true }, take: 1 } },
    });
    const session = p?.sessions[0];
    if (!p || !session) return { kind: "anonymous" };
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
  return cookies.aidp_participant
    ? `pt.${cookies.aidp_participant}`
    : (cookies["__Secure-authjs.session-token"] ?? cookies["authjs.session-token"]);
}
