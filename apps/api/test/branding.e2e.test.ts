import type { Server } from "node:http";
import { deflateSync } from "node:zlib";
import { withSystemTenant } from "@aidp/db";
import { describeDb } from "@aidp/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inspectLogo } from "../src/modules/branding/image.js";
import { fakeModelServer, testWorld, type TestWorld } from "./helpers.js";

/** A real, decodable PNG of the given size (grey, 8-bit). */
function png(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const raw = Buffer.alloc((width + 1) * height, 0x80);
  for (let y = 0; y < height; y++) raw[y * (width + 1)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The start of a baseline JPEG: SOI, an APP0 segment, then SOF0 with the size. */
function jpegHeader(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, 0, 0, 0, 0, 0x01, 0x01, 0x11, 0x00]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

/** A lossless WebP header with the size. */
function webpHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write("RIFF", 0, "latin1");
  buf.writeUInt32LE(22, 4);
  buf.write("WEBP", 8, "latin1");
  buf.write("VP8L", 12, "latin1");
  buf.writeUInt32LE(10, 16);
  buf[20] = 0x2f;
  buf.writeUInt32LE(((height - 1) << 14) | (width - 1), 21);
  return buf;
}

describe("logo checks (D-433)", () => {
  it("reads the size of PNG, JPEG and WebP from the bytes", () => {
    expect(inspectLogo(png(200, 50))).toEqual({
      ok: true,
      info: { contentType: "image/png", width: 200, height: 50 },
    });
    expect(inspectLogo(jpegHeader(320, 80))).toEqual({
      ok: true,
      info: { contentType: "image/jpeg", width: 320, height: 80 },
    });
    expect(inspectLogo(webpHeader(120, 40))).toEqual({
      ok: true,
      info: { contentType: "image/webp", width: 120, height: 40 },
    });
  });

  it("refuses SVG, anything else that is not a raster image, and an empty file", () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(inspectLogo(svg)).toEqual({ ok: false, problem: "unsupported_type" });
    expect(inspectLogo(Buffer.from("GIF89a....."))).toEqual({ ok: false, problem: "unsupported_type" });
    expect(inspectLogo(Buffer.alloc(0))).toEqual({ ok: false, problem: "empty" });
  });

  it("refuses a file over 256 KB and sizes that are not a logo", () => {
    expect(inspectLogo(Buffer.concat([png(20, 20), Buffer.alloc(256 * 1024)]))).toEqual({
      ok: false,
      problem: "too_large",
    });
    expect(inspectLogo(png(1, 1))).toEqual({ ok: false, problem: "bad_dimensions" });
    expect(inspectLogo(jpegHeader(5000, 1000))).toEqual({ ok: false, problem: "bad_dimensions" });
    expect(inspectLogo(png(1300, 100))).toEqual({ ok: false, problem: "bad_dimensions" });
  });

  it("refuses a PNG signature without its header", () => {
    const broken = Buffer.concat([png(20, 20).subarray(0, 12), Buffer.from("XXXX"), Buffer.alloc(16)]);
    expect(inspectLogo(broken)).toEqual({ ok: false, problem: "unreadable" });
  });
});

describeDb("platform branding: the public name and logo (D-430 to D-434)", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };
  const as = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    model = await fakeModelServer(() => "x");
    world = await testWorld(model.url, { RATE_LIMIT_MAX: "100000" });
    await world.db.platformAsset.deleteMany({});
  });
  afterAll(async () => {
    await world.db.platformAsset.deleteMany({});
    await world.db.setting.deleteMany({ where: { scope: "platform", key: "branding.productName" } });
    await world.close();
    model.server.close();
  });

  function multipart(file: { name: string; type: string; body: Buffer }): {
    payload: Buffer;
    headers: Record<string, string>;
  } {
    const boundary = `----logo${Math.random().toString(36).slice(2)}`;
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
          `Content-Type: ${file.type}\r\n\r\n`,
      ),
      file.body,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return { payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
  }

  const upload = (token: string, file: { name: string; type: string; body: Buffer }) => {
    const m = multipart(file);
    return world.app.inject({
      method: "PUT",
      url: "/api/v1/operator/branding/logo",
      headers: { ...as(token), ...m.headers },
      payload: m.payload,
    });
  };

  it("answers the platform's name to anyone, without a credential, and never a tenant's override", async () => {
    // A tenant names its own interviews; that must not rename the public site.
    // Written as the system, the way the settings route writes once it has checked the caller.
    await withSystemTenant(() =>
      world.ctx.settings.set(
        { scope: "tenant", scopeId: world.companyId },
        { "branding.productName": "Tenant Brand" },
        null,
      ),
    );
    const res = await world.app.inject({ method: "GET", url: "/api/v1/public/branding" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=60");
    expect(res.json()).toEqual({ productName: "Discovery", hasLogo: false, logoVersion: null });

    await withSystemTenant(() =>
      world.ctx.settings.set({ scope: "platform", scopeId: "" }, { "branding.productName": "Askel" }, null),
    );
    const renamed = await world.app.inject({ method: "GET", url: "/api/v1/public/branding" });
    expect(renamed.json<{ productName: string }>().productName).toBe("Askel");
  });

  it("serves no logo until one is uploaded", async () => {
    const res = await world.app.inject({ method: "GET", url: "/api/v1/public/branding/logo" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("lets only the platform operator upload, and refuses what is not a PNG, JPEG or WebP", async () => {
    const file = { name: "logo.png", type: "image/png", body: png(240, 60) };
    expect((await upload(world.adminToken, file)).statusCode).toBe(403);
    expect(
      (
        await world.app.inject({
          method: "PUT",
          url: "/api/v1/operator/branding/logo",
          headers: multipart(file).headers,
          payload: multipart(file).payload,
        })
      ).statusCode,
    ).toBe(401);

    const svg = await upload(world.operatorToken, {
      name: "logo.svg",
      type: "image/svg+xml",
      body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    });
    expect(svg.statusCode).toBe(400);
    expect(svg.json<{ error: { message: string } }>().error.message).toMatch(/SVG is not accepted/);

    // A declared type is not believed: an SVG named and typed as a PNG is still refused.
    const disguised = await upload(world.operatorToken, {
      name: "logo.png",
      type: "image/png",
      body: Buffer.from("<svg onload='alert(1)'/>"),
    });
    expect(disguised.statusCode).toBe(400);

    const big = await upload(world.operatorToken, {
      name: "logo.png",
      type: "image/png",
      body: Buffer.concat([png(40, 40), Buffer.alloc(300 * 1024)]),
    });
    expect(big.statusCode).toBe(413);

    const tiny = await upload(world.operatorToken, { name: "p.png", type: "image/png", body: png(2, 2) });
    expect(tiny.statusCode).toBe(400);
    expect(await world.db.platformAsset.count()).toBe(0);
  });

  it("stores, serves, replaces and removes the logo, each change audited", async () => {
    const first = png(240, 60);
    const res = await upload(world.operatorToken, {
      name: "logo.png",
      type: "application/octet-stream",
      body: first,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ hasLogo: boolean; logoVersion: string; productName: string }>();
    expect(body.hasLogo).toBe(true);
    expect(body.logoVersion).toMatch(/^[0-9a-f]{16}$/);

    const pub = await world.app.inject({ method: "GET", url: "/api/v1/public/branding" });
    expect(pub.json()).toMatchObject({ hasLogo: true, logoVersion: body.logoVersion });

    const served = await world.app.inject({
      method: "GET",
      url: `/api/v1/public/branding/logo?v=${body.logoVersion}`,
    });
    expect(served.statusCode).toBe(200);
    // The sniffed type, not the declared one.
    expect(served.headers["content-type"]).toBe("image/png");
    expect(served.headers["x-content-type-options"]).toBe("nosniff");
    expect(served.headers["content-security-policy"]).toContain("sandbox");
    expect(served.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(served.headers.etag).toBe(`"${body.logoVersion}"`);
    expect(Buffer.compare(served.rawPayload, first)).toBe(0);

    // A URL without the current version is only cached briefly, and a matching ETag is a 304.
    const unpinned = await world.app.inject({ method: "GET", url: "/api/v1/public/branding/logo?v=stale" });
    expect(unpinned.headers["cache-control"]).toBe("public, max-age=60");
    const revalidated = await world.app.inject({
      method: "GET",
      url: "/api/v1/public/branding/logo",
      headers: { "if-none-match": `"${body.logoVersion}"` },
    });
    expect(revalidated.statusCode).toBe(304);

    const op = await world.db.user.findFirstOrThrow({ where: { email: world.operatorEmail } });
    const updated = await world.db.auditLog.findFirst({
      where: { action: "branding.logo_update", actorId: op.id },
      orderBy: { createdAt: "desc" },
    });
    expect(updated).toMatchObject({
      companyId: op.companyId,
      targetType: "platform",
      targetId: "branding.logo",
    });
    expect(updated?.diff).toMatchObject({ contentType: "image/png", width: 240, height: 60 });

    // Replacing changes the version, so a browser holding the old one fetches the new URL.
    const second = await upload(world.operatorToken, {
      name: "logo.png",
      type: "image/png",
      body: png(300, 60),
    });
    const v2 = second.json<{ logoVersion: string }>().logoVersion;
    expect(v2).not.toBe(body.logoVersion);
    expect(await world.db.platformAsset.count()).toBe(1);

    expect(
      (
        await world.app.inject({
          method: "DELETE",
          url: "/api/v1/operator/branding/logo",
          headers: as(world.adminToken),
        })
      ).statusCode,
    ).toBe(403);
    const removed = await world.app.inject({
      method: "DELETE",
      url: "/api/v1/operator/branding/logo",
      headers: as(world.operatorToken),
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ hasLogo: false, logoVersion: null });
    expect((await world.app.inject({ method: "GET", url: "/api/v1/public/branding/logo" })).statusCode).toBe(
      404,
    );
    expect(
      await world.db.auditLog.count({ where: { action: "branding.logo_remove", actorId: op.id } }),
    ).toBeGreaterThan(0);
  });
});
