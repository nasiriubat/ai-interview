import type { AlertKind } from "./kinds.js";
import type { AlertContext, Severity } from "./port.js";

/** An alert after the router has settled who gets it and what the store says about it. */
export interface RenderedAlert {
  kind: AlertKind;
  severity: Severity;
  key: string;
  title: string;
  message: string;
  companyId?: string | undefined;
  occurredAt: Date;
  /** How many times the condition has been seen under this key. */
  count: number;
  context: AlertContext;
  links: { label: string; url: string }[];
  /** `docs/OPERATIONS.md#anchor`, present on operator notices only. */
  runbook?: string | undefined;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Defence in depth for "no PII in an alert". Alerts leave the box (an email relay, ntfy.sh, Slack),
 * so the call sites pass ids and numbers; this catches the one mistake that would still hurt, an
 * address that rode along in a message, and bounds everything else.
 */
export function scrubText(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim().replace(EMAIL, "[email]");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function scrubContext(context: AlertContext | undefined): AlertContext {
  const out: AlertContext = {};
  for (const [k, v] of Object.entries(context ?? {})) {
    out[k.slice(0, 60)] = typeof v === "string" ? scrubText(v, 200) : v;
  }
  return out;
}

/** A subject must be one line and short enough not to be folded. */
export function subjectLine(prefix: string, title: string): string {
  return `${prefix} ${scrubText(title, 160)}`;
}

export function renderText(r: RenderedAlert, footer?: string): string {
  const lines: string[] = [r.message];
  const ctx = Object.entries(r.context);
  if (ctx.length > 0) {
    lines.push("", ...ctx.map(([k, v]) => `${k}: ${String(v)}`));
  }
  if (r.count > 1) lines.push("", `Seen ${r.count} times since it was first raised.`);
  if (r.runbook) lines.push("", `What to do: ${r.runbook}`);
  for (const l of r.links) lines.push(`${l.label}: ${l.url}`);
  if (footer) lines.push("", footer);
  return lines.join("\n");
}
