import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
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

  /**
   * The platform-wide hash of an address: the same address gives the same value in every campaign
   * of every tenant. That is what let one leaked table be joined to another, so new rows no longer
   * use it (`campaignEmailHash`). It remains for one reason: rows written before migration 0016
   * hold this value and cannot be re-salted without the address, so a returning person's lookup
   * tries it as well, and upgrades the row when it matches (D-142).
   */
  hashEmail(email: string): string {
    return createHmac("sha256", this.key).update(normalizeEmail(email)).digest("hex");
  }

  /**
   * The hash of an address within one campaign: HKDF with the campaign id as salt, so the value
   * differs for every campaign and tenant and cannot be matched across them, and the `h2:` prefix
   * says which kind a stored value is (D-142).
   */
  campaignEmailHash(email: string, campaignId: string): string {
    const subkey = this.subkey("aidp:email-hash:v2", campaignId);
    return `h2:${createHmac("sha256", subkey).update(normalizeEmail(email)).digest("hex")}`;
  }

  /**
   * A keyed tag of (campaign, participant). Stored on the campaign-level hash row, so that deleting
   * a participant can find and remove the row without the participant row pointing at it. Only the
   * platform key can compute it: a copy of the database cannot join the two tables.
   */
  participantTag(campaignId: string, participantId: string): string {
    const subkey = this.subkey("aidp:owner-tag:v1", campaignId);
    return createHmac("sha256", subkey).update(participantId).digest("hex");
  }

  /** The key that seals a resume pointer when the person returns by typing their address. */
  resumeKeyForEmail(email: string, campaignId: string): Buffer {
    const subkey = this.subkey("aidp:resume:email:v1", campaignId);
    return createHmac("sha256", subkey).update(normalizeEmail(email)).digest();
  }

  /**
   * The key that seals a resume pointer when the person returns through a personal invitation. The
   * token is a secret only they hold (the database keeps its hash), so even the platform key does
   * not recover the pointer without it.
   */
  resumeKeyForToken(token: string, campaignId: string): Buffer {
    const subkey = this.subkey("aidp:resume:token:v1", campaignId);
    return createHmac("sha256", subkey).update(token).digest();
  }

  /** AES-256-GCM under a caller-held key; the same envelope as `encrypt`, tagged `r1`. */
  seal(key: Buffer, plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return ["r1", b64(iv), b64(cipher.getAuthTag()), b64(ct)].join(".");
  }

  /** The plaintext of `seal`, or null when the key is wrong or the value is not a seal. */
  unseal(key: Buffer, sealed: string): string | null {
    const [v, iv, tag, ct] = sealed.split(".");
    if (v !== "r1" || !iv || !tag || !ct) return null;
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, unb64(iv));
      decipher.setAuthTag(unb64(tag));
      return Buffer.concat([decipher.update(unb64(ct)), decipher.final()]).toString("utf8");
    } catch {
      return null;
    }
  }

  /** A purpose-bound key from the platform key, so no two uses share key material. */
  private subkey(info: string, salt: string): Buffer {
    return Buffer.from(
      hkdfSync("sha256", this.key, Buffer.from(salt, "utf8"), Buffer.from(info, "utf8"), 32),
    );
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
