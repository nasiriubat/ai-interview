"use client";

import { REPORT_SECTIONS, type ReportSection } from "@aidp/shared";
import {
  CheckIcon,
  ChevronDownIcon,
  DownloadIcon,
  FileTextIcon,
  Loader2Icon,
  PrinterIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { ReportMarkdown } from "./ReportMarkdown";
import { EmptyState } from "@/components/admin/EmptyState";
import { Panel } from "@/components/admin/Panel";
import { notify } from "@/components/common/notify";
import { startNavigationProgress } from "@/components/common/NavigationProgress";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Combobox } from "@/components/ui/combobox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { useDebouncedSave } from "@/hooks/useDebouncedSave";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import type { Analysis, Report } from "@/lib/api/schemas";
import { analysisReportPdfUrl } from "@/lib/api/staff";
import { saveFromUrl, saveText } from "@/lib/exports/download";
import { splitReportSections, visibleMarkdown } from "@/lib/report/sections";
import { formatDate } from "@/lib/utils";

function slugOf(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "report"
  );
}

/**
 * The report workspace (D-373): options on the left, the paper on the right. The paper is the same
 * width and type as the printed page, so what is on screen is what Print and the PDF produce, minus
 * the page breaks. Hidden sections are left out of both the preview and the downloads.
 */
export function ReportView({
  campaignId,
  campaignName,
  analyses,
  selected,
  report,
  initialSections,
}: {
  campaignId: string;
  campaignName: string;
  analyses: Analysis[];
  selected: Analysis | undefined;
  report: Report | null;
  initialSections: ReportSection[];
}): React.JSX.Element {
  const s = t.admin.report;
  const router = useRouter();
  const [enabled, setEnabled] = React.useState<ReportSection[]>(initialSections);
  const [busy, setBusy] = React.useState(false);
  const enabledSet = React.useMemo(() => new Set<string>(enabled), [enabled]);
  const chunks = React.useMemo(
    () => (report ? splitReportSections(report.markdown, report.sections) : []),
    [report],
  );
  const markdown = React.useMemo(() => visibleMarkdown(chunks, enabledSet), [chunks, enabledSet]);

  const saveState = useDebouncedSave(enabled, async (sections) => {
    await staffClient.settings.put(
      { scope: "campaign", scopeId: campaignId },
      { "analysis.reportSections": sections },
    );
  });

  const toggle = (key: ReportSection, on: boolean): void => {
    setEnabled((prev) => REPORT_SECTIONS.filter((k) => (k === key ? on : prev.includes(k))));
  };

  const downloadMarkdown = (): void => {
    if (!report) return;
    const file = saveText(
      markdown,
      `${slugOf(campaignName)}-report-v${String(report.version)}.md`,
      "text/markdown",
    );
    notify.success(t.admin.exportsPanel.done(file.filename));
  };

  const downloadPdf = (): void => {
    if (!selected || !report) return;
    setBusy(true);
    notify
      .promise(
        saveFromUrl(analysisReportPdfUrl(selected.id), `report-v${String(report.version)}.pdf`),
        {
          loading: t.kit.export.preparing("PDF"),
          success: (file) => t.admin.exportsPanel.done(file.filename),
        },
        { retry: downloadPdf },
      )
      .catch(() => undefined)
      .finally(() => {
        setBusy(false);
      });
  };

  const versions = analyses.filter((a) => a.status === "done");
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 xl:grid-cols-[19rem_minmax(0,1fr)] print:block">
      <aside aria-label={s.optionsLabel} className="grid gap-4 xl:sticky xl:top-20 print:hidden">
        <Panel title={s.optionsTitle} headingLevel={2}>
          <div className="grid gap-4 px-5 py-4">
            {versions.length > 0 ? (
              <div className="grid gap-1.5">
                <Label htmlFor="report-version">{t.admin.results.version}</Label>
                <Combobox
                  id="report-version"
                  value={selected?.id ?? ""}
                  onChange={(id) => {
                    const params = new URLSearchParams({ version: id });
                    startNavigationProgress();
                    router.push(`/admin/campaigns/${campaignId}/report?${params.toString()}`);
                  }}
                  options={versions.map((a) => ({
                    value: a.id,
                    label: `${s.generated(a.version, formatDate(a.finishedAt ?? a.createdAt))}${
                      a.preliminary ? ` · ${t.admin.results.preliminary}` : ""
                    }`,
                  }))}
                  labels={{
                    placeholder: t.admin.results.version,
                    search: t.admin.list.searchPlaceholder,
                    empty: t.admin.list.noMatches,
                  }}
                />
              </div>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button disabled={!report} loading={busy}>
                  <DownloadIcon /> {t.kit.export.label}
                  <ChevronDownIcon className="ml-auto" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64">
                <DropdownMenuLabel>{t.kit.export.label}</DropdownMenuLabel>
                <DropdownMenuItem disabled={busy} onSelect={downloadPdf}>
                  <FileTextIcon aria-hidden="true" />
                  <span className="grid">
                    <span>PDF</span>
                    <span className="text-muted-foreground text-xs">{s.pdfHint}</span>
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={downloadMarkdown}>
                  <DownloadIcon aria-hidden="true" />
                  <span className="grid">
                    <span>Markdown</span>
                    <span className="text-muted-foreground text-xs">{s.markdownHint}</span>
                  </span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => {
                    window.print();
                  }}
                >
                  <PrinterIcon aria-hidden="true" />
                  {s.print}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </Panel>

        <Panel title={s.sections} headingLevel={2}>
          <fieldset className="grid gap-1 px-3 py-3">
            <legend className="sr-only">{s.sections}</legend>
            {REPORT_SECTIONS.map((key) => {
              const id = `section-${key}`;
              const present = !report || report.sections.length === 0 || report.sections.includes(key);
              return (
                <div
                  key={key}
                  className="hover:bg-muted/60 flex items-center gap-3 rounded-md px-2 py-1.5 transition-colors"
                >
                  <Checkbox
                    id={id}
                    checked={enabled.includes(key)}
                    disabled={!present}
                    onCheckedChange={(v) => {
                      toggle(key, v === true);
                    }}
                  />
                  <Label
                    htmlFor={id}
                    className={present ? "flex-1 cursor-pointer" : "text-muted-foreground flex-1"}
                  >
                    {s.sectionNames[key]}
                  </Label>
                </div>
              );
            })}
          </fieldset>
          <p
            className="text-muted-foreground flex min-h-9 items-center gap-1.5 border-t px-5 py-2 text-xs"
            role="status"
            aria-live="polite"
          >
            {saveState.kind === "saving" ? (
              <>
                <Loader2Icon className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                {t.app.saving}
              </>
            ) : saveState.kind === "saved" ? (
              <>
                <CheckIcon className="size-3" aria-hidden="true" /> {s.sectionsSaved}
              </>
            ) : saveState.kind === "error" ? (
              <span className="text-destructive">{saveState.text}</span>
            ) : (
              s.sectionsHint
            )}
          </p>
        </Panel>

        {selected && !selected.stats.thresholdMet ? (
          <Alert variant="warning" role="status">
            <AlertDescription>{s.preliminaryNote}</AlertDescription>
          </Alert>
        ) : null}
      </aside>

      {report ? (
        <div className="bg-muted/60 min-w-0 rounded-xl p-3 sm:p-6 print:bg-transparent print:p-0">
          <p className="text-muted-foreground mb-3 text-center text-xs print:hidden">{s.paperHint}</p>
          <article
            aria-label={s.title}
            className="report-sheet bg-card shadow-raised mx-auto w-full max-w-[52rem] rounded-md px-5 py-8 sm:px-10 sm:py-12 md:px-14 print:max-w-none print:rounded-none print:p-0 print:shadow-none"
          >
            <p className="text-muted-foreground mb-8 border-b pb-3 text-xs">
              {campaignName} ·{" "}
              {s.generated(report.version, formatDate(report.createdAt ?? selected?.finishedAt))}
            </p>
            <ReportMarkdown markdown={markdown} />
          </article>
        </div>
      ) : (
        <EmptyState text={s.noReport} />
      )}
    </div>
  );
}
