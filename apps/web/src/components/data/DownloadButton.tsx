"use client";

import { DownloadIcon } from "lucide-react";
import * as React from "react";
import { warningText } from "@/components/admin/ExportsPanel";
import { notify } from "@/components/common/notify";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { t } from "@/i18n";
import { saveFromUrl } from "@/lib/exports/download";

/**
 * An icon-only download of one file from the staff proxy (D-376): a table row's "download CSV" or
 * "download archive". It reports like `ExportMenu` does: a loading toast that turns into "ready"
 * (with what the server left out) or into an error with Retry. `label` names the file and, for a
 * row, whose it is ("CSV: September 2026").
 */
export function DownloadButton({
  label,
  path,
  fallbackName,
  what,
  variant = "ghost",
  text,
}: {
  label: string;
  path: string;
  fallbackName: string;
  /** What "Preparing …" and an error call it: "CSV", "archive". */
  what: string;
  variant?: "ghost" | "outline";
  /** A visible label: the button is then a labelled button, not an icon in a row. */
  text?: string;
}): React.JSX.Element {
  const [busy, setBusy] = React.useState(false);
  const run = (): void => {
    setBusy(true);
    notify
      .promise(
        saveFromUrl(path, fallbackName),
        {
          loading: t.kit.export.preparing(what),
          success: (file) => t.admin.exportsPanel.done(file.filename),
        },
        { retry: run },
      )
      .then((file) => {
        for (const code of file.warnings) notify.info(warningText(code));
      })
      .catch(() => undefined)
      .finally(() => {
        setBusy(false);
      });
  };
  if (text) {
    return (
      <Button type="button" variant={variant} loading={busy} onClick={run}>
        <DownloadIcon aria-hidden="true" /> {text}
      </Button>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon-sm"
          variant={variant}
          aria-label={label}
          loading={busy}
          onClick={run}
        >
          <DownloadIcon aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
