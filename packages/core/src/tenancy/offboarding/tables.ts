import type { PrismaClient } from "@prisma/client";

/**
 * Which tables hold a tenant's rows, and in what order they can be emptied (D-226).
 *
 * Read from the database, not listed by hand: a table added next month that carries a `companyId`
 * is exported and purged without anyone remembering to add it here, and a hand-kept list is how a
 * purge ends up leaving rows behind. The ordering comes from the foreign keys between those
 * tables, children before parents.
 */

/** Tables that carry a company but are not erased with the tenant, and why. */
export const RETAINED_TABLES: Readonly<Record<string, string>> = {
  ErasureLedger:
    "The record of what was erased: ids only, and the whole point is that it outlives the erasure.",
  TenantStatement:
    "The frozen monthly statements are the invoicing record: aggregates by provider, model and purpose, no personal data, kept for accounting.",
};

/** Handled by a dedicated step rather than a plain DELETE. */
export const SPECIAL_TABLES: Readonly<Record<string, string>> = {
  AuditLog:
    "Append-only and hash-chained: removed only through audit_purge_tenant(), which refuses a tenant that is not offboarding.",
};

/** Columns never written to an export: sealed secrets and hashes mean nothing to the tenant and are sensitive. */
export const EXPORT_OMIT_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  Provider: ["apiKeyEnc", "headersEnc", "headers"],
  Participant: ["tokenHash"],
  Campaign: ["linkTokenHash"],
  CampaignEmailHash: ["emailHash", "resumeSeal", "ownerTag"],
  EmailCode: ["emailHash", "codeHash"],
  Invitation: ["emailHash", "tokenHash"],
  // The platform's own source paths and frames: what failed is the tenant's, how the code is laid out is not (D-477).
  ErrorOccurrence: ["stack"],
};

export interface TenantTables {
  /** Every table with a `companyId` column, children before parents. */
  ordered: string[];
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A table or column name taken from the catalogue and checked, since it is spliced into SQL. */
export function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`Unexpected identifier from the catalogue: ${name}`);
  return `"${name}"`;
}

export async function tenantTables(db: Pick<PrismaClient, "$queryRawUnsafe">): Promise<TenantTables> {
  const cols = await db.$queryRawUnsafe<{ table_name: string }[]>(
    `SELECT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND c.column_name = 'companyId' AND t.table_type = 'BASE TABLE'`,
  );
  const names = new Set(cols.map((c) => c.table_name));
  const fks = await db.$queryRawUnsafe<{ child: string; parent: string }[]>(
    `SELECT cl.relname AS child, pl.relname AS parent
       FROM pg_constraint con
       JOIN pg_class cl ON cl.oid = con.conrelid
       JOIN pg_class pl ON pl.oid = con.confrelid
       JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE con.contype = 'f' AND n.nspname = 'public'`,
  );
  // parent -> children, among tenant tables only, ignoring self references.
  const children = new Map<string, Set<string>>();
  for (const f of fks) {
    if (!names.has(f.child) || !names.has(f.parent) || f.child === f.parent) continue;
    const set = children.get(f.parent) ?? new Set<string>();
    set.add(f.child);
    children.set(f.parent, set);
  }
  // Post-order depth-first: every child is emitted before its parent.
  const out: string[] = [];
  const state = new Map<string, 1 | 2>();
  const visit = (t: string): void => {
    if (state.get(t) === 2) return;
    if (state.get(t) === 1) return; // a cycle between tenant tables: leave it to the order found
    state.set(t, 1);
    for (const c of [...(children.get(t) ?? [])].sort()) visit(c);
    state.set(t, 2);
    out.push(t);
  };
  for (const t of [...names].sort()) visit(t);
  return { ordered: out };
}
