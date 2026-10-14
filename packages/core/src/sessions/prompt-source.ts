import { pickFromRows, SHIPPED_PROMPTS, type PromptDefinition, type PromptSource } from "@aidp/ai";
import type { PrismaClient } from "@prisma/client";

/**
 * Tenant prompt overrides with canaries; falls back to the platform's, then to the shipped prompt
 * (FR-50, D-230).
 *
 * A canary is assigned from the sticky key (the session, or the campaign for analysis calls), so
 * one participant is interviewed with one prompt throughout. Callers with no key get a random
 * draw, which is only right for work that has no session.
 */
export class PrismaPromptSource implements PromptSource {
  constructor(
    private readonly db: PrismaClient,
    private readonly random: () => number = Math.random,
  ) {}

  async get(companyId: string, key: string, stickyKey?: string): Promise<PromptDefinition> {
    const shipped = SHIPPED_PROMPTS[key];
    if (!shipped) throw new Error(`Unknown prompt '${key}'`);
    const rows = await this.db.promptVersion.findMany({
      where: { key, OR: [{ companyId }, { companyId: null }], active: true },
      orderBy: { version: "desc" },
    });
    const tenant = rows.filter((r) => r.companyId === companyId);
    const platform = rows.filter((r) => r.companyId === null);
    return (
      pickFromRows(key, tenant, "tenant", stickyKey, this.random) ??
      pickFromRows(key, platform, "platform", stickyKey, this.random) ??
      shipped
    );
  }
}
