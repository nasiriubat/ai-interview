import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Crypto, emailDomain, newNumericCode, newToken } from "../src/crypto.js";

describe("Crypto", () => {
  const c = new Crypto(randomBytes(32).toString("base64"));
  it("round-trips secrets and rejects tampering", () => {
    const enc = c.encrypt("sk-secret");
    expect(enc).not.toContain("sk-secret");
    expect(c.decrypt(enc)).toBe("sk-secret");
    const [v, iv, tag, ct] = enc.split(".");
    expect(() => c.decrypt([v, iv, tag, `${ct!.slice(0, -2)}AA`].join("."))).toThrow();
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
    const other = new Crypto(randomBytes(32).toString("base64"));
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
  });
});
