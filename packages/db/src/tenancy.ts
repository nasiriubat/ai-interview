import { AsyncLocalStorage } from "node:async_hooks";
import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * The second tenancy fence (FR-01, NFR-03): Postgres row-level security, actually engaged.
 *
 * The application connects as `app_api`, which owns nothing and has no BYPASSRLS, so every
 * statement is filtered by the policies in migrations 0002 and 0008. Those policies compare
 * `companyId` against the `app.company_id` setting, which has to be set on the *same*
 * connection as the query. Prisma pools connections, so the only reliable way to pair them is
 * to send both in one transaction — the pattern Prisma documents for row-level security.
 *
 * Rather than make 166 call sites remember that, the pairing lives in a client extension and
 * the tenant travels in async context. A request sets it once; everything underneath inherits it.
 *
 * Two rules keep this honest:
 * - No context means no tenant, which the policies read as "platform rows only". It fails
 *   closed: a query that forgets to say who it is for returns nothing rather than everything.
 * - Inside an interactive transaction the extension steps aside, because the transaction has
 *   its own connection and sets the tenant itself (see `tenantTransaction`). Wrapping there
 *   would push the query onto a second connection and silently break atomicity.
 */

/** The escape hatch, for work that legitimately spans tenants or runs before one is known. */
export const SYSTEM_TENANT = "system";

interface TenantContext {
  /** A company id, `SYSTEM_TENANT`, or null for "no tenant, platform rows only". */
  companyId: string | null;
  /** True while an interactive transaction is already holding the connection. */
  inTransaction: boolean;
}

const storage = new AsyncLocalStorage<TenantContext>();

/**
 * One place where the tenant context is entered, so the callers all read the same.
 *
 * The result is awaited inside the context. Prisma's query promises are lazy: a callback that
 * returns `db.x.findMany(...)` without awaiting it hands back a query that only runs when the caller
 * awaits it, after this context has ended, so row-level security would see no tenant and return
 * nothing. Awaiting here makes `withSystemTenant(() => db.x.findMany(...))` safe at every call site.
 */
function runInContext<T>(context: TenantContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(context, async () => await fn());
}

export function currentTenant(): string | null {
  return storage.getStore()?.companyId ?? null;
}

/** Runs `fn` with every query underneath scoped to one company. */
export function withTenant<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
  return runInContext({ companyId, inTransaction: false }, fn);
}

/**
 * Runs `fn` with the policies stood down: the principal resolver before a tenant is known, a
 * platform operator acting across tenants, and first-run bootstrap. Every use is a deliberate
 * hole in the fence, so keep them few and greppable.
 */
export function withSystemTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runInContext({ companyId: SYSTEM_TENANT, inTransaction: false }, fn);
}

/**
 * Binds the tenant for the rest of the current async context, for hosts (Fastify hooks) that
 * cannot wrap the whole request in a callback.
 */
export function enterTenant(companyId: string): void {
  storage.enterWith({ companyId, inTransaction: false });
}

export function enterSystemTenant(): void {
  storage.enterWith({ companyId: SYSTEM_TENANT, inTransaction: false });
}

/**
 * An interactive transaction that carries the tenant. The setting is the first statement on the
 * transaction's own connection, and the extension stands down for its duration.
 */
export async function tenantTransaction<T>(
  db: PrismaClient,
  fn: (
    tx: Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">,
  ) => Promise<T>,
  /** Prisma's interactive-transaction limits, for work that legitimately outlasts the 5 s default. */
  options?: { maxWait?: number; timeout?: number },
): Promise<T> {
  const tenant = currentTenant();
  return db.$transaction(
    (tx) =>
      // The setting is issued from inside the in-transaction context, not before it. On a
      // tenant-scoped client the query extension wraps any statement it sees outside one in its own
      // transaction, which would put `set_config` on a different connection from the work that
      // follows and leave the policies reading no tenant at all.
      runInContext({ companyId: tenant, inTransaction: true }, async () => {
        if (tenant !== null) await setTenant(tx, tenant);
        return fn(tx);
      }),
    options,
  );
}

/**
 * The array form of a transaction, carrying the tenant. Prisma runs the whole array on one
 * connection, so the setting is prepended as the first statement and dropped from the results.
 * Typed like Prisma's own `$transaction` so the tuple of results survives.
 */
export async function tenantBatch<P extends Prisma.PrismaPromise<unknown>[]>(
  db: PrismaClient,
  operations: [...P],
): Promise<{ [K in keyof P]: Awaited<P[K]> }> {
  type Results = { [K in keyof P]: Awaited<P[K]> };
  const tenant = currentTenant();
  if (tenant === null) return db.$transaction(operations) as Promise<Results>;
  return runInContext({ companyId: tenant, inTransaction: true }, async (): Promise<Results> => {
    const results = await db.$transaction([
      db.$executeRawUnsafe("SELECT set_config('app.company_id', $1, TRUE)", tenant),
      ...operations,
    ]);
    return results.slice(1) as Results;
  });
}

interface RawCapable {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

async function setTenant(client: RawCapable, companyId: string): Promise<void> {
  // Parameterised: the value is a tenant id from the principal, never interpolated into SQL.
  await client.$executeRawUnsafe("SELECT set_config('app.company_id', $1, TRUE)", companyId);
}

/**
 * Pairs every query with the tenant setting, in one transaction so they share a connection.
 * Applied once where the client is constructed; call sites are unchanged.
 */
export function withTenantScope(base: PrismaClient): TenantPrismaClient {
  const scoped = base.$extends({
    query: {
      async $allOperations({ args, query }): Promise<unknown> {
        const store = storage.getStore();
        // No tenant, or a transaction already owns the connection: run the query as it is.
        if (store?.companyId == null || store.inTransaction) return (await query(args)) as unknown;
        const batch = base.$transaction.bind(base) as (ops: unknown[]) => Promise<unknown[]>;
        const results = await batch([
          base.$executeRawUnsafe("SELECT set_config('app.company_id', $1, TRUE)", store.companyId),
          query(args),
        ]);
        return results[1];
      },
    },
  });
  // The one place the extended client is given back its familiar shape. The extension only wraps
  // `query`; it adds no model, no method and no result field, so every call site type-checks
  // against `PrismaClient` exactly as before. Inference of `$extends` is too deep to name, which
  // is why this is a double cast, and why it is allow-listed (scripts/cast-allowlist.json).
  return scoped as unknown as TenantPrismaClient;
}

/**
 * The client every application process holds: a `PrismaClient` whose statements are paired with
 * the tenant setting that row-level security reads (see `withTenantScope`). Obtain one only from
 * `withTenantScope`; production entry points (API, worker) and integration tests do, so no
 * `as PrismaClient` is needed at the edges. Per-company filtering on top is `forCompany`.
 */
export type TenantPrismaClient = PrismaClient;
