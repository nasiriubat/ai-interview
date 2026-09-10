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
  it("rejects a key of the wrong length", () => {
    expect(() => new Crypto("short")).toThrow();
  });
});
