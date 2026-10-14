/**
 * What the site logo may be (D-433), checked from the bytes and never from the name or the
 * declared type, which are whatever the browser or the caller said.
 *
 * Raster only. SVG is refused because it is a document that can carry script, and a logo is
 * served on the product's own origin to every visitor. PNG, JPEG and WebP are recognised by their
 * signatures, and the width and height are read from the header so a 1 x 1 tracking pixel or a
 * 30 000 px wide banner is refused before it is stored. The image is not decoded: a header that
 * lies produces a broken image for the operator who uploaded it, not code running anywhere.
 */

export const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type LogoType = (typeof LOGO_TYPES)[number];

export const LOGO_MAX_BYTES = 256 * 1024;
export const LOGO_MIN_SIDE = 16;
export const LOGO_MAX_SIDE = 4096;
/** A wordmark is wide; past this it is a banner and would be unreadable at 28 px high. */
export const LOGO_MAX_ASPECT = 12;

export interface LogoInfo {
  contentType: LogoType;
  width: number;
  height: number;
}

export type LogoProblem = "empty" | "too_large" | "unsupported_type" | "unreadable" | "bad_dimensions";

export type LogoCheck = { ok: true; info: LogoInfo } | { ok: false; problem: LogoProblem };

export function inspectLogo(buf: Buffer): LogoCheck {
  if (buf.length === 0) return { ok: false, problem: "empty" };
  if (buf.length > LOGO_MAX_BYTES) return { ok: false, problem: "too_large" };
  const type = sniff(buf);
  if (!type) return { ok: false, problem: "unsupported_type" };
  const size = dimensions(buf, type);
  if (!size) return { ok: false, problem: "unreadable" };
  const { width, height } = size;
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  if (short < LOGO_MIN_SIDE || long > LOGO_MAX_SIDE || long / short > LOGO_MAX_ASPECT) {
    return { ok: false, problem: "bad_dimensions" };
  }
  return { ok: true, info: { contentType: type, width, height } };
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sniff(buf: Buffer): LogoType | null {
  if (buf.length >= 24 && buf.subarray(0, 8).equals(PNG_SIG)) return "image/png";
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (
    buf.length >= 30 &&
    buf.toString("latin1", 0, 4) === "RIFF" &&
    buf.toString("latin1", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function dimensions(buf: Buffer, type: LogoType): { width: number; height: number } | null {
  switch (type) {
    case "image/png":
      // The first chunk must be IHDR: width and height are big-endian at 16 and 20.
      if (buf.toString("latin1", 12, 16) !== "IHDR") return null;
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    case "image/jpeg":
      return jpegSize(buf);
    case "image/webp":
      return webpSize(buf);
  }
}

/** Walks the JPEG markers to the first start-of-frame, which carries the size. */
function jpegSize(buf: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf.readUInt8(i + 1);
    // Fill bytes and standalone markers carry no length.
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const length = buf.readUInt16BE(i + 2);
    if (length < 2) return null;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    if (marker === 0xda || marker === 0xd9) return null;
    i += 2 + length;
  }
  return null;
}

function webpSize(buf: Buffer): { width: number; height: number } | null {
  const chunk = buf.toString("latin1", 12, 16);
  if (chunk === "VP8 ") {
    // Lossy: a keyframe start code, then 14-bit width and height, little-endian.
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  }
  return null;
}
