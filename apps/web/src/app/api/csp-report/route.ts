import { type NextRequest } from "next/server";

/**
 * Receives Content-Security-Policy violation reports (A3, D-165). The policy is report-only while
 * the pilot shows what it would have blocked; this is where that is seen. A report is untrusted
 * input from any browser: it is size-bounded, rate-limited per address, reduced to a few short
 * fields and written as one log line. Nothing is stored and nothing is echoed back.
 */
const MAX_BYTES = 8 * 1024;
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 30;
const seen = new Map<string, { count: number; resetAt: number }>();

function allowed(key: string, now: number): boolean {
  const entry = seen.get(key);
  if (!entry || entry.resetAt <= now) {
    // Bounded: a flood of distinct addresses must not grow this without limit.
    if (seen.size > 5_000) seen.clear();
    seen.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= MAX_PER_WINDOW;
}

const short = (v: unknown): string | undefined => (typeof v === "string" ? v.slice(0, 300) : undefined);

export async function POST(req: NextRequest): Promise<Response> {
  const address = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (!allowed(address, Date.now())) return new Response(null, { status: 429 });

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BYTES) return new Response(null, { status: 413 });
  const text = await req.text();
  if (text.length > MAX_BYTES) return new Response(null, { status: 413 });

  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    // The legacy report-uri format wraps one report; the Reporting API sends an array of them.
    const reports = Array.isArray(body) ? body : [body];
    for (const r of reports.slice(0, 5)) {
      const report =
        (r as { "csp-report"?: Record<string, unknown>; body?: Record<string, unknown> })["csp-report"] ??
        (r as { body?: Record<string, unknown> }).body;
      if (!report) continue;
      console.warn(
        JSON.stringify({
          event: "csp.violation",
          directive: short(report["violated-directive"] ?? report.effectiveDirective),
          blocked: short(report["blocked-uri"] ?? report.blockedURL),
          document: short(report["document-uri"] ?? report.documentURL),
          source: short(report["source-file"] ?? report.sourceFile),
          line: typeof report["line-number"] === "number" ? report["line-number"] : undefined,
          disposition: short(report.disposition),
        }),
      );
    }
  } catch {
    // Not JSON: nothing to log, and no reason to tell the sender why.
  }
  return new Response(null, { status: 204 });
}
