/**
 * The Content-Security-Policy of the web app (A3, D-165).
 *
 * Built per request so that the script and style nonces are unguessable: a cross-site scripting
 * bug that can inject markup still cannot run script, because it cannot know the nonce of the page
 * it landed in. `strict-dynamic` lets the nonced bootstrap script load the chunks Next splits off.
 *
 * It is sent as `Content-Security-Policy-Report-Only` first (D-165): violations are reported to
 * `/api/csp-report` and logged, nothing is blocked, and the policy is promoted to enforcing once a
 * pilot period shows it quiet. The header name is the only thing that changes then.
 *
 * What stays open and why:
 *  - `style-src-attr 'unsafe-inline'`: Tailwind, Radix and Sonner set style attributes, which a
 *    nonce cannot cover. Style attributes cannot run script.
 *  - `img-src` and `connect-src` name no remote host, which also closes the exfiltration channel a
 *    model-written image or link would otherwise open, whatever the report renderer does.
 *  - `blob:` for media, workers and images: the live-voice recorder and AudioWorklet use it.
 */
export const CSP_ENFORCING_HEADER = "Content-Security-Policy";
export const CSP_REPORT_ONLY_HEADER = "Content-Security-Policy-Report-Only";
export const CSP_REPORT_PATH = "/api/csp-report";

/**
 * Whether the policy blocks or only reports (D-264). `CSP_MODE=enforce|report`.
 *
 * Unset means `enforce` in production and `report` anywhere else, so a production deployment
 * that forgot the variable is protected and a developer's dev server never breaks on a policy
 * written for the built app. `deploy/compose.prod.yml` sets it explicitly, so the mode of a
 * production stack is a line a reviewer can read. Anything that is not exactly `enforce` or
 * `report` is a misconfiguration and falls back to the safe answer for the environment.
 */
export type CspMode = "enforce" | "report";

export function cspMode(env: { CSP_MODE?: string | undefined; NODE_ENV?: string | undefined }): CspMode {
  const v = env.CSP_MODE?.trim().toLowerCase();
  if (v === "enforce" || v === "report") return v;
  return env.NODE_ENV === "production" ? "enforce" : "report";
}

export function cspHeaderName(mode: CspMode): string {
  return mode === "enforce" ? CSP_ENFORCING_HEADER : CSP_REPORT_ONLY_HEADER;
}

/** A fresh nonce: 128 bits, base64. Never reused across requests. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export interface CspOptions {
  nonce: string;
  /** The public host (`example.com` or `example.com:8443`), for the secure WebSocket of live voice. */
  host: string;
  /** Next's dev server needs `eval` for refresh; production never gets it. */
  dev?: boolean;
  /** Add `upgrade-insecure-requests`: only meaningful when the policy is enforced. */
  enforce?: boolean;
}

export function buildCsp({ nonce, host, dev = false, enforce = false }: CspOptions): string {
  const scriptSrc = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...(dev ? ["'unsafe-eval'"] : [])];
  const connect = ["'self'", `wss://${host}`, ...(dev ? ["ws://localhost:*", "http://localhost:*"] : [])];
  const directives: string[] = [
    "default-src 'self'",
    `script-src ${scriptSrc.join(" ")}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "media-src 'self' blob:",
    `connect-src ${connect.join(" ")}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  directives.push(`report-uri ${CSP_REPORT_PATH}`);
  if (enforce) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

/** What a security header set looks like for a page, so the proxy and its test agree. */
export const PERMISSIONS_POLICY = "camera=(), geolocation=(), microphone=(self)";
