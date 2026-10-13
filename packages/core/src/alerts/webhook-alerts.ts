import type { Severity } from "./port.js";
import { renderText, subjectLine, type RenderedAlert } from "./render.js";

export type WebhookFormat = "ntfy" | "slack" | "generic";

const NTFY_PRIORITY: Record<Severity, number> = { info: 3, warning: 4, critical: 5 };
const NTFY_TAGS: Record<Severity, string[]> = {
  info: ["information_source"],
  warning: ["warning"],
  critical: ["rotating_light"],
};

export interface WebhookBody {
  url: string;
  contentType: string;
  body: string;
}

/**
 * The three body shapes, as pure functions so the shell sidecar's copy of them (deploy/ops/notify.sh)
 * can be held to the same fields by a test.
 *
 * ntfy is published as JSON to the server root with the topic in the body, not as a plain POST to
 * the topic with the title in a header: HTTP headers are Latin-1 at best, and a tenant name with
 * an `ä` in it is one of the things an operator will be told about.
 */
export function webhookBody(
  format: WebhookFormat,
  url: string,
  alert: RenderedAlert,
  subjectPrefix: string,
): WebhookBody {
  const title = subjectLine(subjectPrefix, alert.title);
  const text = renderText(alert);
  if (format === "slack") {
    return {
      url,
      contentType: "application/json",
      body: JSON.stringify({
        text: title,
        blocks: [{ type: "section", text: { type: "mrkdwn", text: `*${title}*\n${text}` } }],
      }),
    };
  }
  if (format === "ntfy") {
    const parsed = new URL(url);
    const topic = parsed.pathname.replace(/^\/+|\/+$/g, "");
    const root = `${parsed.protocol}//${parsed.host}/`;
    return {
      url: root,
      contentType: "application/json",
      body: JSON.stringify({
        topic,
        title,
        message: text,
        priority: NTFY_PRIORITY[alert.severity],
        tags: NTFY_TAGS[alert.severity],
      }),
    };
  }
  return {
    url,
    contentType: "application/json",
    body: JSON.stringify({
      kind: alert.kind,
      severity: alert.severity,
      key: alert.key,
      title: alert.title,
      message: alert.message,
      companyId: alert.companyId ?? null,
      occurredAt: alert.occurredAt.toISOString(),
      count: alert.count,
      links: alert.links,
      runbook: alert.runbook ?? null,
      context: alert.context,
    }),
  };
}

export interface WebhookChannelOptions {
  /** Test seam; the network never opens in a test. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Posts an alert to the operator's webhook. A non-2xx answer or a timeout throws, so the router can say it failed. */
export class WebhookAlertChannel {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: WebhookChannelOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  async send(input: {
    url: string;
    format: WebhookFormat;
    alert: RenderedAlert;
    subjectPrefix: string;
  }): Promise<void> {
    const out = webhookBody(input.format, input.url, input.alert, input.subjectPrefix);
    // The URL is a credential (a Slack hook, an ntfy topic) so it is kept out of every message here.
    const res = await this.fetchImpl(out.url, {
      method: "POST",
      headers: { "content-type": out.contentType },
      body: out.body,
      redirect: "manual",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status < 200 || res.status >= 300) throw new Error(`alert webhook answered ${res.status}`);
  }
}
