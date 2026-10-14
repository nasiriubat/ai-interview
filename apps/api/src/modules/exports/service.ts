import { slug, type PdfExporter } from "@aidp/core";
import type { PrismaClient } from "@prisma/client";
import { AppError, notFound } from "../../lib/errors.js";
import type { AnalysisQueryService } from "../analysis/service.js";

export interface ReportPdf {
  filename: string;
  bytes: Buffer;
  pages: number;
  warnings: string[];
  version: number;
}

const LABELS = {
  en: { report: (n: number) => `Report v${n}`, preliminary: "preliminary" },
  fi: { report: (n: number) => `Raportti v${n}`, preliminary: "alustava" },
} as const;

/**
 * The analysis report as a PDF (D-211). It builds on what the report page already shows: the stored
 * Markdown, behind the same visibility rules (a member does not get a preliminary report the tenant
 * has not opened to members), composed by the exporter with the tenant's branding.
 */
export class ExportsService {
  constructor(
    private readonly db: PrismaClient,
    private readonly analyses: AnalysisQueryService,
    private readonly exporter: PdfExporter,
  ) {}

  async reportPdf(companyId: string, role: string, analysisId: string): Promise<ReportPdf> {
    // The same read the report page makes, so what is refused there is refused here.
    const detail = await this.analyses.detail(companyId, role, analysisId);
    if (!detail.report) throw new AppError("conflict", "This analysis has no report yet", { analysisId });
    const meta = await this.db.analysis.findFirst({
      where: { id: analysisId, campaign: { companyId } },
      select: { campaign: { select: { name: true, template: { select: { language: true } } } } },
    });
    if (!meta) throw notFound("Analysis");
    const language = meta.campaign.template.language;
    const labels = language.toLowerCase().startsWith("fi") ? LABELS.fi : LABELS.en;
    const label = detail.analysis.preliminary
      ? `${labels.report(detail.report.version)} (${labels.preliminary})`
      : labels.report(detail.report.version);
    const pdf = await this.exporter.render({
      companyId,
      // The report's own first heading is the title; the campaign name is the fallback.
      title: "",
      markdown: detail.report.markdown || `# ${meta.campaign.name}`,
      language,
      versionLabel: label,
      date: detail.report.createdAt,
    });
    return {
      filename: `${slug(meta.campaign.name)}-report-v${detail.report.version}.pdf`,
      bytes: pdf.bytes,
      pages: pdf.pages,
      warnings: pdf.warnings,
      version: detail.report.version,
    };
  }
}
