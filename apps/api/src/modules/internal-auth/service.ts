import { createHash, timingSafeEqual } from "node:crypto";
import type { VerificationTokenDto, VerificationTokenLookup } from "@aidp/shared";
import type { PrismaClient } from "@prisma/client";

/**
 * The store behind Auth.js magic-link sign-in (D-56).
 *
 * It lives here rather than in the web app for two reasons: a file in one container's temp
 * directory loses the token on a restart and is invisible to a second web instance, and the web
 * app is not allowed to touch the database at all (spec 16, "Web app contract notes").
 *
 * What is stored is already a digest — Auth.js hashes the token with `AUTH_SECRET` before the
 * adapter ever sees it, and emails the plaintext. Nothing here hashes it again, and nothing here
 * logs it.
 */
export class VerificationTokenService {
  constructor(private readonly db: PrismaClient) {}

  /**
   * Records a pending token. Expired rows are swept on the way through: sign-in is the only
   * traffic this table sees, the delete is one indexed statement, and it keeps the table from
   * growing without a scheduled job. `POST .../prune` exists for an operator who wants it sooner.
   */
  async create(input: VerificationTokenDto): Promise<VerificationTokenDto> {
    await this.prune();
    const expires = new Date(input.expires);
    const row = await this.db.verificationToken.upsert({
      where: { identifier_token: { identifier: input.identifier, token: input.token } },
      create: { identifier: input.identifier, token: input.token, expires },
      update: { expires },
    });
    return view(row);
  }

  /**
   * Single use: the row is returned exactly once and gone afterwards. Expiry is deliberately not
   * checked — Auth.js compares `expires` itself and reports an expired link properly, so an
   * expired row is still consumed (and thereby removed) rather than left behind.
   *
   * The `deleteMany` count is the concurrency guard: two simultaneous clicks on the same link
   * both read the row, but only one of them deletes it, and only that one gets an answer.
   */
  async consume(lookup: VerificationTokenLookup): Promise<VerificationTokenDto | null> {
    const where = { identifier: lookup.identifier, token: lookup.token };
    const row = await this.db.verificationToken.findUnique({
      where: { identifier_token: where },
    });
    if (!row) return null;
    const { count } = await this.db.verificationToken.deleteMany({ where });
    if (count === 0) return null;
    return view(row);
  }

  /** Drops every token that is past its expiry. */
  async prune(now: Date = new Date()): Promise<number> {
    const { count } = await this.db.verificationToken.deleteMany({ where: { expires: { lt: now } } });
    return count;
  }
}

function view(row: { identifier: string; token: string; expires: Date }): VerificationTokenDto {
  return { identifier: row.identifier, token: row.token, expires: row.expires.toISOString() };
}

/**
 * Constant-time comparison of the presented shared secret against the configured one.
 *
 * `timingSafeEqual` throws on buffers of different lengths, and the length of the presented
 * header is itself something not worth leaking, so both sides are hashed to a fixed 32 bytes
 * first and the comparison always does the same amount of work.
 */
export function secretMatches(presented: string | undefined, expected: string): boolean {
  if (presented === undefined || presented.length === 0 || expected.length === 0) return false;
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}
