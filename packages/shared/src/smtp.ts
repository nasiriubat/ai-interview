import { z } from "zod";

/**
 * The structured shape of an SMTP relay (D-410). The stored value stays the one `email.smtpUrl`
 * connection string, so nothing is migrated: this module composes a string from parts and parses
 * a string back into them. Credentials are percent-encoded on the way in and decoded on the way
 * out, so a password containing `@`, `:`, `/` or `#` survives the round trip.
 *
 * Security is carried by the scheme and one nodemailer option, both of which the transport and
 * the egress policy already understand:
 *   ssl       smtps://host:465                  implicit TLS
 *   starttls  smtp://host:587?requireTLS=true   upgrade, and refuse to continue in the clear
 *   none      smtp://host:25?ignoreTLS=true     plain text (operator scope only, see egress)
 * A legacy value with neither option parses as `starttls`, which is what nodemailer does with it
 * when the server offers the upgrade.
 */
export const SMTP_SECURITIES = ["starttls", "ssl", "none"] as const;
export type SmtpSecurity = (typeof SMTP_SECURITIES)[number];

/** The port a mail server conventionally listens on for each mode. */
export const SMTP_DEFAULT_PORTS: Record<SmtpSecurity, number> = { starttls: 587, ssl: 465, none: 25 };

export interface SmtpParts {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  password: string;
}

const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/** True when `host` looks like a DNS name or an IPv4 address. IPv6 literals are written in brackets. */
export function isSmtpHost(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  if (/^\[[0-9a-f:.]+\]$/i.test(host)) return true;
  return HOST.test(host);
}

/** Composes `email.smtpUrl` from its parts. Throws on a part that cannot form a valid address. */
export function composeSmtpUrl(parts: SmtpParts): string {
  const host = parts.host.trim();
  if (!isSmtpHost(host)) throw new Error("invalid_host");
  if (!Number.isInteger(parts.port) || parts.port < 1 || parts.port > 65535) throw new Error("invalid_port");
  const scheme = parts.security === "ssl" ? "smtps" : "smtp";
  const auth =
    parts.username === ""
      ? ""
      : `${encodeURIComponent(parts.username)}${
          parts.password === "" ? "" : `:${encodeURIComponent(parts.password)}`
        }@`;
  const query =
    parts.security === "starttls" ? "?requireTLS=true" : parts.security === "none" ? "?ignoreTLS=true" : "";
  return `${scheme}://${auth}${host}:${parts.port}${query}`;
}

/** Takes a stored value apart. Returns null for anything that is not an SMTP URL. */
export function parseSmtpUrl(value: string): SmtpParts | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "smtp:" && url.protocol !== "smtps:") return null;
  const host = url.hostname;
  if (!host) return null;
  const secure = url.protocol === "smtps:";
  const port = url.port === "" ? (secure ? 465 : 587) : Number(url.port);
  const decode = (s: string): string => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const security: SmtpSecurity = secure
    ? "ssl"
    : url.searchParams.get("ignoreTLS") === "true"
      ? "none"
      : "starttls";
  return {
    host,
    port,
    security,
    username: decode(url.username),
    password: decode(url.password),
  };
}

/** What the form learns about a stored relay. A password is never read back. */
export interface SmtpSummary {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  passwordSet: boolean;
}

export function summariseSmtpUrl(value: string): SmtpSummary | null {
  const p = parseSmtpUrl(value);
  if (!p) return null;
  return {
    host: p.host,
    port: p.port,
    security: p.security,
    username: p.username,
    passwordSet: p.password !== "",
  };
}

/** The password field of a write: this value keeps what is stored. */
export const SMTP_PASSWORD_UNCHANGED = "__unchanged__";

/**
 * A relay as the form submits it. `password` is the sentinel to keep the stored one, a string to
 * replace it, and null (or an empty string) to have none.
 */
export const SmtpFormSchema = z.object({
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  security: z.enum(SMTP_SECURITIES),
  username: z.string().max(256).default(""),
  password: z.string().max(1024).nullable().default(SMTP_PASSWORD_UNCHANGED),
});
export type SmtpForm = z.output<typeof SmtpFormSchema>;

/** Resolves a form against the stored value (for the kept password) into the connection string. */
export function smtpUrlFromForm(form: SmtpForm, stored: string | undefined): string {
  let password: string;
  if (form.password === SMTP_PASSWORD_UNCHANGED) {
    const was = stored ? parseSmtpUrl(stored) : null;
    password = was?.password ?? "";
  } else {
    password = form.password ?? "";
  }
  return composeSmtpUrl({
    host: form.host,
    port: form.port,
    security: form.security,
    username: form.username,
    password,
  });
}

// ---- Install-time configuration (D-445) -------------------------------------------------------

/**
 * The values `SMTP_SECURITY` accepts, in the words a mail provider's help page uses. `tls` is
 * implicit TLS (the form's "SSL/TLS", stored as `smtps://`); `ssl` is accepted as a synonym.
 */
export const SMTP_ENV_SECURITIES = ["none", "starttls", "tls"] as const;
export type SmtpEnvSecurity = (typeof SMTP_ENV_SECURITIES)[number];

/** The environment variables a relay is read from. Everything else in the environment is ignored. */
export interface SmtpEnvInput {
  SMTP_HOST?: string | undefined;
  SMTP_PORT?: string | undefined;
  SMTP_SECURITY?: string | undefined;
  SMTP_USER?: string | undefined;
  SMTP_PASSWORD?: string | undefined;
  /** Deprecated (D-446): the one-URL form, still read when SMTP_HOST is not set. */
  EMAIL_SMTP_URL?: string | undefined;
}

export type SmtpEnvRelay =
  /** Composed from SMTP_*. `parts` and `url` carry the password, so neither is ever logged. */
  | { source: "smtp_vars"; url: string; parts: SmtpParts }
  /** The legacy EMAIL_SMTP_URL, passed through as written. */
  | { source: "legacy_url"; url: string }
  | { source: "none" };

/** A relay configuration that cannot be used. The message names variables, never their values. */
export class SmtpEnvError extends Error {
  override name = "SmtpEnvError";
}

/**
 * Resolves the deployment relay from the environment: the one rule the API, the worker and the
 * web app's sign-in mail share (`deploy/ops/notify.sh` mirrors it in shell, D-447).
 *
 *   1. SMTP_HOST set: the relay is composed from SMTP_HOST, SMTP_PORT, SMTP_SECURITY, SMTP_USER
 *      and SMTP_PASSWORD with `composeSmtpUrl`, the function the admin form uses. Credentials are
 *      taken literally and percent-encoded here, so an operator never encodes anything. The port
 *      defaults from the security (starttls 587, tls 465, none 25); security defaults to starttls.
 *   2. Otherwise EMAIL_SMTP_URL when set (deprecated, so existing installs keep working).
 *   3. Otherwise none.
 *
 * An empty string is "not set", because compose passes an unset variable through as "".
 */
export function resolveSmtpEnv(env: SmtpEnvInput): SmtpEnvRelay {
  const host = (env.SMTP_HOST ?? "").trim();
  if (host === "") {
    const stray = (["SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD"] as const).filter(
      (k) => (env[k] ?? "").trim() !== "",
    );
    if (stray.length > 0) {
      throw new SmtpEnvError(
        `${stray.join(", ")} ${stray.length === 1 ? "is" : "are"} set but SMTP_HOST is empty`,
      );
    }
    const legacy = (env.EMAIL_SMTP_URL ?? "").trim();
    if (legacy === "") return { source: "none" };
    if (!parseSmtpUrl(legacy)) throw new SmtpEnvError("EMAIL_SMTP_URL is not an smtp:// or smtps:// URL");
    return { source: "legacy_url", url: legacy };
  }
  if (!isSmtpHost(host)) {
    throw new SmtpEnvError("SMTP_HOST must be a host name or address only, such as smtp.example.com");
  }
  const rawSecurity = (env.SMTP_SECURITY ?? "").trim().toLowerCase();
  let security: SmtpSecurity;
  if (rawSecurity === "" || rawSecurity === "starttls") security = "starttls";
  else if (rawSecurity === "tls" || rawSecurity === "ssl") security = "ssl";
  else if (rawSecurity === "none") security = "none";
  else throw new SmtpEnvError("SMTP_SECURITY must be one of none, starttls, tls");
  const rawPort = (env.SMTP_PORT ?? "").trim();
  let port = SMTP_DEFAULT_PORTS[security];
  if (rawPort !== "") {
    const n = /^\d{1,5}$/.test(rawPort) ? Number(rawPort) : 0;
    if (n < 1 || n > 65535) throw new SmtpEnvError("SMTP_PORT must be a number between 1 and 65535");
    port = n;
  }
  // The password is used exactly as written: a space at either end can be part of it.
  const username = (env.SMTP_USER ?? "").trim();
  const password = env.SMTP_PASSWORD ?? "";
  if (username === "" && password !== "") {
    throw new SmtpEnvError("SMTP_PASSWORD is set but SMTP_USER is empty");
  }
  const parts: SmtpParts = { host, port, security, username, password };
  return { source: "smtp_vars", url: composeSmtpUrl(parts), parts };
}

/** The sentence a process prints when it refuses to start without a relay (D-448). */
export const SMTP_ENV_REQUIRED_MESSAGE =
  "No mail relay: set SMTP_HOST (with SMTP_PORT, SMTP_SECURITY, SMTP_USER, SMTP_PASSWORD) in " +
  "deploy/.env, or the deprecated EMAIL_SMTP_URL. Sign-in is by emailed link, so nobody can sign " +
  "in without one. See docs/DEPLOY.md, 'How the first admin signs in'.";

/**
 * The relay URL a server process uses, or undefined for none. A production process refuses to
 * start without one (D-448): a stack without a relay looks healthy and admits nobody. The result
 * carries the password: never log it.
 */
export function smtpRelayUrlFromEnv(env: SmtpEnvInput & { NODE_ENV?: string | undefined }): string | undefined {
  const relay = resolveSmtpEnv(env);
  if (relay.source !== "none") return relay.url;
  if (env.NODE_ENV === "production") throw new SmtpEnvError(SMTP_ENV_REQUIRED_MESSAGE);
  return undefined;
}
