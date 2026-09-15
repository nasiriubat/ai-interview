import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ApiError, apiErrorFromResponse, isApiError } from "@/lib/api/errors";
import { createTransport, request, withQuery, type Transport } from "@/lib/api/http";

function fakeTransport(
  handler: (path: string, init?: RequestInit) => Response | Promise<Response>,
): Transport {
  return { fetch: (path, init) => Promise.resolve(handler(path, init)) };
}

describe("apiErrorFromResponse", () => {
  it("unwraps the contract error envelope", async () => {
    const res = new Response(
      JSON.stringify({ error: { code: "forbidden", message: "No", details: { x: 1 } } }),
      {
        status: 403,
      },
    );
    const err = await apiErrorFromResponse(res);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("forbidden");
    expect(err.message).toBe("No");
    expect(err.status).toBe(403);
    expect(err.details).toEqual({ x: 1 });
    expect(err.isForbidden).toBe(true);
  });

  it("falls back to a status-derived code for non-JSON bodies", async () => {
    const err = await apiErrorFromResponse(new Response("Bad gateway", { status: 502 }));
    expect(err.code).toBe("server_error");
    expect(err.message).toBe("Bad gateway");
    const nf = await apiErrorFromResponse(new Response("", { status: 404, statusText: "Not Found" }));
    expect(nf.code).toBe("not_found");
    expect(nf.isNotFound).toBe(true);
  });
});

describe("request", () => {
  it("sends JSON and validates the response with the schema", async () => {
    let seen: { path: string; init?: RequestInit } | undefined;
    const transport = fakeTransport((path, init) => {
      seen = { path, ...(init ? { init } : {}) };
      return new Response(JSON.stringify({ ok: true, n: 2 }), {
        headers: { "content-type": "application/json" },
      });
    });
    const out = await request(transport, {
      method: "POST",
      path: "/x",
      body: { a: 1 },
      query: { q: "v", skip: undefined },
      schema: z.object({ ok: z.literal(true), n: z.number() }),
    });
    expect(out).toEqual({ ok: true, n: 2 });
    expect(seen?.path).toBe("/x?q=v");
    expect(seen?.init?.method).toBe("POST");
    expect(seen?.init?.body).toBe('{"a":1}');
    expect((seen?.init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("passes a FormData body through so the runtime sets the multipart boundary", async () => {
    let seen: RequestInit | undefined;
    const transport = fakeTransport((_path, init) => {
      seen = init;
      return new Response(JSON.stringify({ attachment: { id: "a1" } }));
    });
    const form = new FormData();
    form.append("file", new Blob(["bytes"], { type: "audio/webm" }), "recording.webm");
    form.append("durationMs", "4200");
    await request(transport, { method: "POST", path: "/p/session/attachments", body: form });
    expect(seen?.body).toBe(form);
    const headers = seen?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBeUndefined();
    expect(headers.Accept).toBe("application/json");
  });

  it("throws an ApiError on 4xx with the envelope's code", async () => {
    const transport = fakeTransport(
      () =>
        new Response(JSON.stringify({ error: { code: "validation", message: "bad email" } }), {
          status: 400,
        }),
    );
    await expect(request(transport, { path: "/y" })).rejects.toMatchObject({
      code: "validation",
      status: 400,
    });
  });

  it("throws invalid_response when the schema does not match", async () => {
    const transport = fakeTransport(() => new Response(JSON.stringify({ nope: 1 })));
    const err = await request(transport, { path: "/z", schema: z.object({ ok: z.boolean() }) }).catch(
      (e: unknown) => e,
    );
    expect(isApiError(err)).toBe(true);
    expect((err as ApiError).code).toBe("invalid_response");
  });

  it("wraps network failures as network_error", async () => {
    const transport: Transport = { fetch: () => Promise.reject(new Error("offline")) };
    await expect(request(transport, { path: "/n" })).rejects.toMatchObject({
      code: "network_error",
      status: 0,
    });
  });
});

describe("helpers", () => {
  it("withQuery drops empty values", () => {
    expect(withQuery("/a", { b: 1, c: "", d: undefined, e: true })).toBe("/a?b=1&e=true");
    expect(withQuery("/a")).toBe("/a");
  });

  it("createTransport prefixes the base and merges headers", async () => {
    const original = globalThis.fetch;
    let captured: { url: string; headers: Record<string, string> } | undefined;
    globalThis.fetch = ((url: string, init?: RequestInit): Promise<Response> => {
      captured = { url, headers: init?.headers as Record<string, string> };
      return Promise.resolve(new Response("{}"));
    }) as typeof fetch;
    try {
      const t = createTransport("https://api.example/api/v1/", () => ({ Authorization: "Bearer t" }));
      await t.fetch("/me", { headers: { Accept: "application/json" } });
      expect(captured?.url).toBe("https://api.example/api/v1/me");
      expect(captured?.headers).toMatchObject({ Authorization: "Bearer t", Accept: "application/json" });
    } finally {
      globalThis.fetch = original;
    }
  });
});
