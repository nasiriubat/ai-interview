/**
 * The browser's half of the error log (D-477). An uncaught error, an unhandled rejection or an
 * error boundary is posted once per page load to `/api/errors`, which relays it to the API. The
 * API redacts tokens in the path and the text; what is sent here is bounded and never contains
 * a form's contents.
 *
 * Nothing in this module throws: reporting a failure must never be a second one.
 */

export type BrowserErrorKind = "error" | "unhandledrejection" | "boundary";

/** Kept in step with ERROR_MESSAGE_MAX, ERROR_STACK_MAX and ERROR_REPORT_MAX_BYTES in @aidp/shared. */
export const MESSAGE_MAX = 1000;
export const STACK_MAX = 6000;
export const BODY_MAX_BYTES = 8 * 1024 - 256;
/** Reports one page load may send, whatever happens on it. */
export const REPORTS_PER_PAGE = 10;

export interface BrowserReport {
  kind: BrowserErrorKind;
  name?: string;
  message: string;
  stack?: string;
  path: string;
  digest?: string;
}

const EXTENSION = /(chrome|moz|safari|safari-web|ms-browser)-extension:\/\//i;

/**
 * Failures that are not the application's: a browser extension's script, the ResizeObserver
 * notice every layout library triggers, a fetch the page itself aborted or the network dropped,
 * and the opaque "Script error." of a cross-origin script with nothing to go on.
 */
export function isNoise(r: {
  name?: string | undefined;
  message: string;
  stack?: string | undefined;
  source?: string | undefined;
}): boolean {
  const text = `${r.source ?? ""}\n${r.stack ?? ""}`;
  if (EXTENSION.test(text)) return true;
  const m = r.message;
  if (/ResizeObserver loop/i.test(m)) return true;
  if (r.name === "AbortError") return true;
  if (/\babort(ed)?\b/i.test(m) && /fetch|request|signal|operation/i.test(m)) return true;
  if (/^(Load failed|Failed to fetch|NetworkError when attempting to fetch resource\.?)$/i.test(m.trim()))
    return true;
  if (/^Script error\.?$/i.test(m.trim()) && !r.stack) return true;
  return false;
}

const trim = (v: string, max: number): string => (v.length <= max ? v : `${v.slice(0, max - 1)}…`);

/** A thrown value of any shape as a name, a message and a stack. */
export function describe(value: unknown): { name?: string; message: string; stack?: string } {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message || value.name,
      ...(value.stack ? { stack: value.stack } : {}),
    };
  }
  if (typeof value === "string") return { message: value };
  if (value && typeof value === "object" && "message" in value && typeof value.message === "string") {
    return { message: value.message };
  }
  try {
    const json: unknown = JSON.stringify(value);
    return { message: typeof json === "string" ? json : String(value) };
  } catch {
    return { message: String(value) };
  }
}

/** The JSON body, bounded: message and stack trimmed, then the stack shortened until it fits. */
export function reportBody(r: BrowserReport): string {
  const base: BrowserReport = {
    kind: r.kind,
    ...(r.name ? { name: trim(r.name, 200) } : {}),
    message: trim(r.message || "(no message)", MESSAGE_MAX),
    path: trim(r.path, 1000),
    ...(r.digest ? { digest: trim(r.digest, 100) } : {}),
  };
  let stack = r.stack ? trim(r.stack, STACK_MAX) : undefined;
  for (;;) {
    const body = JSON.stringify(stack ? { ...base, stack } : base);
    if (new TextEncoder().encode(body).length <= BODY_MAX_BYTES || !stack) return body;
    stack = stack.length > 200 ? stack.slice(0, Math.floor(stack.length * 0.7)) : undefined;
  }
}

/** Sends a report at most once per distinct error and at most `REPORTS_PER_PAGE` times per page load. */
export class BrowserReporter {
  private readonly seen = new Set<string>();
  private sent = 0;

  constructor(
    private readonly send: (body: string) => void,
    private readonly path: () => string,
  ) {}

  report(value: unknown, kind: BrowserErrorKind, extra: { source?: string; digest?: string } = {}): boolean {
    try {
      const d = describe(value);
      if (isNoise({ ...d, ...(extra.source ? { source: extra.source } : {}) })) return false;
      const firstFrame =
        d.stack
          ?.split("\n")
          .find((l) => /\bat\b|@/.test(l))
          ?.trim() ?? "";
      const key = `${d.name ?? ""}|${d.message}|${firstFrame}`;
      if (this.seen.has(key) || this.sent >= REPORTS_PER_PAGE) return false;
      this.seen.add(key);
      this.sent += 1;
      this.send(
        reportBody({
          kind,
          ...(d.name ? { name: d.name } : {}),
          message: d.message,
          ...(d.stack ? { stack: d.stack } : {}),
          path: this.path(),
          ...(extra.digest ? { digest: extra.digest } : {}),
        }),
      );
      return true;
    } catch {
      return false;
    }
  }
}

function post(body: string): void {
  try {
    void fetch("/api/errors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
      credentials: "same-origin",
    }).catch(() => undefined);
  } catch {
    // nothing to do
  }
}

let shared: BrowserReporter | null = null;

/** The page's one reporter, so the window listeners and the error boundaries share one budget. */
export function browserReporter(): BrowserReporter {
  shared ??= new BrowserReporter(post, () =>
    typeof window === "undefined" ? "" : `${window.location.pathname}${window.location.search}`,
  );
  return shared;
}

/** For an error boundary: reports what it caught, once. */
export function reportBrowserError(error: unknown, kind: BrowserErrorKind = "boundary"): void {
  if (typeof window === "undefined") return;
  const digest =
    error && typeof error === "object" && "digest" in error && typeof error.digest === "string"
      ? error.digest
      : undefined;
  browserReporter().report(error, kind, digest ? { digest } : {});
}
