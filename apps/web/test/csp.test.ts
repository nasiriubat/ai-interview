import { describe, expect, it, vi } from "vitest";
import { withStyleNonce } from "@/components/report/MermaidDiagram";
import { buildCsp, CSP_REPORT_ONLY_HEADER, newNonce, PERMISSIONS_POLICY } from "@/lib/csp";

/** The Content-Security-Policy and the security headers of a page (A3, D-165). */
describe("buildCsp", () => {
  const policy = buildCsp({ nonce: "abc123==", host: "interviews.example.com" });
  const directive = (name: string): string =>
    policy
      .split("; ")
      .find((d) => d.startsWith(`${name} `))
      ?.slice(name.length + 1) ?? "";

  it("gives scripts the request's nonce and strict-dynamic, and no unsafe-inline", () => {
    const scripts = directive("script-src");
    expect(scripts).toContain("'nonce-abc123=='");
    expect(scripts).toContain("'strict-dynamic'");
    expect(scripts).not.toContain("unsafe-inline");
    expect(scripts).not.toContain("unsafe-eval");
  });

  it("allows style attributes (Tailwind, Radix) but styles elements only by nonce", () => {
    expect(directive("style-src")).toBe("'self' 'nonce-abc123=='");
    expect(directive("style-src-attr")).toBe("'unsafe-inline'");
  });

  it("names no remote host for images or connections, which closes the exfiltration channels", () => {
    expect(directive("img-src")).toBe("'self' data: blob:");
    expect(directive("connect-src")).toBe("'self' wss://interviews.example.com");
    expect(directive("default-src")).toBe("'self'");
  });

  it("refuses plugins, base rewriting and framing, and reports", () => {
    expect(directive("object-src")).toBe("'none'");
    expect(directive("base-uri")).toBe("'none'");
    expect(directive("frame-ancestors")).toBe("'none'");
    expect(directive("form-action")).toBe("'self'");
    expect(directive("report-uri")).toBe("/api/csp-report");
  });

  it("keeps the microphone for live voice and nothing else sensitive", () => {
    expect(directive("worker-src")).toBe("'self' blob:");
    expect(PERMISSIONS_POLICY).toBe("camera=(), geolocation=(), microphone=(self)");
  });

  it("allows eval only in development, and upgrades insecure requests only when enforced", () => {
    expect(buildCsp({ nonce: "n", host: "h", dev: true })).toContain("'unsafe-eval'");
    expect(policy).not.toContain("upgrade-insecure-requests");
    expect(buildCsp({ nonce: "n", host: "h", enforce: true })).toContain("upgrade-insecure-requests");
  });
});

describe("newNonce", () => {
  it("is different every time and is base64 of 128 bits", () => {
    const seen = new Set(Array.from({ length: 200 }, () => newNonce()));
    expect(seen.size).toBe(200);
    for (const n of seen) expect(n).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });
});

describe("Mermaid style nonce", () => {
  it("stamps the nonce on style elements and nothing else", () => {
    const svg =
      '<svg><style>.a{fill:red}</style><g><style type="text/css">.b{}</style></g><path d="M0"/></svg>';
    const out = withStyleNonce(svg, "abc123==");
    expect(out.match(/<style nonce="abc123=="/g)).toHaveLength(2);
    expect(out).toContain('<path d="M0"/>');
  });

  it("does not stamp twice, and refuses a nonce that is not base64", () => {
    const once = withStyleNonce("<svg><style>.a{}</style></svg>", "n1");
    expect(withStyleNonce(once, "n1")).toBe(once);
    expect(withStyleNonce("<svg><style>.a{}</style></svg>", '"><script>')).toBe(
      "<svg><style>.a{}</style></svg>",
    );
    expect(withStyleNonce("<svg><style>.a{}</style></svg>", "")).toBe("<svg><style>.a{}</style></svg>");
  });
});

/**
 * proxy.ts is the thing that sets the header, so it is exercised with Auth.js stubbed: the
 * behaviour under test is the nonce, the header and the redirect, not the session decoding.
 */
vi.mock("next-auth", () => ({
  default: () => ({
    auth: (handler: (req: unknown) => Response) => (req: { auth?: unknown }) => handler(req),
  }),
}));
vi.mock("@/auth.config", () => ({ authConfig: {} }));

describe("proxy", () => {
  async function run(path: string, signedIn = false): Promise<Response> {
    const { default: proxy } = await import("@/proxy");
    const url = new URL(`https://interviews.example.com${path}`);
    const req = {
      nextUrl: { host: url.host, origin: url.origin, pathname: url.pathname, search: url.search },
      headers: new Headers(),
      auth: signedIn ? { user: { email: "a@b.io" } } : null,
    };
    return await proxy(req as never, {} as never);
  }

  it("sets a report-only policy with a nonce on a participant page, and does not ask for a session", async () => {
    const res = await run("/p/some-link");
    const csp = res.headers.get(CSP_REPORT_ONLY_HEADER) ?? "";
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/]{22}==' 'strict-dynamic'/);
    expect(csp).toContain("wss://interviews.example.com");
    expect(res.headers.get("permissions-policy")).toContain("microphone=(self)");
    expect(res.headers.get("content-security-policy")).toBeNull();
  });

  it("uses a different nonce on every request", async () => {
    const a = (await run("/p/x")).headers.get(CSP_REPORT_ONLY_HEADER);
    const b = (await run("/p/x")).headers.get(CSP_REPORT_ONLY_HEADER);
    expect(a).not.toBe(b);
  });

  it("still sends an anonymous visitor of /admin to sign-in, with the headers on the redirect", async () => {
    const res = await run("/admin/campaigns?x=1");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "https://interviews.example.com/auth/signin?callbackUrl=%2Fadmin%2Fcampaigns%3Fx%3D1",
    );
    expect(res.headers.get(CSP_REPORT_ONLY_HEADER)).toContain("frame-ancestors 'none'");
  });

  it("lets a signed-in staff user through /admin", async () => {
    const res = await run("/admin", true);
    expect(res.status).toBe(200);
    expect(res.headers.get(CSP_REPORT_ONLY_HEADER)).toContain("'strict-dynamic'");
  });
});
