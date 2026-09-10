import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Secrets at rest (NFR-07): AES-256-GCM with a platform key. Format: v1.<iv>.<tag>.<ciphertext>, base64url.
 * Email hashes for uniqueness (FR-04): HMAC-SHA256 with a platform salt, never reversible.
 */
export class Crypto {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, "base64");
    if (this.key.length !== 32) throw new Error("PLATFORM_ENCRYPTION_KEY must decode to 32 bytes");
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return ["v1", b64(iv), b64(cipher.getAuthTag()), b64(ct)].join(".");
  }

  decrypt(token: string): string {
    const [v, iv, tag, ct] = token.split(".");
    if (v !== "v1" || !iv || !tag || !ct) throw new Error("Malformed ciphertext");
    const decipher = createDecipheriv("aes-256-gcm", this.key, unb64(iv));
    decipher.setAuthTag(unb64(tag));
    return Buffer.concat([decipher.update(unb64(ct)), decipher.final()]).toString("utf8");
  }

  /** Stable, salted, case-insensitive hash of an email address. */
  hashEmail(email: string): string {
    return createHmac("sha256", this.key).update(normalizeEmail(email)).digest("hex");
  }

  /** Hash of a bearer token for storage; tokens themselves are random and shown once. */
  hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  verifyTokenHash(token: string, hash: string): boolean {
    const a = Buffer.from(this.hashToken(token), "hex");
    const b = Buffer.from(hash, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

export function newToken(bytes = 32): string {
  return b64(randomBytes(bytes));
}

export function newNumericCode(digits = 6): string {
  const max = 10 ** digits;
  return String(randomBytes(4).readUInt32BE(0) % max).padStart(digits, "0");
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function emailDomain(email: string): string {
  return normalizeEmail(email).split("@")[1] ?? "";
}

const b64 = (b: Buffer): string => b.toString("base64url");
const unb64 = (s: string): Buffer => Buffer.from(s, "base64url");
