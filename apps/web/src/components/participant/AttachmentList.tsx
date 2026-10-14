"use client";

import { FileTextIcon, ImageIcon, Loader2Icon, TriangleAlertIcon, XIcon } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import type { Attachment } from "@/lib/api/schemas";
import { formatBytes } from "@/lib/attachments";
import { cn } from "@/lib/utils";

function statusLine(a: Attachment): string {
  const s = t.participant.session;
  if (a.status === "pending") return s.attachmentPending;
  if (a.status === "failed") return a.error ?? s.attachmentFailed;
  return s.attachmentReady;
}

/**
 * The files attached to this session, as one line above the composer: chips that scroll sideways,
 * never a column that grows (recordings are not here at all: a spoken answer lives in its own
 * bubble). Every chip says what the file is doing — being read, ready, or refused and why —
 * because a file the interviewer cannot use yet is worth knowing about before the next answer.
 *
 * What is in flight (an upload, an error) takes the same one line.
 */
export function AttachmentList({
  items,
  uploading,
  progress = null,
  onCancel,
  error,
  onRemove,
}: {
  items: Attachment[];
  uploading: boolean;
  progress?: number | null;
  onCancel?: (() => void) | undefined;
  error: string | null;
  onRemove: (attachmentId: string) => void;
  /** Kept so callers need not change; files have no player. */
  fetchBytes?: (attachmentId: string) => Promise<Blob>;
}): React.JSX.Element | null {
  const s = t.participant.session;
  const files = items.filter((a) => a.kind !== "audio");
  if (files.length === 0 && !uploading && error === null) return null;

  return (
    <div className="mb-1.5 grid gap-1" data-attachments="">
      {error !== null ? (
        <p className="text-destructive flex items-center gap-1.5 text-xs" role="alert">
          <TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="line-clamp-1">{error}</span>
        </p>
      ) : null}
      {files.length > 0 || uploading ? (
        <ul
          aria-label={s.attachmentsLabel}
          className="flex max-h-12 items-center gap-1.5 overflow-x-auto overflow-y-hidden [scrollbar-width:thin]"
        >
          {files.map((a) => {
            const Icon = a.kind === "image" ? ImageIcon : FileTextIcon;
            return (
              <li
                key={a.id}
                className="bg-muted flex h-10 max-w-64 min-w-0 shrink-0 items-center gap-1.5 rounded-full pr-0.5 pl-3"
              >
                <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 truncate text-sm">{a.filename}</span>
                <span
                  className={cn(
                    "text-muted-foreground hidden shrink-0 text-xs sm:inline",
                    a.status === "failed" && "text-destructive",
                  )}
                >
                  {formatBytes(a.sizeBytes)} · {statusLine(a)}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-9 shrink-0 rounded-full"
                  aria-label={s.attachmentRemove(a.filename)}
                  onClick={() => {
                    onRemove(a.id);
                  }}
                >
                  <XIcon className="size-4" />
                </Button>
              </li>
            );
          })}
          {uploading ? (
            <li className="bg-muted flex h-10 shrink-0 items-center gap-2 rounded-full pr-0.5 pl-3">
              <Loader2Icon className="size-4 shrink-0 motion-safe:animate-spin" aria-hidden="true" />
              <span role="status" className="text-sm">
                {s.attachUploading}
                {progress !== null && progress > 0 ? ` ${String(progress)} %` : ""}
              </span>
              {onCancel ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-9 shrink-0 rounded-full"
                  aria-label={s.attachCancel}
                  onClick={onCancel}
                >
                  <XIcon className="size-4" />
                </Button>
              ) : null}
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
