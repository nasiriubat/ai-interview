import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeModelServer, testWorld, type TestWorld } from "./helpers.js";

const suite = process.env.DATABASE_URL ? describe : describe.skip;

/**
 * Per-address caps on the email-code flow (S1, D-82). The per-IP bucket cannot stop one person
 * mail-bombing a victim through a public link from many addresses, nor guessing a six-digit code
 * across fresh codes, so the address itself is counted.
 */
suite("email-code endpoints are capped per address", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };
  let linkToken = "";
  let campaignId = "";
  let hop = 0;

  beforeAll(async () => {
    model = await fakeModelServer(() => "x");
    world = await testWorld(model.url, { RATE_LIMIT_MAX: "100000" });
    const staff = { authorization: `Bearer ${world.adminToken}` };
    const created = await world.app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: staff,
      payload: { templateId: world.templateId, name: "Caps" },
    });
    const body = created.json<{ campaign: { id: string }; link: { url: string } }>();
    campaignId = body.campaign.id;
    linkToken = body.link.url.split("/p/")[1]!;
    await world.app.inject({ method: "POST", url: `/api/v1/campaigns/${campaignId}/open`, headers: staff });
    await world.app.inject({
      method: "PUT",
      url: "/api/v1/settings?scope=tenant",
      headers: staff,
      payload: { values: { "privacy.codeFailuresPerHour": 4 } },
    });
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  /** A different client address each call, so the per-IP bucket is not what is being tested. */
  const fresh = () => ({ "x-forwarded-for": `198.51.100.${(hop++ % 250) + 1}` });
  const request = (email: string) =>
    world.app.inject({
      method: "POST",
      url: `/api/v1/p/${linkToken}/verify/request`,
      headers: fresh(),
      payload: { email },
    });
  const confirm = (email: string, code: string) =>
    world.app.inject({
      method: "POST",
      url: `/api/v1/p/${linkToken}/verify/confirm`,
      headers: fresh(),
      payload: { email, code },
    });
  const sentTo = (email: string) => world.email.sent.filter((m) => m.to === email);

  it("sends at most three codes an hour to one address, and answers the same every time", async () => {
    const email = "victim@hospital.test";
    const answers: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await request(email);
      expect(res.statusCode).toBe(200);
      answers.push(res.body);
    }
    expect(sentTo(email)).toHaveLength(3);
    // A blocked request is indistinguishable from one that sent: nothing for an attacker to read.
    expect(new Set(answers).size).toBe(1);
    // Case does not buy a fourth.
    await request("VICTIM@hospital.test");
    expect(sentTo(email)).toHaveLength(3);
  });

  it("does not let one address's cap affect another's", async () => {
    await request("other@hospital.test");
    expect(sentTo("other@hospital.test")).toHaveLength(1);
  });

  it("locks an address after too many wrong codes, even for the right code, until the window passes", async () => {
    const email = "guessed@hospital.test";
    await request(email);
    const code = /is (\d{6})/.exec(sentTo(email).at(-1)?.text ?? "")?.[1] ?? "";
    const wrong = code === "000000" ? "111111" : "000000";

    // The per-code limit is five, but the address limit is four: four wrongs, then locked.
    for (let i = 0; i < 4; i++) expect((await confirm(email, wrong)).statusCode).toBe(403);
    const locked = await confirm(email, code);
    expect(locked.statusCode).toBe(403);
    expect(locked.json()).toMatchObject({ error: { message: "Code expired or invalid" } });

    // A fresh code does not reset the count: that was the point of counting the address.
    await request(email);
    const code2 = /is (\d{6})/.exec(sentTo(email).at(-1)?.text ?? "")?.[1] ?? "";
    expect((await confirm(email, code2)).statusCode).toBe(403);

    // The window lapses: the rows age out and the person can verify again.
    await world.db.emailCode.updateMany({
      where: { campaignId },
      data: { createdAt: new Date(Date.now() - 2 * 3_600_000) },
    });
    await request(email);
    const code3 = /is (\d{6})/.exec(sentTo(email).at(-1)?.text ?? "")?.[1] ?? "";
    expect((await confirm(email, code3)).statusCode).toBe(200);
  });
});
