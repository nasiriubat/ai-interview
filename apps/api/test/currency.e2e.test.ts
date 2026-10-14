import { describeDb } from "@aidp/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { testWorld, type TestWorld } from "./helpers.js";

/**
 * The currency costs are shown in is a setting (D-323): `GET /me` carries it, USD until the
 * organization says otherwise, and a value outside the catalog is refused.
 */
describeDb("branding.currency", () => {
  let world: TestWorld;
  beforeAll(async () => {
    world = await testWorld("http://127.0.0.1:1");
  });
  afterAll(async () => {
    await world.close();
  });

  const h = () => ({ authorization: `Bearer ${world.adminToken}` });
  const currency = async (): Promise<string | undefined> =>
    (await world.app.inject({ method: "GET", url: "/api/v1/me", headers: h() })).json<{
      company: { currency?: string };
    }>().company.currency;

  it("is USD by default, follows the tenant's setting, and refuses an unknown code", async () => {
    expect(await currency()).toBe("USD");

    const put = await world.app.inject({
      method: "PUT",
      url: "/api/v1/settings?scope=tenant",
      headers: h(),
      payload: { values: { "branding.currency": "EUR" } },
    });
    expect(put.statusCode).toBe(200);
    expect(await currency()).toBe("EUR");

    const bad = await world.app.inject({
      method: "PUT",
      url: "/api/v1/settings?scope=tenant",
      headers: h(),
      payload: { values: { "branding.currency": "Bitcoin" } },
    });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
    expect(await currency()).toBe("EUR");
  });
});
