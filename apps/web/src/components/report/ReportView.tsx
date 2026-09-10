"use client";

import { REPORT_SECTIONS, type ReportSection } from "@aidp/shared";
import { CheckIcon, DownloadIcon, Loader2Icon, PrinterIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { ReportMarkdown } from "./ReportMarkdown";
import { EmptyState } from "@/components/admin/EmptyState";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useDebouncedSave } from "@/hooks/useDebouncedSave";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import type { Analysis, Report } from "@/lib/api/schemas";
import { splitReportSections, visibleMarkdown } from "@/lib/report/sections";
import { formatDate } from "@/lib/utils";

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
    setEnabled((prev) => {
      const next = REPORT_SECTIONS.filter((k) => (k === key ? on : prev.includes(k)));
      return next;
    });
  };

  const download = (): void => {
    if (!report) return;
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const slug =
      campaignName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "report";
    a.href = url;
    a.download = `${slug}-report-v${report.version}.md`;
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const versions = analyses.filter((a) => a.status === "done");
  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4 print:hidden">
        <div className="flex flex-wrap items-end gap-3">
          {versions.length > 0 ? (
            <div className="grid gap-1.5">
              <Label htmlFor="report-version">{t.admin.results.version}</Label>
              <select
                id="report-version"
                value={selected?.id ?? ""}
                onChange={(e) => {
                  const params = new URLSearchParams({ version: e.target.value });
                  router.push(`/admin/campaigns/${campaignId}/report?${params.toString()}`);
                }}
                className="border-input bg-background focus-visible:ring-ring/50 h-9 rounded-md border px-2 text-sm outline-none focus-visible:ring-[3px]"
              >
                {versions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {s.generated(a.version, formatDate(a.finishedAt ?? a.createdAt))}
                    {a.preliminary ? ` · ${t.admin.results.preliminary}` : ""}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={download} disabled={!report}>
            <DownloadIcon /> {s.download}
          </Button>
          <Button
            variant="outline"
            disabled={!report}
            onClick={() => {
              window.print();
            }}
          >
            <PrinterIcon /> {s.print}
          </Button>
        </div>
      </div>

      <fieldset className="grid gap-2 rounded-lg border p-4 print:hidden">
        <legend className="px-1 text-sm font-medium">{s.sections}</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {REPORT_SECTIONS.map((key) => {
            const id = `section-${key}`;
            const present = !report || report.sections.length === 0 || report.sections.includes(key);
            return (
              <div key={key} className="flex items-center gap-2">
                <Checkbox
                  id={id}
                  checked={enabled.includes(key)}
                  disabled={!present}
                  onCheckedChange={(v) => {
                    toggle(key, v === true);
                  }}
                />
                <Label htmlFor={id} className={present ? "" : "text-muted-foreground"}>
                  {s.sectionNames[key]}
                </Label>
              </div>
            );
          })}
        </div>
        <p
          className="text-muted-foreground flex items-center gap-1.5 text-xs"
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
      </fieldset>

      {selected && !selected.stats.thresholdMet ? (
        <Alert variant="warning">
          <AlertDescription>{s.preliminaryNote}</AlertDescription>
        </Alert>
      ) : null}

      {report ? (
        <article className="report-sheet bg-card rounded-xl border p-6 md:p-10 print:rounded-none print:border-0 print:p-0">
          <p className="text-muted-foreground mb-6 text-xs">
            {campaignName} ·{" "}
            {s.generated(report.version, formatDate(report.createdAt ?? selected?.finishedAt))}
          </p>
          <ReportMarkdown markdown={markdown} />
        </article>
      ) : (
        <EmptyState text={s.noReport} />
      )}
    </div>
  );
}
