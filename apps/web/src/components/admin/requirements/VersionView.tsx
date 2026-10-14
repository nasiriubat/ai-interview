"use client";

import { AlertTriangleIcon, GitBranchIcon, Loader2Icon } from "lucide-react";
import * as React from "react";
import { GitHubPushDialog } from "./GitHubPushDialog";
import { VersionDiff } from "./VersionDiff";
import { StatTile } from "@/components/admin/StatTile";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { DateText } from "@/components/common/DateText";
import { ExportMenu } from "@/components/data/ExportMenu";
import { ReportMarkdown } from "@/components/report/ReportMarkdown";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useSpecVersionDetail } from "@/hooks/useSpecVersions";
import { t } from "@/i18n";
import type { SpecVersionDetail, SpecVersionSummary } from "@/lib/api/schemas";
import { specExportUrl } from "@/lib/api/staff";

const BUNDLE_FORMATS = ["claude_code", "codex", "generic"] as const;
type KnownBundleFormat = (typeof BUNDLE_FORMATS)[number];
const isKnownFormat = (f: string): f is KnownBundleFormat =>
  (BUNDLE_FORMATS as readonly string[]).includes(f);

/** One generated spec version: downloads, GitHub push, compare, the document and the bundle files. */
export function VersionView({
  sessionId,
  initial,
  others,
}: {
  sessionId: string;
  initial: SpecVersionDetail;
  others: SpecVersionSummary[];
}): React.JSX.Element {
  const s = t.admin.requirements.version;
  const detail = useSpecVersionDetail(sessionId, initial.version.version, initial);
  const v = detail.version;
  const [github, setGithub] = React.useState(false);
  const pending = v.status === "queued" || v.status === "running";
  const bundleSpec = detail.bundle?.files.find((f) => f.path === "spec.md")?.content;
  const markdown = detail.markdown.trim() ? detail.markdown : (bundleSpec ?? "");

  return (
    <div className="grid grid-cols-1 gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <StatusBadge status={v.status} />
          <span className="text-muted-foreground text-sm">
            {s.created}: <DateText iso={v.createdAt} />
          </span>
          {v.finishedAt ? (
            <span className="text-muted-foreground text-sm">
              {s.finished}: <DateText iso={v.finishedAt} />
            </span>
          ) : null}
        </div>
        {v.status === "done" ? (
          <div className="flex flex-wrap items-center gap-2">
            <ExportMenu
              labelled
              withFilters={false}
              label={s.downloads}
              formats={[
                {
                  id: "pdf",
                  label: t.admin.exportsPanel.pdf,
                  what: "PDF",
                  path: specExportUrl(sessionId, v.version, "pdf"),
                  fallbackName: `specification-v${String(v.version)}.pdf`,
                },
                {
                  id: "md",
                  label: s.downloadMd,
                  what: "spec.md",
                  path: specExportUrl(sessionId, v.version, "md"),
                  fallbackName: `specification-v${String(v.version)}.md`,
                },
                {
                  id: "json",
                  label: s.downloadJson,
                  what: "spec.json",
                  path: specExportUrl(sessionId, v.version, "json"),
                  fallbackName: `specification-v${String(v.version)}.json`,
                },
                {
                  id: "bundle",
                  label: s.downloadBundle,
                  what: s.bundle,
                  path: specExportUrl(sessionId, v.version, "bundle"),
                  fallbackName: `specification-v${String(v.version)}-bundle.zip`,
                },
              ]}
            />
            <Button
              onClick={() => {
                setGithub(true);
              }}
            >
              <GitBranchIcon /> {s.github.open}
            </Button>
            <GitHubPushDialog
              sessionId={sessionId}
              version={v.version}
              open={github}
              onOpenChange={setGithub}
            />
          </div>
        ) : null}
      </div>

      {v.status === "failed" ? (
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertTitle>{t.app.errorTitle}</AlertTitle>
          <AlertDescription>{s.failed(v.error ?? t.app.unknownError)}</AlertDescription>
        </Alert>
      ) : v.error ? (
        <Alert variant="warning" role="status">
          <AlertTriangleIcon />
          <AlertDescription>{s.fallbackNote(v.error)}</AlertDescription>
        </Alert>
      ) : null}
      {pending ? (
        <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
          <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          {s.generating}
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label={s.stats.sections} value={v.stats.sections} />
        <StatTile label={s.stats.requirements} value={v.stats.requirements} />
        <StatTile label={s.stats.mvp} value={v.stats.mvp} />
        <StatTile label={s.stats.future} value={v.stats.future} />
        <StatTile label={s.stats.phases} value={v.stats.phases} />
        <StatTile label={s.stats.openFindings} value={v.stats.openFindings} />
      </div>

      {v.status === "done" ? <VersionDiff sessionId={sessionId} current={v} others={others} /> : null}

      <section aria-label={s.document} className="grid min-w-0 grid-cols-1 gap-3">
        <h2 className="text-base font-semibold">{s.document}</h2>
        {markdown ? (
          <div className="bg-card shadow-card rounded-lg p-4 md:p-6">
            <ReportMarkdown markdown={markdown} />
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">{s.noDocument}</p>
        )}
      </section>

      {detail.bundle ? (
        <section aria-label={s.bundle} className="grid gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">{s.bundle}</h2>
            <span className="text-muted-foreground text-xs">
              {s.bundleFormat(
                isKnownFormat(detail.bundle.format)
                  ? s.bundleFormats[detail.bundle.format]
                  : detail.bundle.format,
              )}{" "}
              · {s.files(detail.bundle.files.length)}
            </span>
          </div>
          <ul className="grid gap-2">
            {detail.bundle.files.map((file) => (
              <li key={file.path}>
                <details className="rounded-lg border">
                  <summary className="cursor-pointer px-3 py-2 font-mono text-xs font-medium">
                    {file.path}
                  </summary>
                  <pre
                    aria-label={s.fileContent(file.path)}
                    className="max-h-96 overflow-auto border-t px-3 py-2 text-xs whitespace-pre-wrap"
                  >
                    {file.content}
                  </pre>
                </details>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
