import { describeDb } from "@aidp/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { MEASURED_MINUTES_MIN } from "../src/modules/participant/service.js";
import { testWorld, type TestWorld } from "./helpers.js";

// The arrival screen states a duration only once it has been measured on this campaign (claims B9).
describeDb("arrival screen duration", () => {
  let world: TestWorld;
  beforeAll(async () => {
    world = await testWorld("http://127.0.0.1:9");
  });
  afterAll(async () => {
    await world.close();
  });

  it("is null until enough interviews finished, then the median active minutes with pauses capped", async () => {
    const { app, adminToken, db } = world;
    const h = { authorization: `Bearer ${adminToken}` };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: h,
      payload: { templateId: world.templateId, name: "Arrival minutes", verification: "open" },
    });
    const { campaign, link } = created.json<{ campaign: { id: string }; link: { url: string } }>();
    const token = link.url.split("/p/")[1]!;
    await app.inject({ method: "POST", url: `/api/v1/campaigns/${campaign.id}/open`, headers: h });
    const minutes = async (): Promise<unknown> =>
      (await app.inject({ method: "GET", url: `/api/v1/p/${token}` })).json<{
        campaign: { expectedMinutes: unknown };
      }>().campaign.expectedMinutes;

    expect(await minutes()).toBeNull();

    // Each interview: four messages a minute apart (3 active minutes), then one after a two-hour
    // pause that counts as the five-minute cap: 8 minutes in all.
    const t0 = Date.now() - 86_400_000;
    for (let i = 0; i < MEASURED_MINUTES_MIN; i++) {
      const session = await db.session.create({
        data: {
          companyId: world.companyId,
          templateId: world.templateId,
          campaignId: campaign.id,
          status: i === 0 ? "active" : "completed",
        },
      });
      const at = [0, 1, 2, 3, 123].map((m) => new Date(t0 + m * 60_000));
      await db.message.createMany({
        data: at.map((createdAt, seq) => ({
          companyId: world.companyId,
          sessionId: session.id,
          seq,
          role: seq % 2 ? "user" : "assistant",
          content: "x",
          createdAt,
        })),
      });
    }
    // One of the five is unfinished, so four completed: still below the threshold.
    expect(await minutes()).toBeNull();

    const last = await db.session.create({
      data: {
        companyId: world.companyId,
        templateId: world.templateId,
        campaignId: campaign.id,
        status: "completed",
      },
    });
    await db.message.createMany({
      data: [0, 1, 2, 3, 123].map((m, seq) => ({
        companyId: world.companyId,
        sessionId: last.id,
        seq,
        role: seq % 2 ? "user" : "assistant",
        content: "x",
        createdAt: new Date(t0 + m * 60_000),
      })),
    });
    expect(await minutes()).toBe(8);
  });
});
