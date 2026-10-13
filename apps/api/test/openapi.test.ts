import { describeDb } from "@aidp/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fakeModelServer, testWorld, type TestWorld } from "./helpers.js";

const suite = describeDb;

suite("OpenAPI and health", () => {
  let world: TestWorld;
  let close: () => void;
  beforeAll(async () => {
    const model = await fakeModelServer(() => "x");
    world = await testWorld(model.url);
    close = () => model.server.close();
  });
  afterAll(async () => {
    await world.close();
    close();
  });

  it("serves the OpenAPI document with every contract route and reports readiness", async () => {
    const doc = await world.app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    expect(doc.statusCode).toBe(200);
    const paths = Object.keys(doc.json<{ paths: Record<string, unknown> }>().paths);
    for (const p of [
      "/p/{linkToken}",
      "/p/session/turns",
      "/campaigns",
      "/templates/{id}/diff-shipped",
      "/settings",
      "/providers/{id}/test",
      "/routes",
      "/budgets",
      "/spend",
      "/stats",
      "/audit",
      "/privacy/retention",
      "/operator/tenants",
      "/operator/providers",
      "/operator/providers/{id}",
      "/operator/providers/{id}/test",
      "/operator/providers/{id}/models",
      "/operator/providers/{id}/prices",
      "/operator/routes",
      "/settings/scopes",
      "/settings/email/test",
      "/requirements",
      "/requirements/{id}/turns",
      "/requirements/{id}/versions/{v}/export",
      "/p/r/{token}",
      "/templates/{id}/preview",
    ]) {
      expect(paths).toContain(p);
    }
    const ready = await world.app.inject({ method: "GET", url: "/api/v1/health/ready" });
    // `storage` is on this response so a deployment can assert it: with no UPLOAD_DIR the store
    // is memory, every upload works in testing, and every recording vanishes on the next deploy
    // with nothing in the logs to say so. The test world deliberately runs on memory.
    expect(ready.json()).toEqual({ ok: true, database: true, storage: "memory" });
  });
});
