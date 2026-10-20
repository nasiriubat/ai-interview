import type { Server } from "node:http";
import { describeDb } from "@aidp/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { userAddedMessage } from "../src/modules/users/welcome-mail.js";
import { fakeModelServer, testWorld, type TestWorld } from "./helpers.js";

/*
 * The add-user dialog says "They receive a sign-in link by email". Until the 2026-10-15
 * simulation nothing was sent, so a colleague added by an admin never heard of it.
 */
describeDb("adding a user emails them where to sign in", () => {
  let world: TestWorld;
  let model: { server: Server; url: string };

  beforeAll(async () => {
    model = await fakeModelServer(() => "ok");
    world = await testWorld(model.url, { PUBLIC_WEB_URL: "https://discovery.example.org" });
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  it("sends one message with the sign-in address and no token", async () => {
    const email = `colleague-${Date.now().toString(36)}@test.io`;
    const before = world.email.sent.length;
    const res = await world.app.inject({
      method: "POST",
      url: "/api/v1/users",
      headers: { authorization: `Bearer ${world.adminToken}` },
      payload: { email, name: "Joonas Aalto", role: "member" },
    });
    expect(res.statusCode).toBe(201);
    const sent = world.email.sent.slice(before).filter((m) => m.to === email);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("https://discovery.example.org/auth/signin");
    expect(sent[0]?.text).toMatch(/as a member/);
    expect(sent[0]?.text).not.toMatch(/token=/);
    expect(sent[0]?.companyId).toBe(world.companyId);
  });

  it("words an admin and an unknown actor plainly", () => {
    const m = userAddedMessage({
      to: "a@b.example",
      companyId: "c",
      productName: " ",
      organization: "Kestrel Health",
      role: "admin",
      addedBy: null,
      webUrl: "http://localhost:3300/",
    });
    expect(m.subject).toBe("You have been added to AIScope");
    expect(m.text).toContain("You have been added to AIScope for Kestrel Health, as an administrator.");
    expect(m.text).toContain("http://localhost:3300/auth/signin");
  });
});
