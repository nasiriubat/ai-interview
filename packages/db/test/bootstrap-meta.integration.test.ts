import { randomBytes } from "node:crypto";
import { defaultMetaRoutes, META_SEED_PRICES } from "@aidp/ai";
import { describeDb } from "@aidp/testing";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, expect, it } from "vitest";
import { bootstrap } from "../seeds/bootstrap.js";

/**
 * D-495: MUSE_API_KEY makes Meta's Model API a platform provider like any other. It is priced from
 * the seed table and fills only purposes no route claims yet, so a deployment that already runs on
 * another provider keeps its routes and the admin decides when to switch.
 *
 * Bootstrap writes platform-level rows that every tenant shares, so the suite records what was
 * there and removes only what it added.
 */
describeDb("bootstrap: Meta's Model API as a platform provider (D-495)", () => {
  const db = new PrismaClient();
  const suffix = randomBytes(4).toString("hex");
  const env = {
    BOOTSTRAP_OPERATOR_EMAIL: `operator-${suffix}@bootstrap.test`,
    BOOTSTRAP_ADMIN_EMAIL: `admin-${suffix}@bootstrap.test`,
    BOOTSTRAP_TENANT_NAME: `Bootstrap meta ${suffix}`,
    PLATFORM_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    MUSE_API_KEY: `test-${suffix}`,
  };
  let before: {
    providers: Set<string>;
    routes: Map<string, { id: string; providerId: string }>;
    platformCompany: boolean;
  };

  beforeAll(async () => {
    const routes = await db.route.findMany({ where: { companyId: null } });
    before = {
      providers: new Set((await db.provider.findMany({ where: { companyId: null } })).map((p) => p.id)),
      routes: new Map(routes.map((r) => [r.purpose, { id: r.id, providerId: r.providerId }])),
      platformCompany: (await db.company.findFirst({ where: { name: "Platform" } })) !== null,
    };
    await bootstrap(db, env);
  });

  afterAll(async () => {
    const added = (await db.route.findMany({ where: { companyId: null } })).filter(
      (r) => before.routes.get(r.purpose)?.id !== r.id,
    );
    await db.route.deleteMany({ where: { id: { in: added.map((r) => r.id) } } });
    const newProviders = (await db.provider.findMany({ where: { companyId: null } }))
      .filter((p) => !before.providers.has(p.id))
      .map((p) => p.id);
    await db.modelPrice.deleteMany({ where: { providerId: { in: newProviders } } });
    await db.provider.deleteMany({ where: { id: { in: newProviders } } });
    const tenant = await db.company.findFirst({ where: { name: env.BOOTSTRAP_TENANT_NAME } });
    if (tenant) {
      await db.user.deleteMany({ where: { companyId: tenant.id } });
      await db.budget.deleteMany({ where: { companyId: tenant.id } });
      await db.company.delete({ where: { id: tenant.id } });
    }
    await db.user.deleteMany({ where: { email: env.BOOTSTRAP_OPERATOR_EMAIL } });
    if (!before.platformCompany) {
      const platform = await db.company.findFirst({ where: { name: "Platform" } });
      if (platform && (await db.user.count({ where: { companyId: platform.id } })) === 0) {
        await db.company.delete({ where: { id: platform.id } }).catch(() => undefined);
      }
    }
    await db.$disconnect();
  });

  it("creates one platform provider of kind meta, with its key encrypted and its seed prices", async () => {
    const providers = await db.provider.findMany({ where: { companyId: null, kind: "meta" } });
    expect(providers).toHaveLength(1);
    const provider = providers[0]!;
    expect(provider.apiKeyEnc).not.toContain(env.MUSE_API_KEY);
    const prices = await db.modelPrice.findMany({ where: { providerId: provider.id } });
    for (const seed of META_SEED_PRICES) {
      expect(prices.find((p) => p.model === seed.model)).toMatchObject({
        inputPerMtok: seed.inputPerMtok,
        outputPerMtok: seed.outputPerMtok,
      });
    }
  });

  it("fills only the purposes nothing claimed, and leaves every existing route where it was", async () => {
    const meta = await db.provider.findFirstOrThrow({ where: { companyId: null, kind: "meta" } });
    for (const row of defaultMetaRoutes(meta.id)) {
      const route = await db.route.findFirstOrThrow({ where: { companyId: null, purpose: row.purpose } });
      const earlier = before.routes.get(row.purpose);
      if (earlier) expect(route.providerId).toBe(earlier.providerId);
      else expect(route).toMatchObject({ providerId: meta.id, model: row.model });
    }
  });

  it("is idempotent: a second run adds no second provider", async () => {
    await bootstrap(db, env);
    expect(await db.provider.count({ where: { companyId: null, kind: "meta" } })).toBe(1);
  });
});
