import type { PrismaClient } from "@prisma/client";

/**
 * Tamper evidence for the audit log (A2, D-163).
 *
 * The database makes `AuditLog` append-only and chains each row to the one before it (migration
 * 0019). This reads the result: `audit_chain_verify()` recomputes every hash and reports each row
 * that does not follow from its predecessor, and `audit_chain_heads()` returns the newest hash per
 * tenant, which the verifier job writes to the log so that a copy exists outside the table. Run
 * in the system tenant context to see every tenant's chain; under a tenant context row-level
 * security narrows both to that tenant.
 */
export interface AuditChainProblem {
  companyId: string;
  seq: number;
  id: string;
  problem: string;
}

export interface AuditChainHead {
  companyId: string;
  seq: number;
  hash: string;
}

export interface AuditChainReport {
  problems: AuditChainProblem[];
  heads: AuditChainHead[];
}

export async function verifyAuditChain(db: PrismaClient, companyId?: string): Promise<AuditChainReport> {
  const problems = await db.$queryRaw<
    { company: string; seq: number; id: string; problem: string }[]
  >`SELECT company, seq, id, problem FROM audit_chain_verify(${companyId ?? null}::text)`;
  const heads = await db.$queryRaw<
    { company: string; seq: number; hash: string }[]
  >`SELECT company, seq, hash FROM audit_chain_heads()`;
  return {
    problems: problems.map((p) => ({ companyId: p.company, seq: p.seq, id: p.id, problem: p.problem })),
    heads: heads
      .filter((h) => companyId === undefined || h.company === companyId)
      .map((h) => ({ companyId: h.company, seq: h.seq, hash: h.hash })),
  };
}
