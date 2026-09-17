import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  defaultAnthropicRoutes,
  defaultOpenAIRoutes,
  defaultOpenRouterRoutes,
  OpenAICompatibleProvider,
  PriceTable,
  SEED_PRICES,
} from "@aidp/ai";
import { Crypto } from "@aidp/core";
import type { Route } from "@aidp/shared";
import { PrismaClient } from "@prisma/client";
import { seed } from "./seed.js";

/**
 * First-run bootstrap. Idempotent. Creates:
 * - the platform operator company and user (BOOTSTRAP_OPERATOR_EMAIL)
 * - a first tenant with an admin (BOOTSTRAP_TENANT_NAME, BOOTSTRAP_ADMIN_EMAIL)
 * - a platform Anthropic provider from ANTHROPIC_API_KEY with seed prices and default routes
 * - a platform OpenRouter provider from OPENROUTER_API_KEY with published prices and default routes
 *   (used only for purposes that have no route yet, so Anthropic wins when both keys are set)
 * - a platform OpenAI provider from OPENAI_API_KEY for the three purposes neither of the others
 *   can serve: transcription, speech and embeddings
 * - the shipped templates
 */
export async function bootstrap(db: PrismaClient, env: NodeJS.ProcessEnv): Promise<void> {
  const operatorEmail = env.BOOTSTRAP_OPERATOR_EMAIL?.toLowerCase();
  const adminEmail = env.BOOTSTRAP_ADMIN_EMAIL?.toLowerCase();
  const tenantName = env.BOOTSTRAP_TENANT_NAME ?? "First tenant";
  if (!operatorEmail || !adminEmail)
    throw new Error("BOOTSTRAP_OPERATOR_EMAIL and BOOTSTRAP_ADMIN_EMAIL are required");
  const key = env.PLATFORM_ENCRYPTION_KEY;
  if (!key) throw new Error("PLATFORM_ENCRYPTION_KEY is required (openssl rand -base64 32)");
  const crypto = new Crypto(key);

  // Give the unprivileged runtime role a login, so the API and worker can connect as `app_api`
  // and the row-level security policies actually apply (migration 0008). Without a password the
  // role stays NOLOGIN and a deployment silently keeps running as the owner, fence down.
  if (env.APP_DB_PASSWORD) {
    await db.$executeRawUnsafe(`ALTER ROLE app_api WITH LOGIN PASSWORD ${quoteLiteral(env.APP_DB_PASSWORD)}`);
    console.log("bootstrap: app_api may now log in; point DATABASE_URL at it for the API and worker");
  }

  const platform =
    (await db.company.findFirst({ where: { name: "Platform" } })) ??
    (await db.company.create({ data: { name: "Platform" } }));
  await db.user.upsert({
    where: { companyId_email: { companyId: platform.id, email: operatorEmail } },
    create: { companyId: platform.id, email: operatorEmail, role: "platform_operator" },
    update: {},
  });

  const tenant =
    (await db.company.findFirst({ where: { name: tenantName } })) ??
    (await db.company.create({ data: { name: tenantName, monthlyBudgetCents: 20_000 } }));
  await db.user.upsert({
    where: { companyId_email: { companyId: tenant.id, email: adminEmail } },
    create: { companyId: tenant.id, email: adminEmail, role: "admin" },
    update: {},
  });
  await db.budget.upsert({
    where: { scope_scopeId: { scope: "tenant", scopeId: tenant.id } },
    create: {
      companyId: tenant.id,
      scope: "tenant",
      scopeId: tenant.id,
      limitCents: tenant.monthlyBudgetCents,
      period: "month",
    },
    update: {},
  });

  const providers: string[] = [];
  if (env.ANTHROPIC_API_KEY) {
    const provider =
      (await db.provider.findFirst({ where: { companyId: null, kind: "anthropic" } })) ??
      (await db.provider.create({
        data: {
          companyId: null,
          kind: "anthropic",
          name: "Anthropic (platform)",
          apiKeyEnc: crypto.encrypt(env.ANTHROPIC_API_KEY),
          headers: {},
        },
      }));
    for (const p of SEED_PRICES) {
      await db.modelPrice.upsert({
        where: { providerId_model: { providerId: provider.id, model: p.model } },
        create: { providerId: provider.id, ...p },
        update: {},
      });
    }
    await createMissingRoutes(db, defaultAnthropicRoutes(provider.id));
    providers.push("Anthropic");
  }

  if (env.OPENROUTER_API_KEY) {
    const provider =
      (await db.provider.findFirst({ where: { companyId: null, kind: "openrouter" } })) ??
      (await db.provider.create({
        data: {
          companyId: null,
          kind: "openrouter",
          name: "OpenRouter (platform)",
          apiKeyEnc: crypto.encrypt(env.OPENROUTER_API_KEY),
          headers: {},
        },
      }));
    // Prices come from OpenRouter's model list; a network failure here only skips the import.
    try {
      const adapter = new OpenAICompatibleProvider({
        id: provider.id,
        kind: "openrouter",
        apiKey: env.OPENROUTER_API_KEY,
      });
      const table = new PriceTable();
      table.importFromModels(provider.id, await adapter.listModels());
      for (const r of defaultOpenRouterRoutes(provider.id)) {
        const price = table.get(provider.id, r.model);
        if (!price) continue;
        await db.modelPrice.upsert({
          where: { providerId_model: { providerId: provider.id, model: r.model } },
          create: price,
          update: {},
        });
      }
    } catch (err) {
      console.warn(
        `bootstrap: could not import OpenRouter prices: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await createMissingRoutes(db, defaultOpenRouterRoutes(provider.id));
    providers.push("OpenRouter");
  }

  /**
   * OpenAI last, and only for what the others cannot do.
   *
   * Anthropic has no audio or embedding endpoints and OpenRouter proxies chat models only, so
   * without this a deployment has an interview that works and a voice that does not, and clustering
   * that falls back to word overlap. One key closes all three. It runs last so it never takes a
   * conversation purpose from a provider the operator chose deliberately.
   */
  if (env.OPENAI_API_KEY) {
    const provider =
      (await db.provider.findFirst({ where: { companyId: null, kind: "openai" } })) ??
      (await db.provider.create({
        data: {
          companyId: null,
          kind: "openai",
          name: "OpenAI (platform)",
          apiKeyEnc: crypto.encrypt(env.OPENAI_API_KEY),
          headers: {},
        },
      }));
    await createMissingRoutes(db, defaultOpenAIRoutes(provider.id));
    providers.push("OpenAI");
  }

  const seeded = await seed(db);
  console.log(
    `bootstrap: operator ${operatorEmail}, tenant "${tenantName}" admin ${adminEmail}, templates ${seeded.templates}${providers.length ? `, ${providers.join(" and ")} provider with default routes` : ", no provider (set ANTHROPIC_API_KEY, OPENROUTER_API_KEY or OPENAI_API_KEY, or add one in the admin UI)"}`,
  );
  if (!env.PLATFORM_ENCRYPTION_KEY) console.log(`generated key: ${randomBytes(32).toString("base64")}`);
}

/** Postgres string literal: a password is not a bind parameter in ALTER ROLE. */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Platform routes are created only for purposes that have none, so an earlier provider keeps its rows. */
async function createMissingRoutes(db: PrismaClient, routes: Route[]): Promise<void> {
  for (const r of routes) {
    const existing = await db.route.findFirst({ where: { companyId: null, purpose: r.purpose } });
    if (existing) continue;
    await db.route.create({
      data: {
        companyId: null,
        purpose: r.purpose,
        providerId: r.providerId,
        model: r.model,
        effort: r.effort ?? null,
        maxOutputTokens: r.maxOutputTokens,
        batchAllowed: r.batchAllowed,
      },
    });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const db = new PrismaClient();
  bootstrap(db, process.env)
    .catch((err: unknown) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => void db.$disconnect());
}
