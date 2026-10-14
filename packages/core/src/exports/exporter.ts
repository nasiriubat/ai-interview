import { checkMermaidSource, type DiagramIssue } from "@aidp/ai";
import type { SettingsService } from "../settings/service.js";
import { KrokiSyntaxError, KrokiUnavailableError, withExportTheme, type KrokiPort } from "./kroki.js";
import { renderPdf, type PdfBrand, type PdfLimits, type PdfResult } from "./pdf.js";

/*
 * What the API and the worker call to turn text into a PDF or to check a diagram: the settings
 * lookup, the renderer port and the concurrency rule in one place, so a route stays transport.
 *
 * Generation is synchronous in the request that asks for it (D-211), which is only acceptable
 * because everything that could make it slow or large is capped and because at most one document is
 * composed at a time: a second request waits behind the first, and a third finds the queue full and
 * is told to retry rather than piling memory onto a 4 GB host.
 */

export class ExportBusyError extends Error {
  constructor() {
    super("Another document is being prepared. Try again in a moment.");
    this.name = "ExportBusyError";
  }
}

export interface PdfRequest {
  companyId: string;
  title: string;
  markdown: string;
  /** The document's own language (`en` or `fi`; anything else prints English labels). */
  language: string;
  /** Short label for the cover and footer, such as `Version 3`. */
  versionLabel: string;
  date: Date;
}

export interface ExporterDeps {
  settings: Pick<SettingsService, "resolveMany">;
  /** Null when `KROKI_URL` is not set: diagrams are then printed as source. */
  kroki: KrokiPort | null;
  log?: { warn(message: string, meta?: Record<string, unknown>): void };
  /** Documents in flight (the one being composed plus those waiting) before a request is turned away. Default 3. */
  maxInFlight?: number;
  limits?: Partial<PdfLimits>;
}

export type DiagramCheckResult =
  | {
      ok: true;
      /** False when the renderer could not be asked, so only the static checks ran. */ verified: boolean;
    }
  | { ok: false; issues: Pick<DiagramIssue, "message" | "line">[] };

export class PdfExporter {
  private tail: Promise<unknown> = Promise.resolve();
  private waiting = 0;

  constructor(private readonly deps: ExporterDeps) {}

  async brandFor(companyId: string): Promise<PdfBrand> {
    const v = await this.deps.settings.resolveMany(
      [
        "branding.productName",
        "branding.primaryColor",
        "exports.pdfPageSize",
        "exports.pdfCoverPage",
        "exports.pdfFooterText",
      ],
      [{ scope: "tenant", scopeId: companyId }],
    );
    return {
      productName: String(v["branding.productName"]),
      color: String(v["branding.primaryColor"]),
      pageSize: v["exports.pdfPageSize"] === "Letter" ? "Letter" : "A4",
      cover: v["exports.pdfCoverPage"] !== false,
      footerText: typeof v["exports.pdfFooterText"] === "string" ? v["exports.pdfFooterText"] : "",
    };
  }

  async render(req: PdfRequest): Promise<PdfResult> {
    const brand = await this.brandFor(req.companyId);
    return this.exclusive(() =>
      renderPdf({
        title: req.title,
        markdown: req.markdown,
        language: req.language,
        versionLabel: req.versionLabel,
        date: req.date,
        brand,
        kroki: this.deps.kroki,
        ...(this.deps.limits ? { limits: this.deps.limits } : {}),
      }),
    );
  }

  /**
   * Static checks, then the renderer's own parser. A diagram the parser refuses is not saved. A
   * renderer that cannot be reached is not the owner's fault and not a reason to lose their work:
   * the result says the source was not verified, and the caller stores that fact with it.
   */
  async checkDiagram(source: string): Promise<DiagramCheckResult & { source?: string }> {
    const checked = checkMermaidSource(source);
    if (!checked.ok) return { ok: false, issues: checked.issues };
    if (!this.deps.kroki) return { ok: true, verified: false, source: checked.source };
    try {
      await this.deps.kroki.render(withExportTheme(checked.source), "svg");
      return { ok: true, verified: true, source: checked.source };
    } catch (e) {
      if (e instanceof KrokiSyntaxError) return { ok: false, issues: [{ message: e.message }] };
      if (!(e instanceof KrokiUnavailableError))
        this.deps.log?.warn("diagram check failed unexpectedly", { error: String(e) });
      return { ok: true, verified: false, source: checked.source };
    }
  }

  /** One at a time, with a short queue. Errors do not poison the chain. */
  private async exclusive<T>(job: () => Promise<T>): Promise<T> {
    if (this.waiting >= (this.deps.maxInFlight ?? 3)) throw new ExportBusyError();
    this.waiting++;
    const run = this.tail.then(job, job);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await run;
    } finally {
      this.waiting--;
    }
  }
}
