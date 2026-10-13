import type { EmailPort } from "../email/port.js";
import { renderText, subjectLine, type RenderedAlert } from "./render.js";

/**
 * Sends an alert as plain-text mail through the platform's own email port, so the tenant's SMTP
 * and branding apply to a tenant notice and the platform relay to an operator one
 * (`companyId` undefined resolves the platform configuration; see SettingsEmail).
 */
export class EmailAlertChannel {
  constructor(private readonly email: EmailPort) {}

  async send(input: {
    to: string;
    subjectPrefix: string;
    alert: RenderedAlert;
    /** Present for a tenant notice so its own SMTP settings are used. */
    companyId?: string | undefined;
    footer?: string;
  }): Promise<void> {
    await this.email.send({
      to: input.to,
      subject: subjectLine(input.subjectPrefix, input.alert.title),
      text: renderText(input.alert, input.footer),
      ...(input.companyId ? { companyId: input.companyId } : {}),
    });
  }
}
