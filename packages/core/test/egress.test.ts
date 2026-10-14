import { createServer, type Server } from "node:http";
import { allowNetworkHosts } from "@aidp/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpKroki, KrokiUnavailableError } from "../src/exports/kroki.js";
import {
  classifyAddress,
  classifyConnectFailure,
  EgressBlockedError,
  EgressGuard,
  egressConfigFromEnv,
  validateTenantHeaders,
  type EgressConfig,
  type Resolver,
} from "../src/net/egress.js";

/**
 * The strict-policy suite for outbound connections (S4, D-83). Nothing here leaves the machine:
 * the only sockets are to a server on loopback, and DNS is a table.
 */

const strict: EgressConfig = { mode: "strict", allowHosts: [] };

/** A resolver from a table; an unknown name fails like NXDOMAIN. */
const table =
  (hosts: Record<string, string[]>): Resolver =>
  async (name) => {
    const found = hosts[name];
    if (!found) throw Object.assign(new Error(`ENOTFOUND ${name}`), { code: "ENOTFOUND" });
    return found.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };

// The names below never resolve anywhere: each is answered by the resolver the test injects. They
// are let through the suite-wide network guard so the egress policy beneath it is what is tested.
const releaseHosts = allowNetworkHosts([".example.com", "metadata", "litellm", "kroki"]);
afterAll(releaseHosts);

describe("classifyAddress", () => {
  const nonPublic = [
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "127.255.255.254",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "2001:db8::1",
    "100::1",
    // IPv4 carried inside IPv6, in each spelling that reaches a socket.
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "64:ff9b::7f00:1",
    "64:ff9b::a00:1",
    "2002:7f00:1::",
    "2002:a9fe:a9fe::1",
    "::127.0.0.1",
  ];
  const publicAddresses = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "::ffff:8.8.8.8"];

  it.each(nonPublic)("treats %s as not public", (ip) => {
    expect(classifyAddress(ip).nonPublic).toBe(true);
  });

  it.each(publicAddresses)("lets %s through", (ip) => {
    expect(classifyAddress(ip)).toEqual({ hard: false, nonPublic: false });
  });

  it.each([
    "169.254.169.254",
    "169.254.0.1",
    "100.100.100.200",
    "168.63.129.16",
    "fd00:ec2::254",
    "fe80::1",
    "::ffff:169.254.169.254",
    "64:ff9b::a9fe:a9fe",
  ])("hard-denies the metadata and link-local address %s", (ip) => {
    expect(classifyAddress(ip).hard).toBe(true);
  });

  it("refuses text that is not an address rather than guessing", () => {
    expect(classifyAddress("not-an-ip")).toEqual({ hard: true, nonPublic: true });
  });
});

describe("URL policy", () => {
  const guard = new EgressGuard(strict, { resolver: table({}) });

  it.each([
    ["plain http", "http://api.example.com/v1"],
    ["a dotted-quad loopback", "https://127.0.0.1/v1"],
    ["a short loopback", "https://127.1/v1"],
    ["a decimal loopback", "https://2130706433/v1"],
    ["a hex loopback", "https://0x7f.1/v1"],
    ["an octal loopback", "https://0177.0.0.1/v1"],
    ["an IPv6 loopback", "https://[::1]/v1"],
    ["a mapped loopback", "https://[::ffff:127.0.0.1]/v1"],
    ["a NAT64 loopback", "https://[64:ff9b::7f00:1]/v1"],
    ["the metadata address", "https://169.254.169.254/latest/meta-data"],
    ["localhost", "https://localhost/v1"],
    ["localhost with a trailing dot", "https://localhost./v1"],
    ["a single-label name", "https://kroki/v1"],
    ["an .internal name", "https://db.internal/v1"],
    ["a .local name", "https://printer.local/v1"],
    ["embedded credentials", "https://user:secret@api.example.com/v1"],
    ["an unusual port", "https://api.example.com:22/v1"],
    ["another scheme", "ftp://api.example.com/v1"],
    ["a malformed URL", "https://"],
  ])("refuses %s for a tenant", (_name, url) => {
    expect(() => guard.checkUrl(url, "tenant")).toThrow(EgressBlockedError);
  });

  it("accepts a public https name on the standard ports", () => {
    expect(guard.checkUrl("https://api.example.com/v1", "tenant").hostname).toBe("api.example.com");
    expect(guard.checkUrl("https://api.example.com:8443/v1", "tenant").port).toBe("8443");
  });

  it("lets the operator use http, but not the metadata address", () => {
    expect(() => guard.checkUrl("http://litellm:4000/v1", "platform")).not.toThrow();
    expect(() => guard.checkUrl("http://169.254.169.254/", "platform")).toThrow(/metadata_address/);
    expect(() => guard.checkUrl("http://10.0.0.5/", "platform")).toThrow(/private_address/);
  });

  it("allows a private literal for the operator only when its host is on the allowlist", () => {
    const allowed = new EgressGuard({ mode: "strict", allowHosts: ["10.0.0.5"] }, { resolver: table({}) });
    expect(() => allowed.checkUrl("http://10.0.0.5/v1", "platform")).not.toThrow();
    expect(() => allowed.checkUrl("http://10.0.0.5/v1", "tenant")).toThrow(EgressBlockedError);
  });
});

describe("an address the deployment configured", () => {
  // The admin voice setup writes OPENAI_BASE_URL onto a tenant's provider row (D-77).
  const guard = new EgressGuard(
    { mode: "strict", allowHosts: [], trustedUrls: ["http://litellm:4000/v1"] },
    { resolver: table({ litellm: ["10.0.0.6"] }) },
  );

  it("is accepted for a tenant's provider even though it is http and internal", async () => {
    expect(() => guard.checkUrl("http://litellm:4000/v1/models", "tenant")).not.toThrow();
    await expect(guard.validateUrl("http://litellm:4000/v1", "tenant")).resolves.toBeInstanceOf(URL);
  });

  it("does not make the rest of that host or any other internal address reachable", () => {
    expect(() => guard.checkUrl("http://litellm:9999/v1", "tenant")).toThrow(EgressBlockedError);
    expect(() => guard.checkUrl("http://db:4000/v1", "tenant")).toThrow(EgressBlockedError);
  });

  it("still refuses the metadata address if it is what the name resolves to", async () => {
    const hostile = new EgressGuard(
      { mode: "strict", allowHosts: [], trustedUrls: ["http://litellm:4000/v1"] },
      { resolver: table({ litellm: ["169.254.169.254"] }) },
    );
    await expect(hostile.validateUrl("http://litellm:4000/v1", "tenant")).rejects.toThrow(/metadata_address/);
  });
});

describe("tenant headers", () => {
  it.each([
    "Authorization",
    "authorization",
    "Host",
    "Content-Length",
    "X-Forwarded-For",
    "Transfer-Encoding",
  ])("refuses %s", (name) => {
    expect(() => {
      validateTenantHeaders({ [name]: "x" });
    }).toThrow(EgressBlockedError);
  });
  it("refuses a value that would split the header block", () => {
    expect(() => {
      validateTenantHeaders({ "x-team": "a\r\nhost: evil" });
    }).toThrow(EgressBlockedError);
  });
  it("accepts an ordinary routing header", () => {
    expect(() => {
      validateTenantHeaders({ "x-litellm-team": "research", "api-version": "2024-10" });
    }).not.toThrow();
  });
});

describe("SMTP relay policy", () => {
  const guard = new EgressGuard(strict, { resolver: table({}) });

  it("accepts a public submission endpoint and requires TLS of a tenant", () => {
    expect(guard.checkSmtpUrl("smtps://mail.example.com", "tenant")).toMatchObject({
      host: "mail.example.com",
      port: 465,
      secure: true,
      requireTls: true,
    });
    expect(guard.checkSmtpUrl("smtp://u:p@mail.example.com:587", "tenant")).toMatchObject({
      port: 587,
      secure: false,
      requireTls: true,
      user: "u",
      pass: "p",
    });
  });

  it.each([
    "smtp://127.0.0.1:587",
    "smtp://localhost:587",
    "smtp://169.254.169.254:587",
    "smtp://mail.example.com:25",
    "smtp://mail.example.com:6379",
    "smtp://postgres:587",
    "http://mail.example.com:587",
  ])("refuses %s for a tenant", (url) => {
    expect(() => guard.checkSmtpUrl(url, "tenant")).toThrow(EgressBlockedError);
  });

  it("resolves at save time and refuses a name that points inside", async () => {
    const g = new EgressGuard(strict, { resolver: table({ "mail.attacker.test": ["10.0.0.7"] }) });
    await expect(g.validateSmtpUrl("smtps://mail.attacker.test", "tenant")).rejects.toThrow(
      /private_address/,
    );
  });
});

describe("guarded fetch", () => {
  let server: Server;
  let base: string;
  let hits = 0;
  const big = Buffer.alloc(200_000, 97);

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits++;
      if (req.url === "/redirect") {
        res.statusCode = 302;
        res.setHeader("location", `${base}/secret`);
        res.end();
        return;
      }
      if (req.url === "/big") {
        res.setHeader("content-type", "application/octet-stream");
        res.end(big);
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, path: req.url, host: req.headers.host }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterAll(() => {
    server.close();
  });

  const port = (): string => new URL(base).port;

  it("refuses a tenant URL on loopback without opening a socket", async () => {
    const guard = new EgressGuard(strict, { resolver: table({}) });
    hits = 0;
    await expect(guard.fetchFor("tenant")(`${base}/v1/models`)).rejects.toThrow(EgressBlockedError);
    expect(hits).toBe(0);
  });

  it("refuses a name whose answer is private, and never connects", async () => {
    const guard = new EgressGuard(strict, { resolver: table({ "models.example.com": ["127.0.0.1"] }) });
    hits = 0;
    const err = await guard
      .fetchFor("platform")(`http://models.example.com:${port()}/v1`)
      .catch((e: unknown) => e);
    expect(classifyConnectFailure(err)).toBe("blocked_address");
    expect(hits).toBe(0);
  });

  it("refuses a name that resolves to one public and one private address (rebinding)", async () => {
    // Which address the socket would use is the client's choice, so every answer must pass.
    const guard = new EgressGuard(strict, {
      resolver: table({ "rebind.example.com": ["93.184.216.34", "127.0.0.1"] }),
    });
    hits = 0;
    const err = await guard
      .fetchFor("platform")(`http://rebind.example.com:${port()}/v1`)
      .catch((e: unknown) => e);
    expect(classifyConnectFailure(err)).toBe("blocked_address");
    expect(hits).toBe(0);
  });

  it("re-resolves on every connection, so a record that changes after saving is caught", async () => {
    let answer = ["93.184.216.34"];
    const guard = new EgressGuard(strict, {
      resolver: async () => answer.map((address) => ({ address, family: 4 })),
    });
    // Saved while public: the write-time check passes.
    await expect(guard.validateUrl("https://flip.example.com/v1", "tenant")).resolves.toBeInstanceOf(URL);
    // The record then points inside; the next connection is refused.
    answer = ["10.9.9.9"];
    const err = await guard
      .fetchFor("tenant")("https://flip.example.com/v1")
      .catch((e: unknown) => e);
    expect(classifyConnectFailure(err)).toBe("blocked_address");
  });

  it("never reaches the metadata address, even for an allowlisted operator host", async () => {
    const guard = new EgressGuard(
      { mode: "strict", allowHosts: ["metadata"] },
      { resolver: table({ metadata: ["169.254.169.254"] }) },
    );
    const err = await guard
      .fetchFor("platform")("http://metadata/latest/meta-data")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(classifyConnectFailure(err)).toBe("blocked_address");
  });

  it("connects an allowlisted operator host to its private address", async () => {
    const guard = new EgressGuard(
      { mode: "strict", allowHosts: ["litellm"] },
      { resolver: table({ litellm: ["127.0.0.1"] }) },
    );
    hits = 0;
    const res = await guard.fetchFor("platform")(`http://litellm:${port()}/v1/models`);
    expect(res.status).toBe(200);
    // The socket went to the validated address while the request kept the operator’s host name.
    expect(await res.json()).toMatchObject({ ok: true, host: `litellm:${port()}` });
    expect(hits).toBe(1);
    await guard.close();
  });

  it("reaches the diagram renderer only by an allow-listed service name (D-213)", async () => {
    const resolver = table({ kroki: ["127.0.0.1"] });
    const allowed = new EgressGuard({ mode: "strict", allowHosts: ["kroki"] }, { resolver });
    hits = 0;
    // The stub answers JSON, not a PNG: getting that far proves the socket was opened.
    const reached = new HttpKroki({
      baseUrl: `http://kroki:${port()}`,
      fetch: allowed.fetchFor("platform"),
    });
    await expect(reached.render("flowchart LR\n A-->B", "png")).rejects.toThrow(/did not return a PNG/);
    expect(hits).toBe(1);
    await allowed.close();

    const denied = new EgressGuard(strict, { resolver });
    const blocked = new HttpKroki({ baseUrl: `http://kroki:${port()}`, fetch: denied.fetchFor("platform") });
    hits = 0;
    await expect(blocked.render("flowchart LR\n A-->B", "png")).rejects.toBeInstanceOf(KrokiUnavailableError);
    expect(hits).toBe(0);
    await denied.close();
  });

  it("does not let an operator host that is not on the list reach a private address", async () => {
    const guard = new EgressGuard(strict, { resolver: table({ litellm: ["127.0.0.1"] }) });
    const err = await guard
      .fetchFor("platform")(`http://litellm:${port()}/v1`)
      .catch((e: unknown) => e);
    expect(classifyConnectFailure(err)).toBe("blocked_address");
  });

  it("does not follow a redirect, and the target is never requested", async () => {
    const guard = new EgressGuard({ mode: "permissive", allowHosts: [] }, { resolver: table({}) });
    hits = 0;
    const err = await guard
      .fetchFor("platform")(`${base}/redirect`)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EgressBlockedError);
    expect((err as EgressBlockedError).reason).toBe("redirect");
    // One request, for /redirect; nothing for /secret.
    expect(hits).toBe(1);
    await guard.close();
  });

  it("cuts a response off at the size cap instead of buffering it", async () => {
    const guard = new EgressGuard(
      { mode: "permissive", allowHosts: [], maxResponseBytes: 10_000 },
      { resolver: table({}) },
    );
    const res = await guard.fetchFor("platform")(`${base}/big`);
    await expect(res.arrayBuffer()).rejects.toThrow();
    await guard.close();
  });

  it("keeps the metadata addresses closed in permissive mode", async () => {
    const guard = new EgressGuard({ mode: "permissive", allowHosts: [] }, { resolver: table({}) });
    await expect(guard.fetchFor("platform")("http://169.254.169.254/latest")).rejects.toThrow(
      /metadata_address/,
    );
    // And loopback, which the fake model servers of the test suites rely on, is open.
    const res = await guard.fetchFor("tenant")(`${base}/v1/models`);
    expect(res.status).toBe(200);
    await guard.close();
  });
});

describe("realtime transcription socket", () => {
  const guard = new EgressGuard(
    { mode: "strict", allowHosts: ["whisper-stream"] },
    { resolver: table({ "stream.example.com": ["10.0.0.4"], "whisper-stream": ["10.0.0.9"] }) },
  );

  it.each([
    ["a loopback literal", "wss://127.0.0.1/v1/realtime"],
    ["the metadata address", "wss://169.254.169.254/v1/realtime"],
    ["a plain ws URL", "ws://api.example.com/v1/realtime"],
    ["an internal name", "wss://db.internal/v1/realtime"],
  ])("refuses %s for a tenant before opening a connection", (_name, url) => {
    expect(() => guard.socketFor("tenant")(url, {})).toThrow(EgressBlockedError);
  });

  it("refuses a name that resolves inside, when the handshake would be dialled", async () => {
    // The socket is created (the URL is acceptable), then its own lookup refuses the address.
    const socket = guard.socketFor("tenant")("wss://stream.example.com/v1/realtime", {});
    const err = await new Promise<Error>((resolve) => {
      socket.on("error", (e: Error) => {
        resolve(e);
      });
    });
    expect(classifyConnectFailure(err)).toBe("blocked_address");
  });
});

describe("classifyConnectFailure", () => {
  it("reduces every failure to one of four answers", () => {
    expect(classifyConnectFailure(new EgressBlockedError("private_address"))).toBe("blocked_address");
    expect(
      classifyConnectFailure(new TypeError("fetch failed", { cause: new EgressBlockedError("redirect") })),
    ).toBe("blocked_address");
    expect(classifyConnectFailure(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe(
      "unreachable",
    );
    expect(classifyConnectFailure(Object.assign(new Error("x"), { code: "EHOSTUNREACH" }))).toBe(
      "unreachable",
    );
    expect(classifyConnectFailure(Object.assign(new Error("x"), { code: "CERT_HAS_EXPIRED" }))).toBe(
      "tls_error",
    );
    expect(classifyConnectFailure(Object.assign(new Error("x"), { code: "UND_ERR_CONNECT_TIMEOUT" }))).toBe(
      "timeout",
    );
    expect(classifyConnectFailure(new TypeError("fetch failed", { cause: new Error("???") }))).toBe(
      "unreachable",
    );
  });
});

describe("egressConfigFromEnv", () => {
  it("parses the allowlist and refuses permissive mode in production", () => {
    expect(
      egressConfigFromEnv({ mode: "strict", allowHosts: " Kroki, minio ,", nodeEnv: "production" }),
    ).toEqual({
      mode: "strict",
      allowHosts: ["kroki", "minio"],
      trustedUrls: [],
    });
    expect(
      egressConfigFromEnv({
        mode: "strict",
        allowHosts: "",
        nodeEnv: "production",
        trustedUrls: [undefined, "https://proxy.example.com/v1"],
      }).trustedUrls,
    ).toEqual(["https://proxy.example.com/v1"]);
    expect(() => egressConfigFromEnv({ mode: "permissive", allowHosts: "", nodeEnv: "production" })).toThrow(
      /permissive/,
    );
    expect(egressConfigFromEnv({ mode: "permissive", allowHosts: "", nodeEnv: "test" }).mode).toBe(
      "permissive",
    );
  });
});
