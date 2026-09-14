export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  from?: string;
  replyTo?: string;
  /** Tenant the message belongs to, so a settings-backed port can resolve that tenant's SMTP. */
  companyId?: string;
}

export interface EmailPort {
  send(message: EmailMessage): Promise<void>;
}

/** Records messages; used by tests and by local dev when no SMTP is configured. */
export class MemoryEmail implements EmailPort {
  readonly sent: EmailMessage[] = [];
  constructor(private readonly log?: (m: EmailMessage) => void) {}
  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    this.log?.(message);
  }
}
