import { EgressBlockedError } from "../net/egress.js";

/**
 * What went wrong when a relay was exercised, in a handful of classes an admin can act on.
 * Deliberately not the raw errno or message: `connection_refused` and `timeout` already tell an
 * admin their port is closed or filtered, which is the point of a test send. The egress policy
 * decides which addresses can be dialled at all, so this is not a scanner for the internal network.
 */
export const SMTP_ERROR_CLASSES = [
  "auth_failed",
  "connection_refused",
  "tls_failed",
  "timeout",
  "host_not_found",
  "blocked",
  "rejected",
  "unknown",
] as const;
export type SmtpErrorClass = (typeof SMTP_ERROR_CLASSES)[number];

interface Failure {
  code?: unknown;
  message?: unknown;
  cause?: unknown;
}

/** Sorts a nodemailer or socket failure into one class. Never includes the message in the result. */
export function classifySmtpError(error: unknown): SmtpErrorClass {
  if (error instanceof EgressBlockedError) return "blocked";
  const chain: Failure[] = [];
  let cur: unknown = error;
  for (let i = 0; i < 4 && cur !== null && typeof cur === "object"; i++) {
    const failure: Failure = cur;
    chain.push(failure);
    cur = failure.cause;
  }
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const codes = chain.map((e) => str(e.code));
  const text = chain.map((e) => str(e.message)).join(" | ");
  const has = (...c: string[]): boolean => c.some((x) => codes.includes(x));

  if (
    has("EAUTH") ||
    /\b535\b|authentication (failed|unsuccessful)|invalid login|bad credentials/i.test(text)
  )
    return "auth_failed";
  if (has("ETIMEDOUT", "ESOCKETTIMEDOUT") || /timed? ?out|timeout/i.test(text)) return "timeout";
  if (has("ENOTFOUND", "EDNS", "EAI_AGAIN") || /getaddrinfo|ENOTFOUND/i.test(text)) return "host_not_found";
  if (
    has("ETLS") ||
    codes.some((c) => c.startsWith("ERR_TLS") || c.startsWith("ERR_SSL") || c.includes("CERT")) ||
    /\b(ssl|tls)\b|certificate|handshake|wrong version number|starttls/i.test(text)
  )
    return "tls_failed";
  if (has("ECONNREFUSED") || /ECONNREFUSED|connection refused/i.test(text)) return "connection_refused";
  if (has("EENVELOPE", "EMESSAGE")) return "rejected";
  if (has("ECONNECTION", "ECONNRESET", "ESOCKET", "EPIPE")) return "connection_refused";
  return "unknown";
}

/** The one-line explanation shown to an admin, in plain words. */
export const SMTP_ERROR_MESSAGES: Record<SmtpErrorClass, string> = {
  auth_failed: "The mail server rejected the username or password.",
  connection_refused: "The mail server refused the connection. Check the host and port.",
  tls_failed:
    "The secure connection could not be established. Check that the security setting matches the port (STARTTLS is usually 587, SSL/TLS 465).",
  timeout: "The mail server did not answer in time. Check the host and port, and that nothing blocks it.",
  host_not_found: "The mail server's name could not be found. Check the host for a typo.",
  blocked: "That mail server address is not allowed on this platform.",
  rejected: "The mail server refused the message. Check that the sender address is one it permits.",
  unknown: "Could not send through this configuration.",
};
