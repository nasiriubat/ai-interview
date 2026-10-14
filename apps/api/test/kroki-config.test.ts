import { describe, expect, it } from "vitest";
import { egressAllowHosts, loadConfig } from "../src/config.js";

const base = {
  DATABASE_URL: "postgresql://x",
  PLATFORM_ENCRYPTION_KEY: "k",
  AUTH_SECRET: "0123456789abcdef0123",
};

describe("KROKI_URL and the egress allow-list (D-213)", () => {
  it("treats an unset or empty variable as no renderer", () => {
    expect(loadConfig({ ...base }).KROKI_URL).toBeUndefined();
    expect(loadConfig({ ...base, KROKI_URL: "" }).KROKI_URL).toBeUndefined();
  });

  it("refuses a value that is not a URL", () => {
    expect(() => loadConfig({ ...base, KROKI_URL: "kroki:8000" })).toThrow(/KROKI_URL/);
  });

  it("adds the renderer's host to what the operator listed, once", () => {
    const config = (hosts: string, kroki?: string) =>
      loadConfig({ ...base, EGRESS_ALLOW_HOSTS: hosts, ...(kroki ? { KROKI_URL: kroki } : {}) });
    expect(egressAllowHosts(config("litellm", "http://kroki:8000"))).toBe("litellm,kroki");
    expect(egressAllowHosts(config("kroki, litellm", "http://KROKI:8000"))).toBe("kroki,litellm");
    expect(egressAllowHosts(config("", "http://kroki:8000"))).toBe("kroki");
    expect(egressAllowHosts(config("litellm"))).toBe("litellm");
  });
});
