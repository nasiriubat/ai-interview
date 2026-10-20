import type { EmailPort, SettingsService } from "@aidp/core";
import { isEmailAddress, type PilotRequest } from "@aidp/shared";
import { AppError } from "../../lib/errors.js";
import { PilotTickets } from "./ticket.js";

/** A person cannot read and fill seven fields faster than this. */
export const PILOT_MIN_FILL_MS = 3_000;
/** A form left open longer than this asks for a reload rather than being trusted. */
export const PILOT_TICKET_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface PilotLog {
  info: (meta: Record<string, unknown>, message: string) => void;
  warn: (meta: Record<string, unknown>, message: string) => void;
}

export interface PilotDeps {
  settings: SettingsService;
  email: EmailPort;
  authSecret: string;
  /** Environment fallbacks for the recipient, in order of preference. */
  env: { pilotRequestEmail?: string | undefined; alertEmail?: string | undefined };
  log: PilotLog;
  now?: () => number;
}

/** Where the request came from, as the API already knows it. Never geolocated. */
export interface PilotOrigin {
  ip: string;
  userAgent?: string | undefined;
}

export type PilotOutcome = "sent" | "honeypot" | "too_fast" | "stale" | "not_configured" | "send_failed";

const SIZE_LABEL: Record<PilotRequest["companySize"], string> = {
  "1-49": "1–49",
  "50-249": "50–249",
  "250-999": "250–999",
  "1000+": "1000+",
};
const INTEREST_LABEL: Record<PilotRequest["interest"], string> = {
  discovery: "Discovery interviews with employees",
  requirements: "Requirements for something to build",
  both: "Both",
  unsure: "Not sure yet",
};
const PARTICIPANTS_LABEL: Record<NonNullable<PilotRequest["participants"]>, string> = {
  "1-10": "1–10",
  "11-30": "11–30",
  "31-100": "31–100",
  "100+": "More than 100",
  unsure: "Not sure yet",
};

/**
 * A header value from text a stranger typed: one line, no control characters (CR and LF above
 * all, which would start a header of their own), and bounded. The contract already refuses line
 * breaks in these fields; this is the second fence, at the place the header is made.
 */
export function headerSafe(value: string, max = 200): string {
  return value
    .replace(/[\p{Cc}\u2028\u2029]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max);
}

/** Body text: line breaks kept (the message is prose), every other control character removed. */
function bodySafe(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/(?!\n)\p{Cc}/gu, "")
    .trim();
}

/**
 * The public "Request a pilot" form (`/pilot`): checks that a person sent it, then emails it to
 * the operator with Reply-To set to the requester, so answering is pressing reply.
 *
 * Nothing is ever sent to the requester's address. A form that mailed whatever address it was
 * given would be a relay for anyone's spam, so the only recipient is the operator's own inbox.
 * Nothing is stored either: the email is the record, and a failed send is an error the visitor
 * sees and can retry, so a lead is never dropped silently.
 */
export class PilotRequestService {
  private readonly tickets: PilotTickets;
  private readonly now: () => number;

  constructor(private readonly deps: PilotDeps) {
    this.tickets = new PilotTickets(deps.authSecret, PILOT_MIN_FILL_MS, PILOT_TICKET_MAX_AGE_MS);
    this.now = deps.now ?? Date.now;
  }

  ticket(): { ticket: string } {
    return { ticket: this.tickets.issue(this.now()) };
  }

  /**
   * Who receives pilot requests: the platform setting `sales.pilotRequestEmail` (the operator sets
   * it on the settings screen), then `PILOT_REQUEST_EMAIL`, then where operator alerts go
   * (`ops.alertEmail`, then `ALERT_EMAIL`). `null` when none of them names an address.
   */
  async recipient(): Promise<string | null> {
    const [own, alert] = await Promise.all([
      this.deps.settings.get("sales.pilotRequestEmail", []),
      this.deps.settings.get("ops.alertEmail", []),
    ]);
    for (const candidate of [own, this.deps.env.pilotRequestEmail, alert, this.deps.env.alertEmail]) {
      const value = candidate?.trim() ?? "";
      if (value && isEmailAddress(value)) return value;
    }
    return null;
  }

  async submit(input: PilotRequest, origin: PilotOrigin): Promise<{ ok: true }> {
    const at = this.now();
    const meta = {
      event: "pilot_request",
      companySize: input.companySize,
      interest: input.interest,
      participants: input.participants ?? null,
      emailDomain: input.email.split("@").pop()?.toLowerCase() ?? "",
      messageChars: input.message?.length ?? 0,
    };
    const done = (outcome: PilotOutcome, level: "info" | "warn" = "info"): void => {
      this.deps.log[level]({ ...meta, outcome }, "pilot request");
    };

    // A filled honeypot is a script. It is told "thanks" so it has nothing to learn from.
    if (input.website && input.website.trim() !== "") {
      done("honeypot");
      return { ok: true };
    }
    const check = this.tickets.check(input.ticket, at);
    if (!check.ok) {
      done(check.reason);
      throw new AppError(
        "validation",
        check.reason === "too_fast"
          ? "The form was sent too quickly. Check the details and send it again."
          : "The form has expired. Reload the page and send it again.",
        { reason: check.reason },
      );
    }

    const to = await this.recipient();
    if (!to) {
      done("not_configured", "warn");
      throw new AppError("unavailable", "Pilot requests cannot be received right now. Try again later.");
    }

    const productName = await this.deps.settings.get("branding.productName", []);
    try {
      await this.deps.email.send({
        to,
        replyTo: headerSafe(input.email, 254),
        subject: headerSafe(`Pilot request: ${input.company} (${input.name})`),
        text: this.body(input, origin, productName, at),
      });
    } catch (err) {
      this.deps.log.warn(
        { ...meta, outcome: "send_failed", err: err instanceof Error ? err.message : String(err) },
        "pilot request",
      );
      throw new AppError("unavailable", "The request could not be sent. Try again in a few minutes.");
    }
    done("sent");
    return { ok: true };
  }

  private body(input: PilotRequest, origin: PilotOrigin, productName: string, at: number): string {
    const row = (label: string, value: string): string => `${`${label}:`.padEnd(22)}${value}`;
    const message = input.message ? bodySafe(input.message) : "";
    return [
      `A pilot request for ${headerSafe(productName, 80)} arrived from the website form.`,
      "Reply to this email to answer the requester directly.",
      "",
      row("Name", headerSafe(input.name)),
      row("Work email", headerSafe(input.email, 254)),
      row("Organization", headerSafe(input.company)),
      row("Role", headerSafe(input.role)),
      row("Company size", SIZE_LABEL[input.companySize]),
      row("Wants to explore", INTEREST_LABEL[input.interest]),
      row("People to interview", input.participants ? PARTICIPANTS_LABEL[input.participants] : "Not given"),
      row("Page language", input.locale ?? "Not given"),
      row("Consent to contact", "Yes, about the pilot"),
      "",
      "Message:",
      message || "(none)",
      "",
      "--",
      row("Received", new Date(at).toISOString()),
      row("Client address", origin.ip),
      ...(origin.userAgent ? [row("Browser", headerSafe(origin.userAgent, 300))] : []),
      "The requester agreed to be contacted about the pilot only. Do not add them to a mailing list.",
      "",
    ].join("\n");
  }
}
