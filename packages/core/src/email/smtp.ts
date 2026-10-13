import nodemailer from "nodemailer";
import type { EgressGuard, EgressOrigin } from "../net/egress.js";
import type { EmailMessage, EmailPort } from "./port.js";

/** Applies the egress policy to a relay a tenant or the operator chose (S4). */
export interface SmtpGuard {
  egress: EgressGuard;
  origin: EgressOrigin;
}

/**
 * SMTP through nodemailer. `url` is an smtp:// or smtps:// connection string.
 *
 * Without a guard (the relay came from the deployment's environment) the URL is handed to
 * nodemailer as it is. With one, the address is chosen here: the relay's name is resolved on
 * every send, every answer is judged against the policy, and the connection is made to the
 * validated IP literal with the original name as the TLS server name. That is the same
 * "check and connect use one answer" rule the HTTP transport follows, applied to a library that
 * would otherwise do its own lookup.
 */
export class SmtpEmail implements EmailPort {
  private readonly transport: ReturnType<typeof nodemailer.createTransport> | undefined;
  constructor(
    private readonly url: string,
    private readonly defaultFrom: string,
    private readonly guard?: SmtpGuard,
  ) {
    this.transport = guard ? undefined : nodemailer.createTransport(url);
    // Refuse a forbidden relay at construction, not on the first send, so a bad value is a
    // configuration error that shows where it was made.
    if (guard) guard.egress.checkSmtpUrl(url, guard.origin);
  }

  async send(m: EmailMessage): Promise<void> {
    const message = {
      from: m.from ?? this.defaultFrom,
      to: m.to,
      subject: m.subject,
      text: m.text,
      ...(m.html ? { html: m.html } : {}),
      ...(m.replyTo ? { replyTo: m.replyTo } : {}),
    };
    if (this.transport) {
      await this.transport.sendMail(message);
      return;
    }
    const { guard } = this;
    if (!guard) return;
    const target = guard.egress.checkSmtpUrl(this.url, guard.origin);
    const { address } = await guard.egress.resolveAllowed(target.host, guard.origin);
    const transport = nodemailer.createTransport({
      host: address,
      port: target.port,
      secure: target.secure,
      requireTLS: target.requireTls,
      tls: { servername: target.host },
      ...(target.user !== undefined ? { auth: { user: target.user, pass: target.pass ?? "" } } : {}),
    });
    try {
      await transport.sendMail(message);
    } finally {
      transport.close();
    }
  }

  /** Releases the pooled connections a transport may hold. */
  close(): void {
    this.transport?.close();
  }
}
