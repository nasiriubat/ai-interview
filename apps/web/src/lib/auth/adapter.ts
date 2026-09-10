import type {
  Adapter,
  AdapterAccount,
  AdapterSession,
  AdapterUser,
  VerificationToken,
} from "next-auth/adapters";

/**
 * A minimal in-memory adapter. Auth.js requires an adapter for the email (magic link)
 * provider to store verification tokens; with the JWT session strategy nothing else is
 * persisted. Users are keyed by email and carry no role: roles come from `GET /me` on the
 * API, which resolves the Auth.js JWT to `{ userId, companyId, role }`.
 *
 * Contract gap: the API exposes no verification-token storage, so tokens live in this
 * process. Fine for a single web instance; a shared store is needed for more.
 */
export function memoryAdapter(): Adapter {
  const users = new Map<string, AdapterUser>();
  const accounts = new Map<string, string>(); // `${provider}:${providerAccountId}` -> userId
  const tokens = new Map<string, VerificationToken>(); // `${identifier}:${token}`

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
      tokens.set(`${token.identifier}:${token.token}`, token);
      return token;
    },
    useVerificationToken: async ({ identifier, token }) => {
      const key = `${identifier}:${token}`;
      const found = tokens.get(key) ?? null;
      tokens.delete(key);
      return found;
    },
  };
}
