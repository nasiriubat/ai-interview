import type { Server } from "node:http";
import { withTenant } from "@aidp/db";
import { encode } from "@auth/core/jwt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeModelServer, TEST_AUTH_SECRET, testWorld, type TestWorld } from "./helpers.js";

const suite = process.env.DATABASE_URL ? describe : describe.skip;

interface Readiness {
  liveVoiceEnabled: boolean;
  recordedVoiceEnabled: boolean;
  purposes: Record<
    "transcription" | "stt_stream" | "tts",
    { ready: boolean; providerName?: string; model?: string; scope: "tenant" | "platform" | null }
  >;
  canEnableLive: boolean;
  missing: string[];
}

/**
 * Live voice as an admin toggle with a readiness check (FR-30a, D-77; contract 19 "Live voice").
 *
 * The key check runs through the real adapter against the fake model server (`OPENAI_BASE_URL`),
 * which refuses any key starting `sk-bad` the way OpenAI refuses one. Nothing reaches the network.
 */
suite("live voice setup (D-77)", () => {
  let world: TestWorld;
  let model: { server: Server; url: string };
  let admin: Record<string, string>;
  /** A second tenant, to prove neither can see or change the other. */
  let other: { companyId: string; headers: Record<string, string> };
  let member: Record<string, string>;
  const GOOD_KEY = "sk-live-voice-test-key-0123456789abcdef";
  const BAD_KEY = "sk-bad-live-voice-key-0123456789abcdef";

  const token = (email: string) =>
    encode({ token: { email }, secret: TEST_AUTH_SECRET, salt: "authjs.session-token" });

  beforeAll(async () => {
    model = await fakeModelServer(() => "ready");
    world = await testWorld(model.url, { OPENAI_BASE_URL: model.url });
    admin = { authorization: `Bearer ${world.adminToken}`, "content-type": "application/json" };
    const suffix = Date.now().toString(36);
    const company = await world.db.company.create({ data: { name: `Other ${suffix}` } });
    await world.db.user.create({
      data: { companyId: company.id, email: `other-${suffix}@test.io`, role: "admin" },
    });
    other = {
      companyId: company.id,
      headers: {
        authorization: `Bearer ${await token(`other-${suffix}@test.io`)}`,
        "content-type": "application/json",
      },
    };
    await world.db.user.create({
      data: { companyId: world.companyId, email: `member-${suffix}@test.io`, role: "member" },
    });
    member = { authorization: `Bearer ${await token(`member-${suffix}@test.io`)}` };
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  const readiness = (headers = admin) =>
    world.app.inject({ method: "GET", url: "/api/v1/admin/voice/readiness", headers });
  // Live voice is switched by the platform operator, acting on this tenant (D-476).
  const operator = () => ({
    authorization: `Bearer ${world.operatorToken}`,
    "x-company-id": world.companyId,
  });
  const setLive = (enabled: boolean, headers: Record<string, string> = operator()) =>
    world.app.inject({ method: "PUT", url: "/api/v1/admin/voice/live", headers, payload: { enabled } });
  const connect = (apiKey: string, headers = admin) =>
    world.app.inject({ method: "POST", url: "/api/v1/admin/voice/openai", headers, payload: { apiKey } });

  it("reports which voice purposes have a working route, tenant first", async () => {
    const res = await readiness();

    expect(res.statusCode).toBe(200);
    const body = res.json<Readiness>();
    // The test world routes transcription to its fake provider and nothing else.
    expect(body.purposes.transcription).toEqual({
      ready: true,
      providerName: "fake",
      model: "fake-model",
      scope: "tenant",
    });
    expect(body.purposes.tts).toEqual({ ready: false, scope: null });
    expect(body.purposes.stt_stream).toEqual({ ready: false, scope: null });
    expect(body).toMatchObject({ liveVoiceEnabled: false, canEnableLive: false, missing: ["tts"] });
  });

  it("lets only the platform operator switch live voice, not the tenant's own admin", async () => {
    const res = await setLive(true, admin);

    expect(res.statusCode).toBe(403);
    expect((await readiness()).json<Readiness>().liveVoiceEnabled).toBe(false);
    const viaSettings = await world.app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers: { ...admin, "content-type": "application/json" },
      payload: { scope: "tenant", values: { "features.realtimeVoice": true } },
    });
    expect(viaSettings.statusCode).toBe(403);
  });

  it("refuses to turn live voice on without the routes it needs, naming what is missing", async () => {
    const res = await setLive(true);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "voice_not_ready", details: { missing: ["tts"] } } });
    expect((await readiness()).json<Readiness>().liveVoiceEnabled).toBe(false);
  });

  it("rejects a key OpenAI refuses, with a code the form can show, and stores nothing", async () => {
    const before = await world.db.provider.count({ where: { companyId: world.companyId } });

    const res = await connect(BAD_KEY);

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: "invalid_api_key" } });
    expect(res.body).not.toContain(BAD_KEY);
    expect(await world.db.provider.count({ where: { companyId: world.companyId } })).toBe(before);
  });

  it("verifies a good key, stores it encrypted, routes voice to it, and never echoes it", async () => {
    const res = await connect(GOOD_KEY);

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(GOOD_KEY);
    const body = res.json<Readiness>();
    expect(body.canEnableLive).toBe(true);
    expect(body.missing).toEqual([]);
    expect(body.purposes.stt_stream).toMatchObject({
      ready: true,
      model: "gpt-live-transcribe",
      scope: "tenant",
    });
    expect(body.purposes.tts).toMatchObject({ ready: true, model: "tts-1", scope: "tenant" });
    // A working transcription route already existed; recorded voice depends on it, so it stays.
    expect(body.purposes.transcription).toMatchObject({ providerName: "fake", model: "fake-model" });

    const provider = await world.db.provider.findFirstOrThrow({
      where: { companyId: world.companyId, kind: "openai" },
    });
    expect(provider.apiKeyEnc).not.toContain(GOOD_KEY);
    expect(world.crypto.decrypt(provider.apiKeyEnc, "provider.apiKey")).toBe(GOOD_KEY);
    expect(provider.baseUrl).toBe(model.url);

    const entry = await world.db.auditLog.findFirstOrThrow({
      where: { companyId: world.companyId, action: "voice.openai_connect" },
    });
    expect(entry.targetId).toBe(provider.id);
    expect(JSON.stringify(entry.diff)).not.toContain(GOOD_KEY);
    expect(entry.diff).toMatchObject({ providerCreated: true, routed: ["stt_stream", "tts"] });
  });

  it("updates the same provider when a key is given again rather than adding another", async () => {
    const res = await connect(`${GOOD_KEY}-rotated`);

    expect(res.statusCode).toBe(200);
    const providers = await world.db.provider.findMany({
      where: { companyId: world.companyId, kind: "openai" },
    });
    expect(providers).toHaveLength(1);
    expect(world.crypto.decrypt(providers[0]?.apiKeyEnc ?? "", "provider.apiKey")).toBe(
      `${GOOD_KEY}-rotated`,
    );
  });

  it("turns live voice on and off once ready, through the settings, audited", async () => {
    const on = await setLive(true);

    expect(on.statusCode).toBe(200);
    expect(on.json<Readiness>().liveVoiceEnabled).toBe(true);
    expect(
      await withTenant(world.companyId, () =>
        world.ctx.settings.get("features.realtimeVoice", [{ scope: "tenant", scopeId: world.companyId }]),
      ),
    ).toBe(true);
    const entry = await world.db.auditLog.findFirstOrThrow({
      where: { companyId: world.companyId, action: "voice.live_toggle" },
      orderBy: { createdAt: "desc" },
    });
    expect(entry.diff).toEqual({ "features.realtimeVoice": true });

    const off = await setLive(false);
    expect(off.json<Readiness>().liveVoiceEnabled).toBe(false);
    // Turning it off never needs anything.
    expect(off.statusCode).toBe(200);
    await setLive(true);
  });

  it("keeps each tenant to its own readiness, routes and switch", async () => {
    const theirs = await readiness(other.headers);
    expect(theirs.statusCode).toBe(200);
    // Tenant A has live voice on with its own routes; tenant B sees none of it.
    expect(theirs.json<Readiness>()).toMatchObject({
      liveVoiceEnabled: false,
      canEnableLive: false,
      purposes: { stt_stream: { ready: false, scope: null }, tts: { ready: false, scope: null } },
    });

    // An admin cannot aim at another tenant with the operator's header.
    const aimed = await readiness({ ...other.headers, "x-company-id": world.companyId });
    expect(aimed.json<Readiness>().liveVoiceEnabled).toBe(false);

    // B's admin cannot switch live voice at all (D-476); B's key touches only B.
    expect((await setLive(true, other.headers)).statusCode).toBe(403);
    expect((await connect(GOOD_KEY, other.headers)).statusCode).toBe(200);
    const bProvider = await world.db.provider.findFirstOrThrow({
      where: { companyId: other.companyId, kind: "openai" },
    });
    const aRoutes = await world.db.route.findMany({ where: { companyId: world.companyId } });
    expect(aRoutes.some((r) => r.providerId === bProvider.id)).toBe(false);
    expect((await setLive(false, other.headers)).statusCode).toBe(403);
    expect((await readiness()).json<Readiness>().liveVoiceEnabled).toBe(true);
  });

  it("is for admins only", async () => {
    expect((await readiness(member)).statusCode).toBe(403);
    expect((await setLive(true, { ...member, "content-type": "application/json" })).statusCode).toBe(403);
    expect((await connect(GOOD_KEY, { ...member, "content-type": "application/json" })).statusCode).toBe(403);
    const anonymous = await world.app.inject({ method: "GET", url: "/api/v1/admin/voice/readiness" });
    expect(anonymous.statusCode).toBe(401);
  });

  it("validates the body before anything is checked", async () => {
    const res = await world.app.inject({
      method: "POST",
      url: "/api/v1/admin/voice/openai",
      headers: admin,
      payload: { apiKey: "short" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "validation" } });
  });
});
