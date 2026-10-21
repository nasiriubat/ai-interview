import type { ErrorSeverity, ErrorSource } from "@aidp/shared";

/**
 * One failure as a process reports it, before anything is redacted or truncated (D-477). Every
 * field but `source` and `message` is optional, because a browser knows the page and not the
 * route, a job knows its name and not a request, and so on.
 *
 * Never put a request body, a header, a participant's answer or an address in here. The sanitizer
 * scrubs what slips into a message or a stack, but the contract is that nothing is passed in.
 */
export interface ErrorEvent {
  source: ErrorSource;
  severity?: ErrorSeverity;
  /** The error's class name (`TypeError`); `Error` when unknown. */
  name?: string;
  message: string;
  stack?: string | undefined;
  /** The route pattern (`/campaigns/:id`) or, in the worker, nothing; derived from `path` when absent. */
  route?: string | undefined;
  /** The URL path the failure happened on; tokens and secrets in it are removed before storage. */
  path?: string | undefined;
  method?: string | undefined;
  status?: number | undefined;
  requestId?: string | undefined;
  companyId?: string | null | undefined;
  /** A staff user's id. Never an email or a name. */
  userId?: string | undefined;
  /** A participant's interview session id. Never a token. */
  sessionId?: string | undefined;
  release?: string | undefined;
  userAgent?: string | undefined;
  jobName?: string | undefined;
  /** 1 for the first attempt. */
  jobAttempt?: number | undefined;
  /** True when no retry follows: the job is about to be dead-lettered. */
  jobFinal?: boolean | undefined;
  /** When it happened; now when absent. */
  at?: Date | undefined;
}

/** What is stored for one occurrence: every text field redacted and bounded. */
export interface ErrorRecord {
  /** The fault, across tenants: source, name, normalised message, route or top frame. */
  fingerprint: string;
  /** The fault within one tenant (or the platform): the row an occurrence is counted on. */
  groupKey: string;
  source: ErrorSource;
  severity: ErrorSeverity;
  name: string;
  message: string;
  stack: string | null;
  route: string | null;
  path: string | null;
  method: string | null;
  status: number | null;
  requestId: string | null;
  companyId: string | null;
  userId: string | null;
  sessionId: string | null;
  release: string | null;
  userAgent: string | null;
  jobName: string | null;
  jobAttempt: number | null;
  jobFinal: boolean | null;
  occurredAt: Date;
}

/**
 * One write to the store: `count` occurrences of a group, of which, when `storeOccurrence` is
 * set, the one in `record` is kept as a sample. Throttled repeats arrive as one write with a
 * count and no sample.
 */
export interface ErrorWrite {
  record: ErrorRecord;
  count: number;
  storeOccurrence: boolean;
}

/** Where the error log lives. Postgres in the processes; memory in tests. */
export interface ErrorStore {
  write(batch: ErrorWrite[]): Promise<void>;
}

/** What a process holds to report a failure. Never throws and never waits. */
export interface ErrorLogPort {
  capture(event: ErrorEvent): void;
}
