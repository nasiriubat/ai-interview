import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrap } from "../seeds/bootstrap.js";

/** Runs only when DATABASE_URL points at a migrated database. */
const url = process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;

/**
 * D-75: recording works with no key because bootstrap always provides a transcription route on the
 * server itself — unless OPENAI_API_KEY already claimed it (D-73), in which case the local provider
 * still exists so an admin can switch to it.
 *
 * Bootstrap writes platform-level rows, which every tenant shares, so this suite records what was
 * there before and puts it back afterwards.
 */
suite("bootstrap: speech to text on this server (D-75)", () => {
  const db = new PrismaClient();
  const suffix = randomBytes(4).toString("hex");
  const env = {
    BOOTSTRAP_OPERATOR_EMAIL: `operator-${suffix}@bootstrap.test`,
    BOOTSTRAP_ADMIN_EMAIL: `admin-${suffix}@bootstrap.test`,
    BOOTSTRAP_TENANT_NAME: `Bootstrap speech ${suffix}`,
    PLATFORM_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  };
  let before: { providers: Set<string>; routes: Set<string>; platformCompany: boolean };
  let savedTranscription:
    | { id: string; providerId: string; model: string; effort: string | null; maxOutputTokens: number }
    | undefined;

  beforeAll(async () => {
    const platformRoute = await db.route.findFirst({ where: { companyId: null, purpose: "transcription" } });
    savedTranscription = platformRoute ?? undefined;
    before = {
      providers: new Set((await db.provider.findMany({ where: { companyId: null } })).map((p) => p.id)),
      routes: new Set((await db.route.findMany({ where: { companyId: null } })).map((r) => r.id)),
      platformCompany: (await db.company.findFirst({ where: { name: "Platform" } })) !== null,
    };
  });

  beforeEach(async () => {
    await db.route.deleteMany({ where: { companyId: null, purpose: "transcription" } });
  });

  afterAll(async () => {
    const newRoutes = (await db.route.findMany({ where: { companyId: null } })).filter(
      (r) => !before.routes.has(r.id),
    );
    await db.route.deleteMany({ where: { id: { in: newRoutes.map((r) => r.id) } } });
    if (savedTranscription && !(await db.route.findUnique({ where: { id: savedTranscription.id } }))) {
      await db.route.create({
        data: {
          id: savedTranscription.id,
          companyId: null,
          purpose: "transcription",
          providerId: savedTranscription.providerId,
          model: savedTranscription.model,
          effort: savedTranscription.effort,
          maxOutputTokens: savedTranscription.maxOutputTokens,
        },
      });
    }
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

  it("routes transcription to Whisper on this server when no key claimed it, and stays idempotent", async () => {
    await bootstrap(db, env);
    await bootstrap(db, env);

    const locals = await db.provider.findMany({ where: { companyId: null, kind: "local" } });
    expect(locals).toHaveLength(1);
    const local = locals[0]!;
    expect(local.name).toBe("On this server (Whisper)");
    expect(local.apiKeyEnc).toBe(""); // no secret, so "Key set" stays false in the admin screen

    const routes = await db.route.findMany({ where: { companyId: null, purpose: "transcription" } });
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ providerId: local.id, model: "onnx-community/whisper-small" });

    const prices = await db.modelPrice.findMany({
      where: { providerId: local.id },
      orderBy: { model: "asc" },
    });
    expect(prices.map((p) => p.model)).toEqual([
      "onnx-community/whisper-base",
      "onnx-community/whisper-large-v3-turbo",
      "onnx-community/whisper-small",
    ]);
    expect(prices.every((p) => p.inputPerMtok === 0 && p.outputPerMtok === 0)).toBe(true);
  });

  it("keeps OpenAI on transcription when OPENAI_API_KEY is set, with the local provider beside it", async () => {
    await bootstrap(db, { ...env, OPENAI_API_KEY: "sk-test-not-a-key" });

    const openai = await db.provider.findFirstOrThrow({ where: { companyId: null, kind: "openai" } });
    const route = await db.route.findFirstOrThrow({ where: { companyId: null, purpose: "transcription" } });
    expect(route.providerId).toBe(openai.id);
    expect(route.model).toBe("whisper-1");
    expect(await db.provider.count({ where: { companyId: null, kind: "local" } })).toBe(1);
  });

  it("never takes a transcription route an operator already set", async () => {
    await bootstrap(db, env); // local claims the empty route
    const local = await db.provider.findFirstOrThrow({ where: { companyId: null, kind: "local" } });
    await db.route.updateMany({
      where: { companyId: null, purpose: "transcription" },
      data: { model: "onnx-community/whisper-base" },
    });
    await bootstrap(db, env);
    const route = await db.route.findFirstOrThrow({ where: { companyId: null, purpose: "transcription" } });
    expect(route).toMatchObject({ providerId: local.id, model: "onnx-community/whisper-base" });
  });
});
