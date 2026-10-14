import type { EgressGuard, EgressOrigin } from "../net/egress.js";
import { classifySmtpError, SMTP_ERROR_MESSAGES, type SmtpErrorClass } from "./smtp-errors.js";
import { SmtpEmail } from "./smtp.js";

export interface TestSendInput {
  /** The connection string to exercise; a relay that is not saved yet is as good as a saved one. */
  url: string;
  from: string;
  replyTo?: string;
  to: string;
  subject: string;
  text: string;
  /** Whose policy the relay is held to: a tenant's is stricter than the operator's (S4). */
  origin: EgressOrigin;
  egress: EgressGuard;
  /** Defaults to 8 s: a hung relay is an answer for an admin waiting at a form. */
  timeoutMs?: number;
}

export type TestSendResult =
  { ok: true } | { ok: false; errorClass: SmtpErrorClass; message: string; cause: unknown };

/**
 * Sends one message through exactly the relay it is given, with the same egress policy a real
 * send meets, and reports a failure as a class and a sentence rather than as an error to log.
 * The caller decides what to keep: `cause` is for the server log only.
 */
export async function sendTestMessage(input: TestSendInput): Promise<TestSendResult> {
  let transport: SmtpEmail | undefined;
  try {
    // Validated before dialling so a forbidden relay is "blocked", not a connection error.
    await input.egress.validateSmtpUrl(input.url, input.origin);
    transport = new SmtpEmail(
      input.url,
      input.from,
      { egress: input.egress, origin: input.origin },
      input.timeoutMs ?? 8000,
    );
    await transport.send({
      to: input.to,
      from: input.from,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      subject: input.subject,
      text: input.text,
    });
    return { ok: true };
  } catch (cause) {
    const errorClass = classifySmtpError(cause);
    return { ok: false, errorClass, message: SMTP_ERROR_MESSAGES[errorClass], cause };
  } finally {
    transport?.close();
  }
}
