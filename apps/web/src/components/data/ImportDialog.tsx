"use client";

import { DownloadIcon, UploadIcon } from "lucide-react";
import * as React from "react";
import { IconButton } from "@/components/admin/IconButton";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FileUpload } from "@/components/upload/FileUpload";
import { t } from "@/i18n";
import { issuesCsv, previewEmailList, type ImportIssue, type ImportPreview } from "@/lib/admin/importPreview";
import { saveText } from "@/lib/exports/download";

/**
 * Import of a list from a file (D-346), in three steps that send nothing until the last: choose a
 * file (read in the browser, never uploaded), see what was understood (how many rows are ready,
 * which lines are not and why, with the error report as a download), then confirm. The dialog is
 * generic over what a row is only through `parse`; today the one importer is an email list for
 * invitations, because that is the one import the API takes.
 */
export function ImportDialog({
  title,
  description,
  accept,
  maxSizeMb = 2,
  parse = previewEmailList,
  onImport,
  trigger,
}: {
  title: string;
  description: string;
  accept: readonly string[];
  maxSizeMb?: number;
  parse?: (text: string) => ImportPreview;
  onImport: (rows: string[]) => void;
  /** The accessible label of the icon button that opens the dialog. */
  trigger: string;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [preview, setPreview] = React.useState<ImportPreview | null>(null);
  const k = t.kit.importer;
  React.useEffect(() => {
    if (!open) setPreview(null);
  }, [open]);

  const reason = (i: ImportIssue): string => (i.reason === "duplicate" ? k.duplicate : k.invalid);

  return (
    <>
      <IconButton
        label={trigger}
        variant="outline"
        size="icon"
        icon={<UploadIcon />}
        onClick={() => {
          setOpen(true);
        }}
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent closeLabel={t.app.close} className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {preview === null ? (
            <FileUpload<ImportPreview>
              compact
              accept={accept}
              maxSizeMb={maxSizeMb}
              label={k.choose}
              upload={async (file) => parse(await file.text())}
              onUploaded={setPreview}
            />
          ) : (
            <div className="grid gap-3">
              <p role="status" className="text-sm font-medium">
                {k.valid(preview.valid.length)}
                {preview.issues.length > 0 ? ` · ${k.skipped(preview.issues.length)}` : ""}
              </p>
              {preview.valid.length === 0 ? (
                <p className="text-muted-foreground text-sm">{k.none}</p>
              ) : (
                <ul
                  aria-label={k.preview}
                  className="bg-muted/50 max-h-40 overflow-auto rounded-md p-2 font-mono text-xs"
                >
                  {preview.valid.slice(0, 50).map((v) => (
                    <li key={v}>{v}</li>
                  ))}
                  {preview.valid.length > 50 ? <li>…</li> : null}
                </ul>
              )}
              {preview.issues.length > 0 ? (
                <div className="grid gap-1.5">
                  <div className="flex items-center justify-between">
                    <p className="text-destructive text-sm font-medium">{k.errors}</p>
                    <IconButton
                      label={k.downloadReport}
                      icon={<DownloadIcon />}
                      onClick={() => {
                        saveText(issuesCsv(preview.issues), "import-errors.csv", "text/csv");
                      }}
                    />
                  </div>
                  <ul className="bg-destructive-soft text-destructive-soft-foreground max-h-32 overflow-auto rounded-md p-2 text-xs">
                    {preview.issues.slice(0, 100).map((i, n) => (
                      <li key={`${String(i.line)}-${String(n)}`}>
                        <span className="text-muted-foreground">{k.line(i.line)}:</span>{" "}
                        <span className="font-mono">{i.value}</span> · {reason(i)}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          )}
          <DialogFooter>
            {preview !== null ? (
              <Button
                variant="outline"
                onClick={() => {
                  setPreview(null);
                }}
              >
                {k.choose}
              </Button>
            ) : null}
            <Button
              disabled={preview === null || preview.valid.length === 0}
              onClick={() => {
                if (preview) onImport(preview.valid);
                setOpen(false);
              }}
            >
              {k.confirm(preview?.valid.length ?? 0)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
