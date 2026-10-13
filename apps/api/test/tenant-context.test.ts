import { currentTenant } from "@aidp/db";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { authPlugin } from "../src/auth/plugin.js";
import type { Principal } from "../src/auth/principal.js";

/**
 * Which tenant a request handler runs in (D-140). The second fence, Postgres row-level security,
 * reads the tenant from async context; before this test existed the context was set in a way that
 * did not reach the handler, so every HTTP handler ran as `system` and the policies never applied
 * to API traffic. No database is needed: the handler reports what the data layer would see.
 */
describe("the tenant a handler runs in", () => {
  const principals: Record<string, Principal> = {
    admin: {
      kind: "staff",
      userId: "u1",
      companyId: "co_a",
      role: "admin",
      email: "a@x.io",
      suspended: false,
    },
    operator: {
      kind: "staff",
      userId: "u2",
      companyId: "co_platform",
      role: "platform_operator",
      email: "op@x.io",
      suspended: false,
    },
    participant: {
      kind: "participant",
      sessionId: "s1",
      companyId: "co_a",
      participantId: "p1",
      campaignId: "c1",
    },
  };

  async function observed(
    token: string | undefined,
    headers: Record<string, string> = {},
    access: "staff" | "operator" | "public" = "staff",
  ): Promise<{ inHandler: string | null; inLaterHook: string | null }> {
    const app = Fastify();
    await app.register(cookie);
    const resolver = {
      fromBearer: async (t: string | undefined): Promise<Principal> =>
        principals[t ?? ""] ?? { kind: "anonymous" },
    };
    await app.register(authPlugin, { resolver });
    let inLaterHook: string | null = null;
    app.get(
      "/probe",
      {
        config: { access },
        // A guard-style hook that runs after the auth hook, as the route guards do.
        onRequest: async () => {
          await Promise.resolve();
          inLaterHook = currentTenant();
        },
      },
      async () => {
        await new Promise((r) => setTimeout(r, 1));
        return { tenant: currentTenant() };
      },
    );
    const res = await app.inject({
      method: "GET",
      url: "/probe",
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    });
    await app.close();
    return { inHandler: res.json<{ tenant: string | null }>().tenant, inLaterHook };
  }

  it("is the principal's own company for staff, in the guards and in the handler", async () => {
    expect(await observed("admin")).toEqual({ inHandler: "co_a", inLaterHook: "co_a" });
  });

  it("is the participant's company for a participant token", async () => {
    expect((await observed("participant")).inHandler).toBe("co_a");
  });

  it("is system for an anonymous caller, which the public link routes need", async () => {
    expect((await observed(undefined, {}, "public")).inHandler).toBe("system");
  });

  it("is system for an operator working across tenants", async () => {
    expect((await observed("operator")).inHandler).toBe("system");
  });

  it("is the named tenant for an operator who pinned one on a tenant route", async () => {
    expect((await observed("operator", { "x-company-id": "co_b" })).inHandler).toBe("co_b");
  });

  it("stays system on an operator route even when the operator named a tenant", async () => {
    expect((await observed("operator", { "x-company-id": "co_b" }, "operator")).inHandler).toBe("system");
  });

  it("does not let a staff member widen their own scope with the header", async () => {
    expect((await observed("admin", { "x-company-id": "co_b" })).inHandler).toBe("co_a");
  });
});
