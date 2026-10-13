import nodemailer from "nodemailer";
import type { EmailMessage, EmailPort } from "./port.js";

/** SMTP through nodemailer. `url` is an smtp:// or smtps:// connection string. */
export class SmtpEmail implements EmailPort {
  private readonly transport: ReturnType<typeof nodemailer.createTransport>;
  constructor(
    url: string,
    private readonly defaultFrom: string,
  ) {
    this.transport = nodemailer.createTransport(url);
  }
  async send(m: EmailMessage): Promise<void> {
    await this.transport.sendMail({
      from: m.from ?? this.defaultFrom,
      to: m.to,
      subject: m.subject,
      text: m.text,
      ...(m.html ? { html: m.html } : {}),
      ...(m.replyTo ? { replyTo: m.replyTo } : {}),
    });
  }
  /** Releases the pooled connections a transport may hold. */
  close(): void {
    this.transport.close();
  }
}
