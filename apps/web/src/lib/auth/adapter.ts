import {
  INTERNAL_AUTH_HEADER,
  VerificationTokenResponseSchema,
  type VerificationTokenDto,
} from "@aidp/shared";
import { deriveInternalSecret } from "@aidp/shared/internal-secret";
import type {
  Adapter,
  AdapterAccount,
  AdapterSession,
  AdapterUser,
  VerificationToken,
} from "next-auth/adapters";
import { ApiError } from "../api/errors";
import { createTransport, request, type Transport } from "../api/http";
import { apiBaseUrl } from "@/lib/env";

/**
 * Verification tokens live in the API's database, reached through
 * `/internal/auth/verification-tokens` (D-56).
 *
 * They used to sit in a JSON file in this container's temp directory, which broke sign-in in two
 * ways: a restart between "email me a link" and clicking it lost the token, and a second web
 * instance never saw the token the first one wrote. A module-level map is not an option either —
 * the sign-in form creates the token in a server action and the callback consumes it in a route
 * handler, which Next bundles as separate module instances.
 *
 * The web app is not allowed to reach the database itself (spec 16, "Web app contract notes"), so
 * the store is an API route authenticated with the `AUTH_SECRET` both processes already share.
 * The token sent over it is already a hash: Auth.js hashes it with `AUTH_SECRET` before handing it
 * to the adapter and emails the plaintext, so nothing on this path hashes it a second time.
 */
function internalTransport(): Transport {
  // The derived credential, never AUTH_SECRET itself (D-260).
  const secret = deriveInternalSecret(process.env.AUTH_SECRET ?? "");
  return createTransport(apiBaseUrl(), () => ({ [INTERNAL_AUTH_HEADER]: secret }));
}

const TOKENS_PATH = "/internal/auth/verification-tokens";

function toAuthJs(dto: VerificationTokenDto): VerificationToken {
  return { identifier: dto.identifier, token: dto.token, expires: new Date(dto.expires) };
}

/**
 * A minimal adapter. Auth.js requires one for the email (magic link) provider to store
 * verification tokens; with the JWT session strategy nothing else is persisted, so users and
 * accounts stay in module memory and carry no role. Roles come from `GET /me` on the API, which
 * resolves the Auth.js JWT to `{ userId, companyId, role }`.
 *
 * `transport` is injectable so the token calls can be exercised without a running API.
 */
export function apiAdapter(transport: Transport = internalTransport()): Adapter {
  const users = new Map<string, AdapterUser>();
  const accounts = new Map<string, string>(); // `${provider}:${providerAccountId}` -> userId

  const byEmail = (email: string): AdapterUser | null =>
    [...users.values()].find((u) => u.email.toLowerCase() === email.toLowerCase()) ?? null;

  return {
    createUser: async (user) => {
      const created: AdapterUser = { ...user, id: user.id || crypto.randomUUID() };
      users.set(created.id, created);
      return created;
    },
    getUser: async (id) => users.get(id) ?? null,
    getUserByEmail: async (email) => byEmail(email),
    getUserByAccount: async ({ provider, providerAccountId }) => {
      const id = accounts.get(`${provider}:${providerAccountId}`);
      return id ? (users.get(id) ?? null) : null;
    },
    updateUser: async (user) => {
      const existing = users.get(user.id);
      const merged: AdapterUser = { ...(existing ?? { email: "", emailVerified: null }), ...user };
      users.set(user.id, merged);
      return merged;
    },
    deleteUser: async (id) => {
      users.delete(id);
    },
    linkAccount: async (account: AdapterAccount) => {
      accounts.set(`${account.provider}:${account.providerAccountId}`, account.userId);
      return account;
    },
    unlinkAccount: async ({ provider, providerAccountId }) => {
      accounts.delete(`${provider}:${providerAccountId}`);
    },
    // Sessions are JWTs; these exist only to satisfy the interface.
    createSession: async (session: AdapterSession) => session,
    getSessionAndUser: async () => null,
    updateSession: async () => null,
    deleteSession: async () => undefined,
    createVerificationToken: async (token) => {
      const { token: created } = await request(transport, {
        method: "POST",
        path: TOKENS_PATH,
        body: {
          identifier: token.identifier,
          token: token.token,
          expires: token.expires.toISOString(),
        },
        schema: VerificationTokenResponseSchema,
      });
      return toAuthJs(created);
    },
    useVerificationToken: async ({ identifier, token }) => {
      // The API enforces single use: the first consume returns the row and deletes it, every
      // later one answers 404, which Auth.js reads as an invalid link. Expiry stays Auth.js's
      // own check against the `expires` returned here.
      try {
        const { token: consumed } = await request(transport, {
          method: "POST",
          path: `${TOKENS_PATH}/consume`,
          body: { identifier, token },
          schema: VerificationTokenResponseSchema,
        });
        return toAuthJs(consumed);
      } catch (e) {
        if (e instanceof ApiError && e.isNotFound) return null;
        throw e;
      }
    },
  };
}
