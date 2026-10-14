import { IngestRejected } from "./limits.js";

/** Pixels a decoder is willing to allocate for. 40 megapixels is a large phone photograph. */
const MAX_PIXELS = 40_000_000;

/**
 * Re-encodes a PNG or JPEG so that nothing but pixels survives (P11, D-160).
 *
 * A photograph carries its author's GPS position, device, timestamps and often a thumbnail of the
 * original frame. A participant attaching a screenshot of a whiteboard did not mean to hand any of
 * that to a model provider or to the people reading the transcript. Decoding and re-encoding is
 * the dependable way to drop every ancillary block at once, and it doubles as validation: bytes
 * that carry a PNG signature but cannot be decoded as one are refused here.
 *
 * The orientation tag is applied before it is dropped, so a phone photo still displays upright.
 * `limitInputPixels` makes a decompression bomb (a small file declaring a vast canvas) an error
 * rather than an allocation.
 */
export async function sanitizeImage(bytes: Buffer, mime: "image/png" | "image/jpeg"): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  try {
    const pipeline = sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: "error" }).rotate();
    return await (
      mime === "image/png"
        ? pipeline.png({ compressionLevel: 9 })
        : pipeline.jpeg({ quality: 90, mozjpeg: false })
    ).toBuffer();
  } catch {
    throw new IngestRejected("content_mismatch", "That image could not be read");
  }
}
