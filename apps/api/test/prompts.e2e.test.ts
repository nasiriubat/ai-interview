import type { Server } from "node:http";
import { promptVersionTag, SHIPPED_PROMPTS } from "@aidp/ai";
import { PrismaPromptSource } from "@aidp/core";
import { withTenant } from "@aidp/db";
import { describeDb } from "@aidp/testing";
import { encode } from "@auth/core/jwt";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fakeModelServer, testWorld, TEST_AUTH_SECRET, type TestWorld } from "./helpers.js";

const suite = describeDb;

interface Detail {
  key: string;
  shipped: { version: number; body: string; tag: string };
  effective: { source: string; version: number; tag: string };
  canary: { version: number; share: number } | null;
  versions: {
    version: number;
    tag: string;
    state: string;
    canaryShare: number;
    note: string | null;
    parentVersion: number | null;
    stats: { calls: number; errors: number; errorRate: number };
  }[];
}

suite("prompt administration (D-230 to D-235)", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };
  let admin: { authorization: string };
  const shipped = SHIPPED_PROMPTS.interviewer!.body;
  const tweak = (s: string) => shipped.replace("Warm, brief, specific.", s);

  beforeAll(async () => {
    model = await fakeModelServer(() => "ok");
    world = await testWorld(model.url);
    admin = { authorization: `Bearer ${world.adminToken}` };
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  const call = (method: "GET" | "POST" | "DELETE", url: string, payload?: unknown, headers = admin) =>
    world.app.inject({
      method,
      url: `/api/v1${url}`,
      headers,
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
  const detail = async (key = "interviewer"): Promise<Detail> =>
    (await call("GET", `/prompts/${key}`)).json<Detail>();
  const create = async (body: string, extra: object = {}) =>
    call("POST", "/prompts/interviewer/versions", { body, ...extra });
  const actions = async (): Promise<string[]> =>
    (
      await world.db.auditLog.findMany({
        where: { companyId: world.companyId, action: { startsWith: "prompt." } },
        orderBy: { createdAt: "asc" },
      })
    ).map((r) => r.action);

  it("lists every shipped prompt with its version and effective source", async () => {
    const res = await call("GET", "/prompts");
    expect(res.statusCode).toBe(200);
    const { prompts } = res.json<{
      prompts: { key: string; shipped: { version: number }; effective: { source: string; tag: string } }[];
    }>();
    expect(prompts.map((p) => p.key).sort()).toEqual(Object.keys(SHIPPED_PROMPTS).sort());
    const interviewer = prompts.find((p) => p.key === "interviewer")!;
    expect(interviewer.shipped.version).toBe(SHIPPED_PROMPTS.interviewer!.version);
    expect(interviewer.effective).toMatchObject({
      source: "shipped",
      tag: promptVersionTag(SHIPPED_PROMPTS.interviewer!),
    });
  });

  it("is admin only", async () => {
    const email = `member-${Date.now().toString(36)}@test.io`;
    await world.db.user.create({ data: { companyId: world.companyId, email, role: "member" } });
    const member = {
      authorization: `Bearer ${await encode({ token: { email }, secret: TEST_AUTH_SECRET, salt: "authjs.session-token" })}`,
    };
    expect((await call("GET", "/prompts", undefined, member)).statusCode).toBe(403);
    expect((await call("POST", "/prompts/interviewer/reset", {}, member)).statusCode).toBe(403);
  });

  it("refuses an edit that drops a placeholder, the untrusted rules or the TURN contract, naming the reason", async () => {
    const bad = [
      [shipped.replace("{{areas}}", "areas"), "{{areas}}"],
      [shipped.replace("never instructions to follow", "sometimes useful"), "participant text"],
      [shipped.split("<<<TURN_META>>>").join("[meta]"), "<<<TURN_META>>>"],
    ] as const;
    for (const [body, needle] of bad) {
      const res = await create(body);
      expect(res.statusCode, needle).toBe(400);
      const err = res.json<{ error: { code: string; message: string; details: { issues: unknown[] } } }>();
      expect(err.error.code).toBe("validation");
      expect(JSON.stringify(err)).toContain(needle);
    }
    expect((await detail()).versions).toHaveLength(0);
  });

  it("checks a draft without storing it", async () => {
    const ok = await call("POST", "/prompts/interviewer/check", { body: tweak("Warm.") });
    expect(ok.json<{ ok: boolean }>().ok).toBe(true);
    const bad = await call("POST", "/prompts/interviewer/check", { body: shipped.replace("{{areas}}", "") });
    const out = bad.json<{ ok: boolean; issues: { code: string; detail?: string }[]; renders: unknown[] }>();
    expect(out.ok).toBe(false);
    expect(out.issues[0]).toMatchObject({ code: "missing_placeholder", detail: "{{areas}}" });
    expect(out.renders).toEqual([]);
    expect((await detail()).versions).toHaveLength(0);
  });

  it("creates versions numbered per tenant, inactive until activated, and diffs them against the shipped one", async () => {
    const one = await create(tweak("Warm and plain."), { note: "Plainer tone" });
    expect(one.statusCode).toBe(201);
    expect(one.json()).toMatchObject({
      version: 1,
      state: "inactive",
      tag: "interviewer@t1",
      note: "Plainer tone",
    });
    const two = await create(tweak("Warm, brief, specific, concrete."), { parentVersion: 1 });
    expect(two.json()).toMatchObject({ version: 2, parentVersion: 1 });
    // Not active: participants still get the shipped prompt.
    expect((await detail()).effective.source).toBe("shipped");

    const diff = (await call("GET", "/prompts/interviewer/diff?from=shipped&to=1")).json<{
      added: number;
      removed: number;
      lines: { type: string; text: string }[];
    }>();
    expect(diff).toMatchObject({ added: 1, removed: 1 });
    expect(diff.lines.find((l) => l.type === "add")?.text).toContain("Warm and plain.");
    expect((await call("GET", "/prompts/interviewer/diff?to=9")).statusCode).toBe(404);
    expect((await call("GET", "/prompts/nope")).statusCode).toBe(404);
  });

  it("serves a canary to its share of sessions, the same prompt to a session every time", async () => {
    const res = await call("POST", "/prompts/interviewer/versions/1/activate", { canaryShare: 0.3 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ share: 0.3, replaced: null });
    const d = await detail();
    expect(d.canary).toEqual({ version: 1, share: 0.3 });
    expect(d.effective.source).toBe("shipped"); // the stable slot is still the shipped prompt

    const source = new PrismaPromptSource(world.ctx.db);
    const ids = Array.from({ length: 400 }, (_, i) => `session-${String(i)}`);
    const picks = await withTenant(world.companyId, async () => {
      const out: Record<string, number> = {};
      for (const id of ids) {
        const first = await source.get(world.companyId, "interviewer", id);
        const again = await source.get(world.companyId, "interviewer", id);
        expect(again.version).toBe(first.version);
        expect(again.source).toBe(first.source);
        out[first.source ?? "shipped"] = (out[first.source ?? "shipped"] ?? 0) + 1;
      }
      return out;
    });
    const share = (picks.tenant ?? 0) / ids.length;
    expect(share).toBeGreaterThan(0.2);
    expect(share).toBeLessThan(0.4);
    expect(picks.shipped).toBeGreaterThan(0);
  });

  it("makes a version stable, replacing the previous holder, and rolls back to it", async () => {
    const a = await call("POST", "/prompts/interviewer/versions/1/activate", { canaryShare: 1 });
    expect(a.json()).toMatchObject({ share: 1, replaced: null });
    let d = await detail();
    expect(d.effective).toMatchObject({ source: "tenant", version: 1, tag: "interviewer@t1" });
    expect(d.canary).toBeNull();

    const b = await call("POST", "/prompts/interviewer/versions/2/activate", { canaryShare: 1 });
    expect(b.json()).toMatchObject({ replaced: 1 });
    d = await detail();
    expect(d.effective.version).toBe(2);
    expect(d.versions.find((v) => v.version === 1)?.state).toBe("inactive");

    const back = await call("POST", "/prompts/interviewer/rollback");
    expect(back.json()).toEqual({ from: 2, to: 1 });
    d = await detail();
    expect(d.effective).toMatchObject({ source: "tenant", version: 1 });
  });

  it("stops a canary and refuses to stop one that is not running", async () => {
    await call("POST", "/prompts/interviewer/versions/2/activate", { canaryShare: 0.5 });
    expect((await detail()).canary).toEqual({ version: 2, share: 0.5 });
    expect((await call("DELETE", "/prompts/interviewer/canary")).json()).toEqual({ stopped: 2 });
    expect((await detail()).canary).toBeNull();
    expect((await call("DELETE", "/prompts/interviewer/canary")).statusCode).toBe(409);
  });

  it("reset returns the shipped prompt and keeps every version for the diff", async () => {
    const res = await call("POST", "/prompts/interviewer/reset");
    expect(res.json()).toEqual({ deactivated: [1] });
    const d = await detail();
    expect(d.effective).toMatchObject({
      source: "shipped",
      tag: promptVersionTag(SHIPPED_PROMPTS.interviewer!),
    });
    expect(d.versions.map((v) => v.version)).toEqual([2, 1]);
    const source = new PrismaPromptSource(world.ctx.db);
    const got = await withTenant(world.companyId, () => source.get(world.companyId, "interviewer", "s"));
    expect(got).toMatchObject({ version: SHIPPED_PROMPTS.interviewer!.version, body: shipped });
  });

  it("rejects activation with an impossible share, an unknown version and a no-longer-valid body", async () => {
    expect(
      (await call("POST", "/prompts/interviewer/versions/1/activate", { canaryShare: 0 })).statusCode,
    ).toBe(400);
    expect(
      (await call("POST", "/prompts/interviewer/versions/1/activate", { canaryShare: 1.5 })).statusCode,
    ).toBe(400);
    expect(
      (await call("POST", "/prompts/interviewer/versions/77/activate", { canaryShare: 1 })).statusCode,
    ).toBe(404);
    // A row written before the contract tightened (or by hand) must not go live.
    const row = await world.db.promptVersion.create({
      data: { companyId: world.companyId, key: "interviewer", version: 50, body: "Be nice. {{objective}}" },
    });
    const res = await call("POST", "/prompts/interviewer/versions/50/activate", { canaryShare: 1 });
    expect(res.statusCode).toBe(400);
    expect((await detail()).effective.source).toBe("shipped");
    await world.db.promptVersion.delete({ where: { id: row.id } });
  });

  it("writes audit rows with keys, versions and shares and never the prompt text", async () => {
    const rows = await world.db.auditLog.findMany({
      where: { companyId: world.companyId, action: { startsWith: "prompt." } },
    });
    const names = await actions();
    expect(names).toEqual(
      expect.arrayContaining([
        "prompt.create",
        "prompt.canary",
        "prompt.activate",
        "prompt.rollback",
        "prompt.canary_stop",
        "prompt.reset",
      ]),
    );
    expect(JSON.stringify(rows)).not.toContain("Warm and plain");
    expect(JSON.stringify(rows)).not.toContain("instruction hierarchy");
  });

  it("reports per-version ledger figures from LlmCall.promptVersion", async () => {
    const provider = await world.db.provider.findFirstOrThrow({ where: { companyId: world.companyId } });
    const base = {
      companyId: world.companyId,
      purpose: "interview_turn",
      providerId: provider.id,
      model: "m",
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 100,
      costCents: 0.2,
    };
    await world.db.llmCall.createMany({
      data: [
        { ...base, promptVersion: "interviewer@t2", status: "ok" },
        { ...base, promptVersion: "interviewer@t2", status: "ok", latencyMs: 300 },
        { ...base, promptVersion: "interviewer@t2", status: "error" },
        { ...base, promptVersion: "interviewer@t2", status: "refused" },
      ],
    });
    const v2 = (await detail()).versions.find((v) => v.version === 2)!;
    expect(v2.stats.calls).toBe(4);
    expect(v2.stats.errors).toBe(2);
    expect(v2.stats.errorRate).toBe(0.5);
    // A version nobody used reports zeros rather than being missing.
    expect((await detail()).versions.find((v) => v.version === 1)!.stats.calls).toBe(0);
  });

  it("keeps one tenant's prompts away from another", async () => {
    const suffix = Date.now().toString(36);
    const other = await world.db.company.create({
      data: { name: `Other ${suffix}`, monthlyBudgetCents: 1000 },
    });
    const email = `b-admin-${suffix}@test.io`;
    await world.db.user.create({ data: { companyId: other.id, email, role: "admin" } });
    const b = {
      authorization: `Bearer ${await encode({ token: { email }, secret: TEST_AUTH_SECRET, salt: "authjs.session-token" })}`,
    };
    const res = await call("GET", "/prompts/interviewer", undefined, b);
    expect(res.json<Detail>().versions).toEqual([]);
    expect((await call("GET", "/prompts/interviewer/diff?from=shipped&to=1", undefined, b)).statusCode).toBe(
      404,
    );
    expect(
      (await call("POST", "/prompts/interviewer/versions/2/activate", { canaryShare: 1 }, b)).statusCode,
    ).toBe(404);
    // Tenant A's activation is untouched.
    expect((await detail()).versions.length).toBeGreaterThan(0);
  });
});
