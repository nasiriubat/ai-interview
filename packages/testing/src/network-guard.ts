import net from "node:net";

/**
 * The runtime half of "tests never hit the network" (AGENTS.md rule 5).
 *
 * Installed as a Vitest `setupFiles` entry in every package. It makes an outbound connection to
 * anything but the loopback interface (and the database named by `DATABASE_URL`) fail loudly with
 * "network access in tests", at two levels: `fetch`, so the message names the URL, and
 * `net.Socket.connect`, which every other client (http, https, tls, undici, pg, nodemailer)
 * goes through.
 *
 * Loopback stays open on purpose. The API suites start their own fake model server on 127.0.0.1
 * and talk to it over real HTTP; that is the test seam, not a leak.
 *
 * A test that needs to prove this works calls `assertNetworkBlocked` (see the canary tests).
 */

export class NetworkAccessError extends Error {
  constructor(readonly target: string) {
    super(`network access in tests: ${target}`);
    this.name = "NetworkAccessError";
  }
}

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|::1|\[::1\]|0\.0\.0\.0|::)$/i;

function databaseHost(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url) return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** True when a connection to `host` is allowed from a test. */
export function isHostAllowed(host: string): boolean {
  const h = host.toLowerCase();
  return LOOPBACK.test(h) || h === databaseHost();
}

function hostFromConnectArgs(rawArgs: unknown[]): string | undefined {
  // `net.connect` hands the socket one pre-normalized `[options, callback]` array.
  const args = Array.isArray(rawArgs[0]) ? (rawArgs[0] as unknown[]) : rawArgs;
  const first = args[0];
  if (first !== null && typeof first === "object") {
    const o = first as { host?: unknown; path?: unknown };
    // A unix socket: local by construction.
    if (typeof o.path === "string") return undefined;
    return typeof o.host === "string" ? o.host : "localhost";
  }
  if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) {
    return typeof args[1] === "string" ? args[1] : "localhost";
  }
  return undefined;
}

const INSTALLED = Symbol.for("aidp.testing.networkGuard");

/** Idempotent: a second call in the same process does nothing. */
export function installNetworkGuard(): void {
  const g = globalThis as Record<symbol, unknown>;
  if (g[INSTALLED]) return;
  g[INSTALLED] = true;

  const realFetch = globalThis.fetch;
  globalThis.fetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const raw = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    let host: string;
    try {
      host = new URL(raw, "http://localhost").hostname;
    } catch {
      return Promise.reject(new NetworkAccessError(raw));
    }
    if (!isHostAllowed(host)) return Promise.reject(new NetworkAccessError(raw));
    return realFetch(input, init);
  };

  // eslint-disable-next-line @typescript-eslint/unbound-method -- re-applied with `this` below
  const realConnect = net.Socket.prototype.connect as (this: net.Socket, ...args: unknown[]) => net.Socket;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]): net.Socket {
    const host = hostFromConnectArgs(args);
    if (host !== undefined && !isHostAllowed(host)) {
      const err = new NetworkAccessError(host);
      process.nextTick(() => {
        this.destroy(err);
      });
      return this;
    }
    return realConnect.apply(this, args);
  };
}

/**
 * For the canary tests: proves the guard is live in this test process by trying to reach a public
 * address through both layers and expecting both to be refused.
 */
export async function assertNetworkBlocked(): Promise<void> {
  const refused = async (attempt: () => Promise<unknown>): Promise<boolean> => {
    try {
      await attempt();
      return false;
    } catch (err) {
      return err instanceof NetworkAccessError || String(err).includes("network access in tests");
    }
  };
  const viaFetch = await refused(() => fetch("https://example.com/"));
  const viaSocket = await refused(
    () =>
      new Promise((resolve, reject) => {
        const socket = net.connect({ host: "example.com", port: 443 });
        socket.once("connect", () => {
          socket.destroy();
          resolve(undefined);
        });
        socket.once("error", reject);
      }),
  );
  if (!viaFetch) throw new Error("fetch to a public host was not blocked");
  if (!viaSocket) throw new Error("a raw socket to a public host was not blocked");
}

installNetworkGuard();
