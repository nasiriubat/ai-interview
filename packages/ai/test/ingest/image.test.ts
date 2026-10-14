import { describe, expect, it } from "vitest";
import { sanitizeImage } from "../../src/ingest/image.js";
import { IngestRejected } from "../../src/ingest/limits.js";

/** Builds images in the test so the metadata being stripped is visible in the test itself. */
async function jpegWithGps(): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return await sharp({ create: { width: 64, height: 48, channels: 3, background: "#336699" } })
    .withExif({ IFD3: { GPSLatitudeRef: "N", GPSLatitude: "60/1 10/1 30/1" } })
    .jpeg()
    .toBuffer();
}

describe("sanitizeImage", () => {
  it("drops EXIF, including GPS, and keeps the pixels", async () => {
    const sharp = (await import("sharp")).default;
    const original = await jpegWithGps();
    expect((await sharp(original).metadata()).exif).toBeDefined();

    const clean = await sanitizeImage(original, "image/jpeg");
    const after = await sharp(clean).metadata();
    expect(after.exif).toBeUndefined();
    expect(after.width).toBe(64);
    expect(after.height).toBe(48);
  });

  it("refuses bytes that carry the signature but are not an image", async () => {
    const lie = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64),
    ]);
    await expect(sanitizeImage(lie, "image/png")).rejects.toBeInstanceOf(IngestRejected);
  });
});
