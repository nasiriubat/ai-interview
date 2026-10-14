"use client";

import { DownloadIcon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import * as React from "react";
import { warningText } from "@/components/admin/ExportsPanel";
import { notify } from "@/components/common/notify";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { t } from "@/i18n";
import { saveFromUrl } from "@/lib/exports/download";

export interface ExportFormat {
  id: string;
  /** "CSV", "PDF": what the person picks. */
  label: string;
  /** One line under the label: what the file contains. */
  description?: string;
  /** The staff proxy path of the download, e.g. `/api/staff/audit.csv`. */
  path: string;
  fallbackName: string;
  /** What "Preparing …" and an error call it. */
  what: string;
}

/**
 * The export control of a list (D-346): an icon button with a menu of the formats the API really
 * serves. A download is composed on the server, so it is announced as a loading toast that turns
 * into "ready" (with what the server left out, if anything) or into an error with a retry. When
 * `withFilters` is set the list's current search, sort and filters go with the request, so the file
 * is what the person is looking at; page and page size do not (an export is the whole result).
 */
export function ExportMenu({
  formats,
  withFilters = true,
  label = t.kit.export.label,
  labelled = false,
}: {
  formats: readonly ExportFormat[];
  withFilters?: boolean;
  label?: string;
  /** A button that says "Export" instead of an icon: for a page header, where there is room. */
  labelled?: boolean;
}): React.JSX.Element {
  const params = useSearchParams();
  const [busy, setBusy] = React.useState(false);

  const run = (format: ExportFormat): void => {
    const q = new URLSearchParams(withFilters ? params.toString() : "");
    q.delete("page");
    q.delete("limit");
    const qs = q.toString();
    const url = qs ? `${format.path}?${qs}` : format.path;
    setBusy(true);
    const work = saveFromUrl(url, format.fallbackName);
    notify
      .promise(
        work,
        {
          loading: t.kit.export.preparing(format.what),
          success: (file) => t.admin.exportsPanel.done(file.filename),
        },
        {
          retry: () => {
            run(format);
          },
        },
      )
      .then((file) => {
        for (const code of file.warnings) notify.info(warningText(code));
      })
      .catch(() => undefined)
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <DropdownMenu>
      {labelled ? (
        <DropdownMenuTrigger asChild>
          <Button variant="outline" loading={busy}>
            <DownloadIcon aria-hidden="true" /> {label}
          </Button>
        </DropdownMenuTrigger>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" aria-label={label} loading={busy}>
                <DownloadIcon aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      )}
      <DropdownMenuContent className="w-64">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {formats.map((f) => (
          <DropdownMenuItem
            key={f.id}
            disabled={busy}
            onSelect={() => {
              run(f);
            }}
          >
            <DownloadIcon aria-hidden="true" />
            <span className="grid">
              <span className="text-foreground">{f.label}</span>
              {f.description ? <span className="text-muted-foreground text-xs">{f.description}</span> : null}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
