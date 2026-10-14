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
 * What a ciphertext is for. It is bound into the authenticated data of a v2 token, so a value
 * copied from a provider's key column into a setting fails to decrypt instead of being accepted.
 */
export type CryptoPurpose =
  "provider.apiKey" | "provider.headers" | "setting.secret" | "campaign.linkToken" | "generic";

/**
 * Secrets at rest (NFR-07, P9, D-164): AES-256-GCM under a key derived from the platform key.
 *
 * Format `v2.<kid>.<iv>.<tag>.<ciphertext>` (base64url). `kid` names the key that sealed it, so a
 * deployment can hold more than one key while stored values move from the old to the new. The AES
 * key is HKDF-derived from the platform key (`aidp/enc/v2`), so the same key material is never used
 * both to encrypt and to MAC, and the additional authenticated data is `v2.<kid>.<purpose>`.
 *
 * `v1.<iv>.<tag>.<ciphertext>` (the raw key, no authenticated data, no key id) is read forever and
 * never written. Its key is not named, so reading it tries each key in the ring.
 *
 * The key ring is `PLATFORM_ENCRYPTION_KEY` (active: everything is written under it) plus, during
 * a rotation, `PLATFORM_ENCRYPTION_KEY_PREVIOUS` (read only). The `crypto.rekey` job moves stored
 * values to the active key; when none is left under the previous one it can be removed.
 *
 * Email hashes (FR-04) are HMACs and cannot be re-keyed, because the address is not stored. They
 * are looked up under every key in the ring and rewritten under the active one when the person
 * returns, so a previous key can be retired once no open campaign still needs its hashes.
 */
export class Crypto {
  private readonly ring: { kid: string; key: Buffer }[];

  /**
   * `previousKeys` are base64 keys that remain readable. The first entry of the ring, the one
   * passed as `base64Key`, is the active key.
   */
  constructor(base64Key: string, previousKeys: string[] = []) {
    const keys = [base64Key, ...previousKeys].map((b64, i) => {
      const key = Buffer.from(b64.trim(), "base64");
      if (key.length !== 32) {
        throw new Error(
          i === 0
            ? "PLATFORM_ENCRYPTION_KEY must decode to 32 bytes"
            : "PLATFORM_ENCRYPTION_KEY_PREVIOUS must decode to 32 bytes",
        );
      }
      return { kid: keyId(key), key };
    });
    // The same key listed twice is one key: a previous key equal to the active one is harmless.
    const seen = new Set<string>();
    this.ring = keys.filter((k) => (seen.has(k.kid) ? false : (seen.add(k.kid), true)));
  }

  /** Builds the ring from process configuration. `PLATFORM_ENCRYPTION_KEY_PREVIOUS` may list several, comma-separated. */
  static fromEnv(env: {
    PLATFORM_ENCRYPTION_KEY: string;
    PLATFORM_ENCRYPTION_KEY_PREVIOUS?: string | undefined;
  }): Crypto {
    const previous = (env.PLATFORM_ENCRYPTION_KEY_PREVIOUS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return new Crypto(env.PLATFORM_ENCRYPTION_KEY, previous);
  }

  private get active(): { kid: string; key: Buffer } {
    return this.ring[0] as { kid: string; key: Buffer };
  }

  /** The id of the key new values are sealed under. */
  get activeKeyId(): string {
    return this.active.kid;
  }

  /** Every key id the ring can read, active first. */
  get keyIds(): string[] {
    return this.ring.map((k) => k.kid);
  }

  encrypt(plain: string, purpose: CryptoPurpose = "generic"): string {
    const { kid, key } = this.active;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey(key), iv);
    cipher.setAAD(aad(kid, purpose));
    const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return ["v2", kid, b64(iv), b64(cipher.getAuthTag()), b64(ct)].join(".");
  }

  /**
   * Reads either format. A v2 token must be opened with the purpose it was sealed for; a v1 token
   * carries none and is opened by whichever key in the ring authenticates it.
   */
  decrypt(token: string, purpose: CryptoPurpose = "generic"): string {
    const parts = token.split(".");
    if (parts[0] === "v2" && parts.length === 5) {
      const [, kid, iv, tag, ct] = parts as [string, string, string, string, string];
      const entry = this.ring.find((k) => k.kid === kid);
      if (!entry) throw new Error(`Ciphertext is sealed under key ${kid}, which is not in the key ring`);
      const decipher = createDecipheriv("aes-256-gcm", encryptionKey(entry.key), unb64(iv));
      decipher.setAAD(aad(kid, purpose));
      decipher.setAuthTag(unb64(tag));
      return Buffer.concat([decipher.update(unb64(ct)), decipher.final()]).toString("utf8");
    }
    if (parts[0] === "v1" && parts.length === 4) {
      const [, iv, tag, ct] = parts as [string, string, string, string];
      for (const { key } of this.ring) {
        try {
          const decipher = createDecipheriv("aes-256-gcm", key, unb64(iv));
          decipher.setAuthTag(unb64(tag));
          return Buffer.concat([decipher.update(unb64(ct)), decipher.final()]).toString("utf8");
        } catch {
          // not this key
        }
      }
      throw new Error("Ciphertext does not authenticate under any key in the key ring");
    }
    throw new Error("Malformed ciphertext");
  }

  /** Which key sealed a token: its id for v2, `v1` for the legacy format, null if it is neither. */
  keyIdOf(token: string): string | null {
    const parts = token.split(".");
    if (parts[0] === "v2" && parts.length === 5) return parts[1] ?? null;
    if (parts[0] === "v1" && parts.length === 4) return "v1";
    return null;
  }

  /** True when the token is already v2 under the active key. */
  isCurrent(token: string): boolean {
    return this.keyIdOf(token) === this.active.kid;
  }

  /**
   * The platform-wide hash of an address: the same address gives the same value in every campaign
   * of every tenant. That is what let one leaked table be joined to another, so new rows no longer
   * use it (`campaignEmailHash`). It remains for one reason: rows written before migration 0016
   * hold this value and cannot be re-salted without the address, so a returning person's lookup
   * tries it as well, and upgrades the row when it matches (D-142).
   */
  hashEmail(email: string): string {
    return createHmac("sha256", this.active.key).update(normalizeEmail(email)).digest("hex");
  }

  /** The platform-wide hash under every key in the ring: what an older row may hold (D-164). */
  hashEmailCandidates(email: string): string[] {
    return this.ring.map(({ key }) => createHmac("sha256", key).update(normalizeEmail(email)).digest("hex"));
  }

  /**
   * The hash of an address within one campaign: HKDF with the campaign id as salt, so the value
   * differs for every campaign and tenant and cannot be matched across them, and the `h2:` prefix
   * says which kind a stored value is (D-142).
   */
  campaignEmailHash(email: string, campaignId: string): string {
    return this.campaignHashUnder(this.active.key, email, campaignId);
  }

  /**
   * Every value an address may be stored as in a campaign: under the active key first, then under
   * each previous key. A match under a previous key is rewritten under the active one (D-164).
   */
  campaignEmailHashCandidates(email: string, campaignId: string): string[] {
    return this.ring.map(({ key }) => this.campaignHashUnder(key, email, campaignId));
  }

  private campaignHashUnder(masterKey: Buffer, email: string, campaignId: string): string {
    const subkey = derive(masterKey, "aidp:email-hash:v2", campaignId);
    return `h2:${createHmac("sha256", subkey).update(normalizeEmail(email)).digest("hex")}`;
  }

  /**
   * A keyed tag of (campaign, participant). Stored on the campaign-level hash row, so that deleting
   * a participant can find and remove the row without the participant row pointing at it. Only the
   * platform key can compute it: a copy of the database cannot join the two tables.
   */
  participantTag(campaignId: string, participantId: string): string {
    return this.tagUnder(this.active.key, campaignId, participantId);
  }

  /** The tag under every key in the ring, for finding a row written before a rotation. */
  participantTags(campaignId: string, participantId: string): string[] {
    return this.ring.map(({ key }) => this.tagUnder(key, campaignId, participantId));
  }

  private tagUnder(masterKey: Buffer, campaignId: string, participantId: string): string {
    const subkey = derive(masterKey, "aidp:owner-tag:v1", campaignId);
    return createHmac("sha256", subkey).update(participantId).digest("hex");
  }

  /** The key that seals a resume pointer when the person returns by typing their address. */
  resumeKeyForEmail(email: string, campaignId: string): Buffer {
    return this.resumeEmailUnder(this.active.key, email, campaignId);
  }

  /** The same key under every key in the ring: a pointer sealed before a rotation opens with these. */
  resumeKeysForEmail(email: string, campaignId: string): Buffer[] {
    return this.ring.map(({ key }) => this.resumeEmailUnder(key, email, campaignId));
  }

  private resumeEmailUnder(masterKey: Buffer, email: string, campaignId: string): Buffer {
    const subkey = derive(masterKey, "aidp:resume:email:v1", campaignId);
    return createHmac("sha256", subkey).update(normalizeEmail(email)).digest();
  }

  /**
   * The key that seals a resume pointer when the person returns through a personal invitation. The
   * token is a secret only they hold (the database keeps its hash), so even the platform key does
   * not recover the pointer without it.
   */
  resumeKeyForToken(token: string, campaignId: string): Buffer {
    return this.resumeTokenUnder(this.active.key, token, campaignId);
  }

  resumeKeysForToken(token: string, campaignId: string): Buffer[] {
    return this.ring.map(({ key }) => this.resumeTokenUnder(key, token, campaignId));
  }

  private resumeTokenUnder(masterKey: Buffer, token: string, campaignId: string): Buffer {
    const subkey = derive(masterKey, "aidp:resume:token:v1", campaignId);
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

  /** `unseal` with each candidate key in turn; the first that opens it wins. */
  unsealAny(keys: Buffer[], sealed: string): string | null {
    for (const key of keys) {
      const plain = this.unseal(key, sealed);
      if (plain !== null) return plain;
    }
    return null;
  }

  /**
   * A key for sealing or signing a bulk artefact (a tenant export, D-225), derived from the
   * platform key and bound to what it is for (`info`) and to whom (`salt`). Under the active key,
   * or under the ring key named by `kid` when an older artefact is being opened. Null when `kid`
   * names a key that is no longer in the ring.
   */
  bulkKey(info: string, salt: string, kid?: string): { kid: string; key: Buffer } | null {
    const entry = kid === undefined ? this.active : this.ring.find((k) => k.kid === kid);
    if (!entry) return null;
    return { kid: entry.kid, key: derive(entry.key, `aidp:bulk:${info}`, salt) };
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

/** A purpose-bound key from a master key, so no two uses share key material. */
function derive(master: Buffer, info: string, salt: string): Buffer {
  return Buffer.from(hkdfSync("sha256", master, Buffer.from(salt, "utf8"), Buffer.from(info, "utf8"), 32));
}

/** The AES key for v2 ciphertext: derived, so the master key is never itself a cipher key. */
function encryptionKey(master: Buffer): Buffer {
  return derive(master, "aidp/enc/v2", "");
}

/** A short public name for a key. Derived with HKDF, so it reveals nothing usable about the key. */
function keyId(master: Buffer): string {
  return Buffer.from(
    hkdfSync("sha256", master, Buffer.alloc(0), Buffer.from("aidp/kid", "utf8"), 6),
  ).toString("hex");
}

const aad = (kid: string, purpose: CryptoPurpose): Buffer => Buffer.from(`v2.${kid}.${purpose}`, "utf8");

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
