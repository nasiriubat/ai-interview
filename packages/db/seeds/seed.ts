import { fileURLToPath } from "node:url";
import { SEED_PRICES } from "@aidp/ai";
import { PrismaClient } from "@prisma/client";
import { shippedTemplates } from "../src/seed-templates/index.js";

/** Upserts platform templates and Anthropic seed prices when a platform Anthropic provider exists. */
export async function seed(db: PrismaClient): Promise<{ templates: number; prices: number }> {
  let templates = 0;
  for (const t of shippedTemplates()) {
    const data = {
      companyId: null,
      key: t.key,
      version: t.version,
      name: t.name,
      language: t.language,
      objective: t.objective,
      privacyMode: t.privacyMode,
      participantFields: t.participantFields,
      pathSelection: t.pathSelection,
      contextBlock: t.contextBlock,
      coverageAreas: t.coverageAreas,
      aiInstructions: t.aiInstructions,
      adaptivity: t.adaptivity,
      widgetPolicy: t.widgetPolicy,
      issueDetection: t.issueDetection,
      outputs: t.outputs,
      analysisEnabled: t.analysisEnabled,
      chainToKey: t.chainToKey,
      ...(t.chainMapping ? { chainMapping: t.chainMapping } : {}),
      closingQuestion: t.closingQuestion,
      endSummary: t.endSummary,
      maxTurns: t.maxTurns,
      maxAssistantChars: t.maxAssistantChars,
      status: "published",
    };
    const existing = await db.interviewTemplate.findFirst({
      where: { companyId: null, key: t.key, version: t.version },
    });
    if (existing) await db.interviewTemplate.update({ where: { id: existing.id }, data });
    else await db.interviewTemplate.create({ data });
    templates++;
  }

  let prices = 0;
  const anthropic = await db.provider.findFirst({ where: { companyId: null, kind: "anthropic" } });
  if (anthropic) {
    for (const p of SEED_PRICES) {
      await db.modelPrice.upsert({
        where: { providerId_model: { providerId: anthropic.id, model: p.model } },
        create: { providerId: anthropic.id, ...p },
        update: {}, // never overwrite admin or provider prices
      });
      prices++;
    }
  }
  return { templates, prices };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const db = new PrismaClient();
  seed(db)
    .then((r) => {
      console.log(`seeded ${r.templates} templates, ${r.prices} prices`);
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => void db.$disconnect());
}
