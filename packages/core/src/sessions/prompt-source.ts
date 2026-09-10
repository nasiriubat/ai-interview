import { SHIPPED_PROMPTS, type PromptDefinition, type PromptSource } from "@aidp/ai";
import type { PrismaClient } from "@prisma/client";

/** Tenant prompt overrides with canaries; falls back to the shipped prompt (ADM prompts). */
export class PrismaPromptSource implements PromptSource {
  constructor(
    private readonly db: PrismaClient,
    private readonly random: () => number = Math.random,
  ) {}

  async get(companyId: string, key: string): Promise<PromptDefinition> {
    const shipped = SHIPPED_PROMPTS[key];
    if (!shipped) throw new Error(`Unknown prompt '${key}'`);
    const rows = await this.db.promptVersion.findMany({
      where: { key, OR: [{ companyId }, { companyId: null }], active: true },
      orderBy: { version: "desc" },
    });
    const tenant = rows.filter((r) => r.companyId === companyId);
    const platform = rows.filter((r) => r.companyId === null);
    const pick = (list: typeof rows): PromptDefinition | undefined => {
      const canary = list.find((r) => r.canaryShare > 0 && r.canaryShare < 1);
      if (canary && this.random() < canary.canaryShare)
        return { key, version: canary.version, body: canary.body };
      const stable = list.find((r) => r.canaryShare === 0 || r.canaryShare >= 1);
      return stable ? { key, version: stable.version, body: stable.body } : undefined;
    };
    return pick(tenant) ?? pick(platform) ?? shipped;
  }
}
