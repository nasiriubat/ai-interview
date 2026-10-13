import { withSystemTenant } from "@aidp/db";
import type { PrismaClient } from "@prisma/client";

/**
 * Whether a tenant is allowed to do anything (S8, D-86).
 *
 * The operator can set `Company.status` to `suspended`. Staff were already refused at sign-in; the
 * gaps were the participant surfaces (link open, tokens already issued, the live-voice socket),
 * background jobs, and outgoing email. One gate answers all of them, so "suspended" means the
 * same thing in every process.
 *
 * Answers are cached for a short time because the participant principal resolver asks on every
 * request. The cache is per process: the operator's PATCH invalidates it in the API process that
 * served it, and the worker and other replicas catch up within `ttlMs`. A suspension is therefore
 * effective everywhere within that bound, not instantly, and the bound is small on purpose.
 */
export type TenantState = "active" | "suspended" | "missing";

export class TenantSuspendedError extends Error {
  constructor(readonly companyId: string) {
    super("tenant_suspended");
    this.name = "TenantSuspendedError";
  }
}

export interface TenantGateOptions {
  ttlMs?: number;
  now?: () => number;
}

export const TENANT_GATE_TTL_MS = 15_000;

export class TenantGate {
  private readonly cache = new Map<string, { state: TenantState; at: number }>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly db: Pick<PrismaClient, "company">,
    options: TenantGateOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? TENANT_GATE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  async state(companyId: string): Promise<TenantState> {
    const hit = this.cache.get(companyId);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.state;
    // The status of a tenant is read across the fence on purpose: the caller may be a participant
    // or a job whose own tenant context is the thing being checked.
    // Awaited inside the callback: a Prisma query is lazy, and one returned un-awaited would run
    // after the scope has been left, as no tenant at all.
    const row = await withSystemTenant(async () => {
      const found = await this.db.company.findUnique({ where: { id: companyId }, select: { status: true } });
      return found;
    });
    const state: TenantState = !row ? "missing" : row.status === "active" ? "active" : "suspended";
    this.cache.set(companyId, { state, at: this.now() });
    return state;
  }

  /** True only for an existing, active tenant. */
  async isActive(companyId: string): Promise<boolean> {
    return (await this.state(companyId)) === "active";
  }

  async assertActive(companyId: string): Promise<void> {
    if (!(await this.isActive(companyId))) throw new TenantSuspendedError(companyId);
  }

  /** Called by the operator's status change so this process sees it at once. */
  invalidate(companyId?: string): void {
    if (companyId === undefined) this.cache.clear();
    else this.cache.delete(companyId);
  }
}
