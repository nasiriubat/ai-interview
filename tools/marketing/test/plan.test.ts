import { describe, expect, it } from "vitest";
import { codeIn, configFrom, fileName, indexMarkdown, linkIn, selected, SHOTS } from "../src/plan.js";

describe("capture plan", () => {
  it("needs an admin address and trims trailing slashes", () => {
    expect(() => configFrom({})).toThrow(/ADMIN_EMAIL/);
    const cfg = configFrom({
      ADMIN_EMAIL: "a@b.example",
      BASE: "http://localhost:3300/",
      ONLY: "13, opportunity",
    });
    expect(cfg.base).toBe("http://localhost:3300");
    expect(cfg.mailpit).toBe("http://localhost:8025");
    expect(cfg.only).toEqual(["13", "opportunity"]);
    expect(cfg.interview).toBe(false);
  });

  it("finds the sign-in link in text or HTML mail and a six-digit code", () => {
    const html = '<a href="http://x.example/api/auth/callback/nodemailer?token=a&amp;email=b">Sign in</a>';
    expect(linkIn(html, "/api/auth/callback")).toBe(
      "http://x.example/api/auth/callback/nodemailer?token=a&email=b",
    );
    expect(linkIn("nothing here", "/api/auth/callback")).toBeNull();
    expect(codeIn("Your code: 123456")).toBe("123456");
  });

  it("numbers every shot uniquely and in order, with a use for each", () => {
    const numbers = SHOTS.map((s) => s.n);
    expect(new Set(numbers).size).toBe(SHOTS.length);
    expect([...numbers].sort()).toEqual(numbers);
    for (const s of SHOTS) {
      expect(fileName(s)).toMatch(/^\d{2}-[a-z0-9-]+\.png$/);
      expect(s.shows.length).toBeGreaterThan(10);
      expect(s.use.length).toBeGreaterThan(3);
    }
    expect(SHOTS.some((s) => s.locale === "fi")).toBe(true);
    expect(SHOTS.some((s) => s.theme === "dark")).toBe(true);
    expect(SHOTS.some((s) => s.viewport === "phone")).toBe(true);
  });

  it("selects by number or name and lists only what was taken", () => {
    const first = SHOTS[0]!;
    expect(selected(first, [])).toBe(true);
    expect(selected(first, ["1"])).toBe(true);
    expect(selected(first, ["report"])).toBe(false);
    const md = indexMarkdown(SHOTS, new Set([fileName(first)]), "Simulated demo.");
    expect(md).toContain(fileName(first));
    expect(md).not.toContain(fileName(SHOTS[1]!));
    expect(md).toContain("Simulated demo.");
  });
});
