import { createCipheriv, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Crypto, emailDomain, newNumericCode, newToken } from "../src/crypto.js";

const newKey = (): string => randomBytes(32).toString("base64");

/** The v1 format as the code that wrote it did: the raw key, no authenticated data, no key id. */
function legacyV1(base64Key: string, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(base64Key, "base64"), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ct.toString("base64url"),
  ].join(".");
}

describe("Crypto", () => {
  const c = new Crypto(newKey());
  it("round-trips secrets and rejects tampering", () => {
    const enc = c.encrypt("sk-secret");
    expect(enc).not.toContain("sk-secret");
    expect(c.decrypt(enc)).toBe("sk-secret");
    const parts = enc.split(".");
    const ct = parts[4]!;
    parts[4] = `${ct.slice(0, -2)}AA`;
    expect(() => c.decrypt(parts.join("."))).toThrow();
  });
  it("hashes emails case-insensitively and verifies token hashes in constant time", () => {
    expect(c.hashEmail("Nasir@Example.com ")).toBe(c.hashEmail("nasir@example.com"));
    const t = newToken();
    expect(c.verifyTokenHash(t, c.hashToken(t))).toBe(true);
    expect(c.verifyTokenHash(newToken(), c.hashToken(t))).toBe(false);
    expect(newNumericCode()).toMatch(/^\d{6}$/);
    expect(emailDomain("a@B.io")).toBe("b.io");
  });
  it("gives the same address a different hash in every campaign, and none equal to the old one", () => {
    const a = c.campaignEmailHash("Nasir@Example.com ", "campaign_a");
    const b = c.campaignEmailHash("nasir@example.com", "campaign_b");

    expect(a).toMatch(/^h2:[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(c.campaignEmailHash("nasir@example.com", "campaign_a")).toBe(a);
    expect(a).not.toContain(c.hashEmail("nasir@example.com"));
    // Another platform key gives another value: a leaked table is not matchable by a third party.
    const other = new Crypto(newKey());
    expect(other.campaignEmailHash("nasir@example.com", "campaign_a")).not.toBe(a);
  });
  it("derives a participant tag that depends on the campaign and the participant", () => {
    expect(c.participantTag("camp", "p1")).toBe(c.participantTag("camp", "p1"));
    expect(c.participantTag("camp", "p1")).not.toBe(c.participantTag("camp", "p2"));
    expect(c.participantTag("camp", "p1")).not.toBe(c.participantTag("other", "p1"));
  });
  it("seals a pointer so that only the matching key opens it", () => {
    const key = c.resumeKeyForEmail("a@b.io", "camp");
    const sealed = c.seal(key, "participant_1");

    expect(sealed).not.toContain("participant_1");
    expect(c.unseal(key, sealed)).toBe("participant_1");
    expect(c.unseal(c.resumeKeyForEmail("other@b.io", "camp"), sealed)).toBeNull();
    expect(c.unseal(c.resumeKeyForEmail("a@b.io", "other_campaign"), sealed)).toBeNull();
    expect(c.unseal(c.resumeKeyForToken("a@b.io", "camp"), sealed)).toBeNull();
    expect(c.unseal(key, "not-a-seal")).toBeNull();
    expect(c.unseal(key, `${sealed.slice(0, -2)}AA`)).toBeNull();
  });
  it("rejects a key of the wrong length", () => {
    expect(() => new Crypto("short")).toThrow();
    expect(() => new Crypto(newKey(), ["short"])).toThrow(/PREVIOUS/);
  });
});

describe("key ring and the v2 format (P9, D-164)", () => {
  const keyA = newKey();
  const keyB = newKey();

  it("writes v2 with a key id, and a v1 round trip upgrades by re-encrypting", () => {
    const old = legacyV1(keyA, "sk-legacy");
    const c = new Crypto(keyA);

    // v1 is read forever ...
    expect(c.decrypt(old)).toBe("sk-legacy");
    expect(c.keyIdOf(old)).toBe("v1");
    expect(c.isCurrent(old)).toBe(false);

    // ... and never written.
    const fresh = c.encrypt(c.decrypt(old), "provider.apiKey");
    expect(fresh).toMatch(/^v2\.[0-9a-f]{12}\./);
    expect(c.keyIdOf(fresh)).toBe(c.activeKeyId);
    expect(c.isCurrent(fresh)).toBe(true);
    expect(c.decrypt(fresh, "provider.apiKey")).toBe("sk-legacy");
  });

  it("binds a ciphertext to its purpose, so a value copied to another column does not open", () => {
    const c = new Crypto(keyA);
    const enc = c.encrypt("sk-secret", "provider.apiKey");
    expect(c.decrypt(enc, "provider.apiKey")).toBe("sk-secret");
    expect(() => c.decrypt(enc, "setting.secret")).toThrow();
    expect(() => c.decrypt(enc)).toThrow();
  });

  it("refuses a token whose key id was changed, and one sealed under a key not in the ring", () => {
    const c = new Crypto(keyA);
    const enc = c.encrypt("x", "generic");
    const parts = enc.split(".");
    parts[1] = "000000000000";
    expect(() => c.decrypt(parts.join("."))).toThrow(/not in the key ring/);

    const other = new Crypto(keyB).encrypt("x", "generic");
    expect(() => c.decrypt(other)).toThrow(/not in the key ring/);
  });

  it("reads both generations during a rotation, writes only the new key, and drops the old one cleanly", () => {
    const before = new Crypto(keyA);
    const sealedUnderA = before.encrypt("sk-a", "provider.apiKey");
    const legacyUnderA = legacyV1(keyA, "sk-legacy");

    const during = new Crypto(keyB, [keyA]);
    expect(during.keyIds).toEqual([during.activeKeyId, before.activeKeyId]);
    expect(during.activeKeyId).not.toBe(before.activeKeyId);
    expect(during.decrypt(sealedUnderA, "provider.apiKey")).toBe("sk-a");
    expect(during.decrypt(legacyUnderA)).toBe("sk-legacy");
    expect(during.isCurrent(sealedUnderA)).toBe(false);
    expect(during.keyIdOf(during.encrypt("n"))).toBe(during.activeKeyId);

    // After the previous key is removed, what was moved still opens and what was not does not.
    const moved = during.encrypt(during.decrypt(sealedUnderA, "provider.apiKey"), "provider.apiKey");
    const after = new Crypto(keyB);
    expect(after.decrypt(moved, "provider.apiKey")).toBe("sk-a");
    expect(() => after.decrypt(sealedUnderA, "provider.apiKey")).toThrow();
    expect(() => after.decrypt(legacyUnderA)).toThrow();
  });

  it("builds the ring from configuration, tolerating blanks and a repeated key", () => {
    const c = Crypto.fromEnv({
      PLATFORM_ENCRYPTION_KEY: keyB,
      PLATFORM_ENCRYPTION_KEY_PREVIOUS: ` ${keyA} , ,${keyB}`,
    });
    expect(c.keyIds).toHaveLength(2);
    expect(Crypto.fromEnv({ PLATFORM_ENCRYPTION_KEY: keyA }).keyIds).toHaveLength(1);
  });

  it("looks addresses up under every key and writes under the active one (dual read)", () => {
    const before = new Crypto(keyA);
    const stored = before.campaignEmailHash("Nasir@Example.com", "camp");
    const storedPlatformWide = before.hashEmail("nasir@example.com");
    const tag = before.participantTag("camp", "p1");
    const seal = before.seal(before.resumeKeyForEmail("nasir@example.com", "camp"), "participant_1");

    const after = new Crypto(keyB, [keyA]);
    // The active value differs from what is stored ...
    expect(after.campaignEmailHash("nasir@example.com", "camp")).not.toBe(stored);
    // ... but it is among the candidates only as the first, and the stored one is among the rest.
    const candidates = after.campaignEmailHashCandidates("nasir@example.com", "camp");
    expect(candidates[0]).toBe(after.campaignEmailHash("nasir@example.com", "camp"));
    expect(candidates).toContain(stored);
    expect(after.hashEmailCandidates("nasir@example.com")).toContain(storedPlatformWide);
    expect(after.participantTags("camp", "p1")).toContain(tag);
    expect(after.unsealAny(after.resumeKeysForEmail("nasir@example.com", "camp"), seal)).toBe(
      "participant_1",
    );
    // A key that is not in the ring cannot find any of it.
    expect(new Crypto(newKey()).campaignEmailHashCandidates("nasir@example.com", "camp")).not.toContain(
      stored,
    );
  });

  it("does not use the platform key itself as the cipher key", () => {
    const c = new Crypto(keyA);
    // A v1-style decrypt with the raw key must not open a v2 token even if the shape were forced.
    const enc = c.encrypt("secret", "generic");
    const [, , iv, tag, ct] = enc.split(".") as [string, string, string, string, string];
    expect(() => c.decrypt(["v1", iv, tag, ct].join("."))).toThrow();
  });
});
