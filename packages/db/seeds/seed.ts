import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SEED_PRICES } from "@aidp/ai";
import { PrismaClient } from "@prisma/client";

const here = dirname(fileURLToPath(import.meta.url));

/** Loads platform-seeded templates (FR-65) and Anthropic seed prices when a platform Anthropic provider exists. */
export async function seed(db: PrismaClient): Promise<void> {
  const dir = join(here, "templates");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const t = JSON.parse(readFileSync(join(dir, file), "utf8"));
    const existing = await db.interviewTemplate.findFirst({
      where: { companyId: null, key: t.key, version: t.version },
    });
    const data = {
      companyId: null,
      key: t.key,
      version: t.version,
      name: t.name,
      objective: t.objective,
      privacyMode: t.privacyMode,
      participantFields: t.participantFields,
      coverageAreas: t.coverageAreas,
      aiInstructions: t.aiInstructions,
      adaptivity: t.adaptivity,
      outputs: t.outputs,
      analysisEnabled: t.analysisEnabled,
      chainToKey: t.chainToKey,
      chainMapping: t.chainMapping,
      status: "published",
    };
    if (existing) await db.interviewTemplate.update({ where: { id: existing.id }, data });
    else await db.interviewTemplate.create({ data });
  }

  const anthropic = await db.provider.findFirst({ where: { companyId: null, kind: "anthropic" } });
  if (anthropic) {
    for (const p of SEED_PRICES) {
      await db.modelPrice.upsert({
        where: { providerId_model: { providerId: anthropic.id, model: p.model } },
        create: { providerId: anthropic.id, ...p },
        update: {}, // never overwrite admin or provider prices
      });
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const db = new PrismaClient();
  seed(db)
    .then(() => {
      console.log("seeded");
    })
    .finally(() => db.$disconnect());
}
