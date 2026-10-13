import dns from "node:dns";
import { BlockList, isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

/**
 * Outbound-connection policy: what this server is willing to open a socket to on a tenant's
 * behalf (security plan S4, D-83).
 *
 * A tenant admin chooses a provider base URL, custom headers and an SMTP relay. Left alone, those
 * are three ways to make the server connect to whatever the admin names: the cloud metadata
 * endpoint, a database, another compose service. The defence is not to validate the URL string
 * (there are decimal, octal, hex, IPv4-mapped IPv6 and DNS-rebinding spellings of every
 * address) but to look at the address the socket is about to connect to, at the moment it
 * connects, with the lookup that supplies it. Validation and connection use the same answer, so
 * there is nothing for a second DNS response to change.
 *
 * Three origins of a URL, because they are different promises:
 *
 * - `tenant`: typed by a tenant admin. https only, a public DNS name, port 443 or 8443, public
 *   addresses only. No allowlist: a tenant cannot reach the platform's internal network, ever.
 * - `platform`: typed by the platform operator. http is allowed, and private addresses are allowed
 *   for the hostnames in `allowHosts` (compose service names in development; empty in production).
 * - `config`: set in the environment by whoever deploys. Deliberately not routed through here.
 *
 * The cloud metadata addresses are refused for every origin and in every mode.
 */
export type EgressOrigin = "tenant" | "platform";
export type EgressMode = "strict" | "permissive";

export type BlockReason =
  | "scheme"
  | "credentials"
  | "port"
  | "ip_literal"
  | "local_name"
  | "private_address"
  | "metadata_address"
  | "redirect"
  | "header"
  | "response_too_large"
  | "malformed_url";

export class EgressBlockedError extends Error {
  constructor(
    readonly reason: BlockReason,
    detail?: string,
  ) {
    super(detail ? `blocked_address: ${reason} (${detail})` : `blocked_address: ${reason}`);
    this.name = "EgressBlockedError";
  }
}

// ---------- address classification ----------

type Family = "ipv4" | "ipv6";

function listOf(entries: [string, number, Family][]): BlockList {
  const list = new BlockList();
  for (const [net, prefix, family] of entries) list.addSubnet(net, prefix, family);
  return list;
}

/** Never reachable, for any origin or mode: metadata services and link-local. */
const HARD_DENIED = listOf([
  ["169.254.0.0", 16, "ipv4"], // link-local, including 169.254.169.254 (AWS, GCP, Azure, DigitalOcean, ...)
  ["100.100.100.200", 32, "ipv4"], // Alibaba Cloud metadata
  ["168.63.129.16", 32, "ipv4"], // Azure wire server
  ["192.0.0.192", 32, "ipv4"], // Oracle Cloud metadata
  ["fd00:ec2::254", 128, "ipv6"], // AWS IPv6 metadata
  ["fe80::", 10, "ipv6"], // link-local
]);

/** Not globally routable IPv4. Reached only after unwrapping v4-in-v6 forms. */
const PRIVATE_V4 = listOf([
  ["0.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"],
  ["192.0.2.0", 24, "ipv4"],
  ["192.88.99.0", 24, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["198.18.0.0", 15, "ipv4"],
  ["198.51.100.0", 24, "ipv4"],
  ["203.0.113.0", 24, "ipv4"],
  ["224.0.0.0", 4, "ipv4"],
  ["240.0.0.0", 4, "ipv4"],
]);

/** IPv6 inside 2000::/3 (global unicast) that is nonetheless reserved or transitional. */
const RESERVED_V6 = listOf([
  ["2001::", 32, "ipv6"], // Teredo
  ["2001:2::", 48, "ipv6"], // benchmarking
  ["2001:10::", 28, "ipv6"], // ORCHID
  ["2001:db8::", 32, "ipv6"], // documentation
]);

/** Eight 16-bit groups of an IPv6 address, or undefined when it does not parse. */
function ipv6Groups(address: string): number[] | undefined {
  let text = address.toLowerCase().split("%")[0] ?? "";
  if (!isIP(text) || !text.includes(":")) return undefined;
  const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", rest] = text.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = rest === undefined || rest === "" ? [] : rest.split(":");
  const fill = rest === undefined ? [] : Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0");
  const groups = [...left, ...fill, ...right].map((g) => Number.parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)
    ? groups
    : undefined;
}

const v4String = (hi: number, lo: number): string => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/** The IPv4 address an IPv6 address merely carries, or undefined when it is a real IPv6 address. */
function embeddedV4(g: number[]): string | undefined {
  const zeros = (n: number): boolean => g.slice(0, n).every((x) => x === 0);
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible, deprecated)
  if (zeros(5) && (g[5] === 0xffff || g[5] === 0)) return v4String(g[6] ?? 0, g[7] ?? 0);
  // 64:ff9b::/96 (NAT64)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return v4String(g[6] ?? 0, g[7] ?? 0);
  }
  // 2002::/16 (6to4): the IPv4 address is bits 16..48
  if (g[0] === 0x2002) return v4String(g[1] ?? 0, g[2] ?? 0);
  return undefined;
}

export interface AddressVerdict {
  /** Refused for every origin and mode. */
  hard: boolean;
  /** Not a public, globally routable address. */
  nonPublic: boolean;
}

/**
 * Classifies one resolved address. IPv4-in-IPv6 forms (mapped, NAT64, 6to4) are unwrapped and
 * judged as the IPv4 address they carry; everything else in IPv6 must be global unicast.
 */
export function classifyAddress(address: string): AddressVerdict {
  const family = isIP(address);
  if (family === 4) {
    return {
      hard: HARD_DENIED.check(address, "ipv4"),
      nonPublic: PRIVATE_V4.check(address, "ipv4"),
    };
  }
  if (family === 6) {
    const groups = ipv6Groups(address);
    if (!groups) return { hard: true, nonPublic: true };
    const wrapped = embeddedV4(groups);
    if (wrapped !== undefined) return classifyAddress(wrapped);
    const canonical = groups.map((g) => g.toString(16)).join(":");
    const global = (groups[0] ?? 0) >> 13 === 1; // 2000::/3
    return {
      hard: HARD_DENIED.check(canonical, "ipv6"),
      nonPublic: !global || RESERVED_V6.check(canonical, "ipv6"),
    };
  }
  // Not an address at all: refuse rather than guess.
  return { hard: true, nonPublic: true };
}

// ---------- policy ----------

export interface EgressConfig {
  mode: EgressMode;
  /** Hostnames a platform provider may reach on a private address (compose service names). */
  allowHosts: readonly string[];
  /** Cap on a response body, in bytes. */
  maxResponseBytes?: number;
  connectTimeoutMs?: number;
}

/**
 * Builds the policy from environment-level settings. Permissive mode exists so tests and local
 * development can talk to a fake model server on loopback; a production process refuses to start
 * with it, because a permissive guard is a decorative one.
 */
export function egressConfigFromEnv(env: {
  mode: EgressMode;
  allowHosts: string;
  nodeEnv: string;
}): EgressConfig {
  if (env.mode === "permissive" && env.nodeEnv === "production") {
    throw new Error("EGRESS_MODE=permissive is not allowed when NODE_ENV=production");
  }
  return {
    mode: env.mode,
    allowHosts: env.allowHosts
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h.length > 0),
  };
}

export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const TENANT_PORTS = new Set([443, 8443]);
export const SMTP_TENANT_PORTS: ReadonlySet<number> = new Set([465, 587, 2525]);

const LOCAL_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".localdomain",
  ".home.arpa",
  ".lan",
  ".intranet",
];

/** Header names a tenant may not set on a provider call: framing, routing, and the credential. */
const FORBIDDEN_TENANT_HEADERS = new Set([
  "host",
  "authorization",
  "proxy-authorization",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "expect",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
]);

/**
 * Validates provider headers a tenant supplies. The API key is a separate field and becomes
 * `Authorization`; a header map that could replace it, rewrite `Host`, or smuggle framing
 * headers is refused outright. Throws `EgressBlockedError("header")`.
 */
export function validateTenantHeaders(headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(key)) throw new EgressBlockedError("header", name);
    if (FORBIDDEN_TENANT_HEADERS.has(key) || key.startsWith("proxy-") || key.startsWith("sec-")) {
      throw new EgressBlockedError("header", key);
    }
    if (/[\r\n\0]/.test(value)) throw new EgressBlockedError("header", key);
  }
}

export interface PolicyInput {
  origin: EgressOrigin;
  config: EgressConfig;
}

function bareHost(hostname: string): string {
  return hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

function isLocalName(host: string): boolean {
  if (host === "localhost" || !host.includes(".")) return true;
  return LOCAL_SUFFIXES.some((s) => host.endsWith(s));
}

/**
 * Everything that can be decided from the URL text alone. Never resolves a name, so it is cheap
 * and safe in a validator. Returns the parsed URL. The connect-time lookup remains authoritative.
 */
export function checkUrl(raw: string, policy: PolicyInput): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EgressBlockedError("malformed_url");
  }
  const { origin, config } = policy;
  // Permissive is a development and test mode (the API refuses it in production): schemes, ports
  // and private addresses are open so a fake model server on loopback works. What it never
  // opens is the metadata addresses, embedded credentials, or redirects.
  const permissive = config.mode === "permissive";
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new EgressBlockedError("scheme", url.protocol);
  }
  if (!permissive && origin === "tenant" && url.protocol !== "https:") {
    throw new EgressBlockedError("scheme", url.protocol);
  }
  if (url.username || url.password) throw new EgressBlockedError("credentials");

  // WHATWG URL has already normalised decimal, octal and hex IPv4 spellings and bracketed IPv6,
  // so what is left in `hostname` is the canonical form.
  const host = bareHost(url.hostname);
  const literal = isIP(host) !== 0;
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);

  if (!permissive && origin === "tenant") {
    if (literal) throw new EgressBlockedError("ip_literal");
    if (isLocalName(host)) throw new EgressBlockedError("local_name", host);
    if (!TENANT_PORTS.has(port)) throw new EgressBlockedError("port", String(port));
  }
  if (literal) {
    const verdict = classifyAddress(host);
    if (verdict.hard) throw new EgressBlockedError("metadata_address");
    if (origin === "platform" && verdict.nonPublic && !isAllowedPrivate(host, policy)) {
      throw new EgressBlockedError("private_address", host);
    }
  }
  return url;
}

/** Whether a private destination is permitted for this name: permissive mode, or an allowlisted host. */
function isAllowedPrivate(host: string, policy: PolicyInput): boolean {
  if (policy.config.mode === "permissive") return true;
  return policy.origin === "platform" && policy.config.allowHosts.map((h) => h.toLowerCase()).includes(host);
}

/** What `dns.lookup(host, { all: true })` returns; injectable so tests need no DNS. */
export type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;

const systemResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses);
    });
  });

/**
 * Judges a set of resolved addresses for a host. Every address must pass: a name that resolves to
 * one public and one private address is refused, because the connect step may pick either.
 */
export function assertAddressesAllowed(
  host: string,
  addresses: { address: string }[],
  policy: PolicyInput,
): void {
  if (addresses.length === 0) throw new EgressBlockedError("private_address", "no address");
  for (const { address } of addresses) {
    const verdict = classifyAddress(address);
    if (verdict.hard) throw new EgressBlockedError("metadata_address");
    if (verdict.nonPublic && !isAllowedPrivate(host, policy)) {
      throw new EgressBlockedError("private_address");
    }
  }
}

/** A relay URL taken apart for a transport. */
export interface SmtpTarget {
  host: string;
  port: number;
  secure: boolean;
  requireTls: boolean;
  user?: string;
  pass?: string;
}

// ---------- the guard ----------

export interface EgressDeps {
  resolver?: Resolver;
}

/**
 * One instance per process. Builds guarded `fetch` functions per origin and validates URLs at
 * write time. Holds no per-request state.
 */
export class EgressGuard {
  private readonly agents = new Map<EgressOrigin, Agent>();
  private readonly resolver: Resolver;

  constructor(
    readonly config: EgressConfig,
    deps: EgressDeps = {},
  ) {
    this.resolver = deps.resolver ?? systemResolver;
  }

  private policy(origin: EgressOrigin): PolicyInput {
    return { origin, config: this.config };
  }

  /** Syntactic check only; see `checkUrl`. */
  checkUrl(raw: string, origin: EgressOrigin): URL {
    return checkUrl(raw, this.policy(origin));
  }

  /**
   * Write-time validation: the syntactic check plus one resolution. A convenience so a bad value
   * is refused with a clear message when it is saved; the connect-time check decides at use.
   * A name that does not resolve yet is not an error here (the provider may be configured before
   * its DNS record exists); only a name that resolves somewhere forbidden is.
   */
  async validateUrl(raw: string, origin: EgressOrigin): Promise<URL> {
    const url = this.checkUrl(raw, origin);
    const host = bareHost(url.hostname);
    if (isIP(host)) return url;
    let addresses: { address: string; family: number }[];
    try {
      addresses = await this.resolver(host);
    } catch {
      return url;
    }
    assertAddressesAllowed(host, addresses, this.policy(origin));
    return url;
  }

  /**
   * Syntactic check of an `smtp://` or `smtps://` relay. A tenant's relay must be a public DNS
   * name on a submission port with TLS; the operator's may be an allowlisted internal host.
   * Returns the parts a transport needs. Never resolves a name.
   */
  checkSmtpUrl(raw: string, origin: EgressOrigin): SmtpTarget {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new EgressBlockedError("malformed_url");
    }
    if (url.protocol !== "smtp:" && url.protocol !== "smtps:") {
      throw new EgressBlockedError("scheme", url.protocol);
    }
    const secure = url.protocol === "smtps:";
    const port = url.port === "" ? (secure ? 465 : 587) : Number(url.port);
    const host = bareHost(url.hostname);
    const permissive = this.config.mode === "permissive";
    if (host === "") throw new EgressBlockedError("malformed_url");
    if (!permissive && origin === "tenant") {
      if (isIP(host)) throw new EgressBlockedError("ip_literal");
      if (isLocalName(host)) throw new EgressBlockedError("local_name", host);
      if (!SMTP_TENANT_PORTS.has(port)) throw new EgressBlockedError("port", String(port));
    }
    if (isIP(host)) {
      const verdict = classifyAddress(host);
      if (verdict.hard) throw new EgressBlockedError("metadata_address");
      if (verdict.nonPublic && !isAllowedPrivate(host, this.policy(origin))) {
        throw new EgressBlockedError("private_address", host);
      }
    }
    return {
      host,
      port,
      secure,
      // A tenant's relay must encrypt: credentials and message bodies go over the open internet.
      requireTls: !permissive && origin === "tenant",
      ...(url.username ? { user: decodeURIComponent(url.username) } : {}),
      ...(url.password ? { pass: decodeURIComponent(url.password) } : {}),
    };
  }

  /** Write-time check for a relay: the syntactic rules plus one resolution; see `validateUrl`. */
  async validateSmtpUrl(raw: string, origin: EgressOrigin): Promise<SmtpTarget> {
    const target = this.checkSmtpUrl(raw, origin);
    if (isIP(target.host)) return target;
    let addresses: { address: string; family: number }[];
    try {
      addresses = await this.resolver(target.host);
    } catch {
      return target;
    }
    assertAddressesAllowed(target.host, addresses, this.policy(origin));
    return target;
  }

  /** Resolves a hostname and returns an address that passed the policy, for callers that dial by IP. */
  async resolveAllowed(host: string, origin: EgressOrigin): Promise<{ address: string; family: number }> {
    const name = bareHost(host);
    if (isIP(name)) {
      assertAddressesAllowed(name, [{ address: name }], this.policy(origin));
      return { address: name, family: isIP(name) };
    }
    const addresses = await this.resolver(name);
    assertAddressesAllowed(name, addresses, this.policy(origin));
    const first = addresses[0];
    if (!first) throw new EgressBlockedError("private_address", "no address");
    return first;
  }

  /**
   * A `lookup` for `net.connect` / undici `connect`. It runs for every new connection, resolves
   * the name itself, refuses the connection if any answer is forbidden, and hands the socket the
   * validated address, so there is no gap between the check and the use.
   */
  lookupFor(
    origin: EgressOrigin,
  ): (
    hostname: string,
    options: dns.LookupOptions,
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string | dns.LookupAddress[],
      family?: number,
    ) => void,
  ) => void {
    return (hostname, options, callback) => {
      this.resolver(bareHost(hostname)).then(
        (addresses) => {
          try {
            assertAddressesAllowed(bareHost(hostname), addresses, this.policy(origin));
          } catch (err) {
            callback(err as NodeJS.ErrnoException, "");
            return;
          }
          const wanted = options.family === 4 || options.family === 6 ? options.family : 0;
          const usable = addresses.filter((a) => wanted === 0 || a.family === wanted);
          if (options.all) {
            callback(
              null,
              usable.map((a) => ({ address: a.address, family: a.family })),
            );
            return;
          }
          const first = usable[0];
          if (!first) {
            callback(Object.assign(new Error(`no ${wanted} address`), { code: "ENOTFOUND" }), "");
            return;
          }
          callback(null, first.address, first.family);
        },
        (err: unknown) => {
          callback(err as NodeJS.ErrnoException, "");
        },
      );
    };
  }

  private agent(origin: EgressOrigin): Agent {
    let agent = this.agents.get(origin);
    if (!agent) {
      agent = new Agent({
        connect: {
          timeout: this.config.connectTimeoutMs ?? 10_000,
          lookup: this.lookupFor(origin),
        },
      });
      this.agents.set(origin, agent);
    }
    return agent;
  }

  /**
   * A `fetch` that can only reach what the policy allows. Redirects are never followed (a provider
   * has no reason to redirect, and each hop would be a new destination to judge), and a response
   * larger than the cap is cut off rather than buffered.
   */
  fetchFor(origin: EgressOrigin): typeof fetch {
    const max = this.config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    const guarded = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      this.checkUrl(raw, origin);
      // Provider headers are judged where the provider is built (see CallerFactory) and where
      // they are saved, because only there can a tenant's `Authorization` be told apart from the
      // adapter's own. What is refused here is the one header that re-aims a request.
      if (init?.headers && hasHeader(init.headers, "host")) throw new EgressBlockedError("header", "host");
      const res = await undiciFetch(raw, {
        ...(init as Record<string, unknown> | undefined),
        redirect: "manual",
        dispatcher: this.agent(origin),
      } as never);
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => undefined);
        throw new EgressBlockedError("redirect");
      }
      return capBody(res as unknown as Response, max);
    };
    return guarded;
  }

  /** Closes pooled sockets. For tests and shutdown. */
  async close(): Promise<void> {
    await Promise.all([...this.agents.values()].map((a) => a.close()));
    this.agents.clear();
  }
}

function hasHeader(headers: HeadersInit, name: string): boolean {
  if (Array.isArray(headers)) return headers.some(([k]) => k.toLowerCase() === name);
  if (headers instanceof Headers) return headers.has(name);
  return Object.keys(headers).some((k) => k.toLowerCase() === name);
}

/** Wraps a response so a body past `max` bytes errors the stream instead of growing without bound. */
function capBody(res: Response, max: number): Response {
  if (!res.body) return res;
  let seen = 0;
  const limited = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > max) {
          controller.error(new EgressBlockedError("response_too_large"));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(limited, { status: res.status, statusText: res.statusText, headers: res.headers });
}

// ---------- outcome classification ----------

export type ConnectOutcome = "blocked_address" | "tls_error" | "timeout" | "unreachable";

/**
 * Reduces any failure to open a connection to one of four coarse outcomes. The detail (which
 * address, which port, refused or filtered) is exactly what a port scan would want, so none of it
 * is returned: "refused" and "filtered" are the same answer.
 */
export function classifyConnectFailure(err: unknown): ConnectOutcome {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (current instanceof EgressBlockedError) return "blocked_address";
    const e = current as { code?: unknown; name?: unknown; cause?: unknown; errors?: unknown };
    const code = typeof e.code === "string" ? e.code : "";
    if (
      code.startsWith("ERR_TLS") ||
      code.startsWith("ERR_SSL") ||
      code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
      code === "CERT_HAS_EXPIRED" ||
      code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
      code === "SELF_SIGNED_CERT_IN_CHAIN" ||
      code === "ERR_TLS_CERT_ALTNAME_INVALID" ||
      code === "EPROTO"
    ) {
      return "tls_error";
    }
    if (
      code === "UND_ERR_CONNECT_TIMEOUT" ||
      code === "UND_ERR_HEADERS_TIMEOUT" ||
      code === "UND_ERR_BODY_TIMEOUT" ||
      code === "ETIMEDOUT" ||
      e.name === "TimeoutError" ||
      e.name === "AbortError"
    ) {
      return "timeout";
    }
    if (Array.isArray(e.errors)) {
      for (const inner of e.errors as unknown[]) {
        const verdict = classifyConnectFailure(inner);
        if (verdict !== "unreachable") return verdict;
      }
    }
    current = e.cause;
  }
  return "unreachable";
}
