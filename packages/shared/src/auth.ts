import { z } from "zod";

/**
 * Contracts for the API's internal verification-token routes (D-56).
 *
 * Magic-link sign-in needs a store that survives a restart and is shared by every web instance,
 * and the web app is not allowed to talk to the database (spec 16, "Web app contract notes"). So
 * the store lives in the API behind `/internal/auth/verification-tokens`, and the web adapter in
 * `apps/web/src/lib/auth/adapter.ts` is the only caller.
 *
 * These are not staff routes and must never be reachable with a session: they authenticate with
 * the shared `AUTH_SECRET` that both processes already hold, sent in this header and compared in
 * constant time.
 */
export const INTERNAL_AUTH_HEADER = "x-internal-auth";

/**
 * The `token` field is already a digest. Auth.js hashes the magic-link token with `AUTH_SECRET`
 * before handing it to the adapter: the plaintext travels in the email, the hash comes here and
 * is what gets stored. Nothing on this path may hash it a second time.
 */
export const VerificationTokenSchema = z.object({
  identifier: z.string().min(1).max(320),
  token: z.string().min(1).max(512),
  expires: z.iso.datetime(),
});
export type VerificationTokenDto = z.infer<typeof VerificationTokenSchema>;

/** Body of a create; also the shape returned by a create and a consume. */
export const VerificationTokenCreateSchema = VerificationTokenSchema;

/** Body of a consume: enough to find exactly one row, never the expiry. */
export const VerificationTokenLookupSchema = VerificationTokenSchema.pick({
  identifier: true,
  token: true,
});
export type VerificationTokenLookup = z.infer<typeof VerificationTokenLookupSchema>;

/** Response of a create and of a successful consume. A consume that finds nothing answers 404. */
export const VerificationTokenResponseSchema = z.object({ token: VerificationTokenSchema });

/** Response of a prune. */
export const VerificationTokenPruneSchema = z.object({ deleted: z.number().int().min(0) });
export type VerificationTokenPruneResult = z.infer<typeof VerificationTokenPruneSchema>;
