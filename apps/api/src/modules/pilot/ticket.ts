import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/**
 * The signed time a pilot form was shown (anti-abuse for `POST /public/pilot-requests`).
 *
 * The page asks for a ticket when it renders and sends it back with the form. The ticket is the
 * issue time and an HMAC over it, so the API can tell how long the form was open without
 * trusting the browser's clock, and a script that posts straight at the endpoint without loading
 * the page has none. The key is derived from `AUTH_SECRET` for this purpose alone (HKDF, as the
 * internal credential is in D-260), so nothing new is deployed and the ticket key cannot sign a
 * session.
 */
const INFO = "aidp/pilot-ticket";

export type TicketCheck = { ok: true; ageMs: number } | { ok: false; reason: "stale" | "too_fast" };

export class PilotTickets {
  private readonly key: Buffer;

  constructor(
    authSecret: string,
    private readonly minAgeMs: number,
    private readonly maxAgeMs: number,
  ) {
    this.key = Buffer.from(
      hkdfSync("sha256", Buffer.from(authSecret, "utf8"), Buffer.alloc(0), Buffer.from(INFO, "utf8"), 32),
    );
  }

  issue(nowMs: number): string {
    const at = String(Math.floor(nowMs));
    return `${at}.${this.sign(at)}`;
  }

  /** Too fast is a person who may simply send again; anything unreadable or old is `stale`. */
  check(ticket: string | undefined, nowMs: number): TicketCheck {
    if (!ticket) return { ok: false, reason: "stale" };
    const match = /^(\d{1,16})\.([A-Za-z0-9_-]{43})$/.exec(ticket);
    if (!match) return { ok: false, reason: "stale" };
    const [, at = "", sig = ""] = match;
    const expected = Buffer.from(this.sign(at));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      return { ok: false, reason: "stale" };
    }
    const ageMs = nowMs - Number(at);
    // A ticket from the future (a small clock step between processes) counts as just issued.
    if (ageMs < this.minAgeMs) return { ok: false, reason: "too_fast" };
    if (ageMs > this.maxAgeMs) return { ok: false, reason: "stale" };
    return { ok: true, ageMs };
  }

  private sign(at: string): string {
    return createHmac("sha256", this.key).update(`pilot:${at}`).digest("base64url");
  }
}
