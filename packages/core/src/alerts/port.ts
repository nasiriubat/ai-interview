import type { AlertKind } from "./kinds.js";

export type Severity = "info" | "warning" | "critical";
export type Audience = "operator" | "tenant_admins";

export const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

/** Ids and numbers only. Never a name, an address, a transcript or an error message (D-90). */
export type AlertContext = Record<string, string | number | boolean>;

export interface Alert {
  kind: AlertKind;
  /** Defaults to the catalog's severity for the kind; a source may raise it, e.g. disk 90%. */
  severity?: Severity;
  /** Narrows the catalog's audience. It can never widen it: a kind the catalog keeps off a tenant's mail stays off. */
  audience?: Audience[];
  /** Dedupe key. The same key within the repeat window is counted, not re-sent. */
  key: string;
  /** Required for tenant_admins: the one tenant whose admins may be told. */
  companyId?: string;
  /** Subject line without the prefix. */
  title: string;
  /** Plain-text body, no PII. */
  message: string;
  context?: AlertContext;
  /**
   * A tenant notice in other languages, keyed by language code. The router picks the one the
   * tenant's `branding.language` names and falls back to `title` and `message` (English). Link
   * labels are by position.
   */
  localized?: Partial<Record<string, { title: string; message: string; linkLabels?: string[] }>>;
  links?: { label: string; url: string }[];
  occurredAt?: Date;
}

export type Suppressed = "duplicate" | "rate_limited" | "below_min_severity" | null;

export interface RaiseResult {
  /**
   * True when someone was told: this call reached a channel, or an earlier call within the repeat
   * window did and is still standing. This is what the participant's "the organizer has been
   * notified" sentence is allowed to rest on, so a duplicate counts but a rate-limited or
   * unconfigured alert does not.
   */
  delivered: boolean;
  suppressed: Suppressed;
}

export interface AlertPort {
  /** Never throws. Returns what happened so a caller can tell the user the truth. */
  raise(alert: Alert): Promise<RaiseResult>;
  /** Clears a key so the next occurrence is sent again (the backup succeeded after a failure). */
  resolve(key: string): Promise<void>;
}

/** Records alerts; used by every test that provokes one, and as the no-op in tools that do not alert. */
export class MemoryAlerts implements AlertPort {
  readonly raised: Alert[] = [];
  readonly resolved: string[] = [];
  /** What `raise` answers; a test sets it to exercise the "nobody could be told" branch. */
  result: RaiseResult = { delivered: true, suppressed: null };

  async raise(alert: Alert): Promise<RaiseResult> {
    this.raised.push(alert);
    return this.result;
  }

  async resolve(key: string): Promise<void> {
    this.resolved.push(key);
  }

  ofKind(kind: AlertKind): Alert[] {
    return this.raised.filter((a) => a.kind === kind);
  }
}
