import { describe, expect, it } from "vitest";
import type { Transport } from "@/lib/api/http";
import { apiAdapter } from "@/lib/auth/adapter";

interface Call {
  path: string;
  method: string;
  body: unknown;
}

/** A transport that records what the adapter asks for and answers with canned responses. */
function fakeTransport(reply: (call: Call) => { status: number; body: unknown }): {
  transport: Transport;
  calls: Call[];
} {
  const calls: Call[] = [];
  const transport: Transport = {
    fetch: (path, init) => {
      const raw = typeof init?.body === "string" ? init.body : undefined;
      const call: Call = {
        path,
        method: init?.method ?? "GET",
        body: raw === undefined ? undefined : JSON.parse(raw),
      };
      calls.push(call);
      const { status, body } = reply(call);
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    },
  };
  return { transport, calls };
}

const identifier = "person@tenant.test";
// Already a digest when Auth.js hands it over; the adapter must pass it through untouched.
const token = "5f2b0c8d9e1a4b6c8d0e2f4a6b8c0d2e4f6a8b0c2d4e6f8a0b2c4d6e8f0a2b4c";
const expires = new Date("2026-09-14T21:00:00.000Z");

describe("apiAdapter verification tokens", () => {
  it("creates a token through the internal API route and hands back what it stored", async () => {
    const { transport, calls } = fakeTransport((call) => ({
      status: 201,
      body: { token: call.body },
    }));

    const created = await apiAdapter(transport).createVerificationToken?.({
      identifier,
      token,
      expires,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe("/internal/auth/verification-tokens");
    expect(calls[0]?.body).toEqual({ identifier, token, expires: expires.toISOString() });
    expect(created).toEqual({ identifier, token, expires });
  });

  it("consumes a token and returns it with the expiry Auth.js checks", async () => {
    const { transport, calls } = fakeTransport(() => ({
      status: 200,
      body: { token: { identifier, token, expires: expires.toISOString() } },
    }));

    const used = await apiAdapter(transport).useVerificationToken?.({ identifier, token });

    expect(calls[0]?.path).toBe("/internal/auth/verification-tokens/consume");
    expect(calls[0]?.method).toBe("POST");
    // The expiry is never sent on a consume: the row is found by identifier and token alone.
    expect(calls[0]?.body).toEqual({ identifier, token });
    expect(used).toEqual({ identifier, token, expires });
  });

  it("reads the API's 404 for an already-used token as null, not as a failure", async () => {
    const { transport } = fakeTransport(() => ({
      status: 404,
      body: { error: { code: "not_found", message: "Verification token not found" } },
    }));

    await expect(apiAdapter(transport).useVerificationToken?.({ identifier, token })).resolves.toBeNull();
  });

  it("propagates a real failure rather than silently inviting a retry", async () => {
    const { transport } = fakeTransport(() => ({
      status: 401,
      body: { error: { code: "unauthenticated", message: "Internal secret required" } },
    }));

    await expect(apiAdapter(transport).useVerificationToken?.({ identifier, token })).rejects.toThrow(
      "Internal secret required",
    );
  });

  it("keeps the rest of the adapter surface working without touching the API", async () => {
    const { transport, calls } = fakeTransport(() => ({ status: 500, body: {} }));
    const adapter = apiAdapter(transport);

    const user = await adapter.createUser?.({
      id: "",
      email: "Person@Tenant.test",
      emailVerified: null,
    });
    expect(user?.id).toBeTruthy();
    await expect(adapter.getUserByEmail?.("person@tenant.TEST")).resolves.toEqual(user);
    expect(calls).toHaveLength(0);
  });
});
