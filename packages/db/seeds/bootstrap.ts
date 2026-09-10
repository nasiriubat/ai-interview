import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { defaultAnthropicRoutes, SEED_PRICES } from "@aidp/ai";
import { Crypto } from "@aidp/core";
import { PrismaClient } from "@prisma/client";
import { seed } from "./seed.js";

/**
 * First-run bootstrap. Idempotent. Creates:
 * - the platform operator company and user (BOOTSTRAP_OPERATOR_EMAIL)
 * - a first tenant with an admin (BOOTSTRAP_TENANT_NAME, BOOTSTRAP_ADMIN_EMAIL)
 * - a platform Anthropic provider from ANTHROPIC_API_KEY with seed prices and default routes
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
    for (const r of defaultAnthropicRoutes(provider.id)) {
      const existing = await db.route.findFirst({ where: { companyId: null, purpose: r.purpose } });
      if (!existing)
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

  const seeded = await seed(db);
  console.log(
    `bootstrap: operator ${operatorEmail}, tenant "${tenantName}" admin ${adminEmail}, templates ${seeded.templates}${env.ANTHROPIC_API_KEY ? ", Anthropic provider and default routes" : ", no provider (set ANTHROPIC_API_KEY or add one in the admin UI)"}`,
  );
  if (!env.PLATFORM_ENCRYPTION_KEY) console.log(`generated key: ${randomBytes(32).toString("base64")}`);
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
