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
