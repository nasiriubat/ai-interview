import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  Adapter,
  AdapterAccount,
  AdapterSession,
  AdapterUser,
  VerificationToken,
} from "next-auth/adapters";

/**
 * Verification tokens live in a small JSON file, not in module memory: the sign-in form
 * creates the token inside a server action and the magic-link callback consumes it in a
 * route handler, which Next bundles as separate module instances, so an in-memory map
 * never sees its own token. One file per instance is enough for a single web container;
 * a shared store (the API) is needed for more than one.
 */
const TOKEN_STORE = process.env.AUTH_TOKEN_STORE ?? join(tmpdir(), "aidp-auth-tokens.json");
interface StoredToken {
  identifier: string;
  token: string;
  expires: string;
}

function readTokens(): Record<string, StoredToken> {
  try {
    return JSON.parse(readFileSync(TOKEN_STORE, "utf8")) as Record<string, StoredToken>;
  } catch {
    return {};
  }
}

function writeTokens(tokens: Record<string, StoredToken>): void {
  const now = Date.now();
  const live = Object.fromEntries(
    Object.entries(tokens).filter(([, t]) => new Date(t.expires).getTime() > now),
  );
  mkdirSync(dirname(TOKEN_STORE), { recursive: true });
  const tmp = `${TOKEN_STORE}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(live));
  renameSync(tmp, TOKEN_STORE);
}

/**
 * A minimal adapter. Auth.js requires an adapter for the email (magic link) provider to
 * store verification tokens; with the JWT session strategy nothing else is persisted.
 * Users are keyed by email and carry no role: roles come from `GET /me` on the API, which
 * resolves the Auth.js JWT to `{ userId, companyId, role }`.
 */
export function memoryAdapter(): Adapter {
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
      const tokens = readTokens();
      tokens[`${token.identifier}:${token.token}`] = {
        identifier: token.identifier,
        token: token.token,
        expires: token.expires.toISOString(),
      };
      writeTokens(tokens);
      return token;
    },
    useVerificationToken: async ({ identifier, token }) => {
      const key = `${identifier}:${token}`;
      const tokens = readTokens();
      const found = tokens[key];
      if (!found) return null;
      writeTokens(Object.fromEntries(Object.entries(tokens).filter(([k]) => k !== key)));
      const result: VerificationToken = {
        identifier: found.identifier,
        token: found.token,
        expires: new Date(found.expires),
      };
      return result;
    },
  };
}
