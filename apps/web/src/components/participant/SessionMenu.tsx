"use client";

import {
  CheckCircle2Icon,
  DownloadIcon,
  FastForwardIcon,
  MoreHorizontalIcon,
  Trash2Icon,
} from "lucide-react";
import * as React from "react";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { LanguageMenu } from "@/components/common/PreferenceMenus";
import { ThemeToggle } from "@/components/common/ThemeToggle";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { t } from "@/i18n";

type Download = "idle" | "busy" | "done" | "failed";

/**
 * Fetches the participant's own data through the web proxy and hands it to the browser as a
 * file. The proxy attaches the session cookie, so nothing here names a session (D-162).
 */
async function saveMyData(format: "json" | "md"): Promise<void> {
  const res = await fetch(`/api/participant/p/session/export?format=${format}`, {
    credentials: "same-origin",
  });
  if (!res.ok) throw new Error(`export ${res.status}`);
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = format === "md" ? "my-interview-data.md" : "my-interview-data.json";
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** "Wrap up sooner", "I'm done", "Download my data" and "Delete my data": always one tap away. */
export function SessionMenu({
  onDone,
  onWrapUp,
  onDelete,
  disabled,
  deleteOpen,
  onDeleteOpenChange,
}: {
  onDone: () => void;
  /** "Wrap up sooner" (D-484); absent once asked. The header shows it from 768 px, this menu always. */
  onWrapUp?: (() => void) | undefined;
  onDelete: () => void;
  disabled?: boolean;
  /** The side panel can ask for the same confirmation: the screen then owns whether it is open. */
  deleteOpen?: boolean;
  onDeleteOpenChange?: (open: boolean) => void;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [ownDelete, setOwnDelete] = React.useState(false);
  const confirmDelete = deleteOpen ?? ownDelete;
  const setConfirmDelete = (v: boolean): void => {
    setOwnDelete(v);
    onDeleteOpenChange?.(v);
  };
  const [confirmDone, setConfirmDone] = React.useState(false);
  const [download, setDownload] = React.useState<Download>("idle");
  const download_ = (format: "json" | "md"): void => {
    setDownload("busy");
    saveMyData(format).then(
      () => {
        setDownload("done");
      },
      () => {
        setDownload("failed");
      },
    );
  };
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={t.participant.session.menu}>
            <MoreHorizontalIcon />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72 max-w-[calc(100vw-1.5rem)] p-2">
          <p className="text-muted-foreground px-2 pb-2 text-xs">{t.participant.session.sessionMenuHint}</p>
          <div className="grid gap-1">
            {onWrapUp ? (
              <Button
                variant="ghost"
                className="h-auto min-h-11 justify-start py-2 text-left"
                disabled={disabled}
                onClick={() => {
                  setOpen(false);
                  onWrapUp();
                }}
              >
                <FastForwardIcon />
                <span className="grid">
                  <span>{t.participant.session.wrapUp}</span>
                  <span className="text-muted-foreground text-xs font-normal whitespace-normal">
                    {t.participant.session.wrapUpHint}
                  </span>
                </span>
              </Button>
            ) : null}
            <Button
              variant="ghost"
              className="h-11 justify-start"
              disabled={disabled}
              onClick={() => {
                // Ending the interview is the participant's call and ends their part of it: ask.
                setOpen(false);
                setConfirmDone(true);
              }}
            >
              <CheckCircle2Icon /> {t.participant.session.done}
            </Button>
            <Button
              variant="ghost"
              className="h-11 justify-start"
              disabled={download === "busy"}
              onClick={() => {
                download_("md");
              }}
            >
              <DownloadIcon /> {t.participant.session.downloadReadable}
            </Button>
            <Button
              variant="ghost"
              className="h-11 justify-start"
              disabled={download === "busy"}
              onClick={() => {
                download_("json");
              }}
            >
              <DownloadIcon /> {t.participant.session.downloadJson}
            </Button>
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive h-11 justify-start"
              onClick={() => {
                setOpen(false);
                setConfirmDelete(true);
              }}
            >
              <Trash2Icon /> {t.participant.session.deleteData}
            </Button>
          </div>
          {/* From 640 px the header carries these two; below it they live here. */}
          <div className="mt-2 grid gap-2 border-t px-2 pt-2 sm:hidden">
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground text-xs">{t.app.language}</span>
              <LanguageMenu showName align="end" />
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground text-xs">{t.app.theme.label}</span>
              <ThemeToggle showName />
            </div>
          </div>
          {/* Announced to a screen reader as it changes, so a slow export is not silent. */}
          <p role="status" aria-live="polite" className="text-muted-foreground px-2 pt-2 text-xs">
            {download === "busy"
              ? t.participant.session.downloadBusy
              : download === "done"
                ? t.participant.session.downloadDone
                : download === "failed"
                  ? t.participant.session.downloadFailed
                  : ""}
          </p>
        </PopoverContent>
      </Popover>
      <ConfirmDialog
        open={confirmDone}
        onOpenChange={setConfirmDone}
        title={t.participant.session.doneTitle}
        description={<p>{t.participant.session.doneBody}</p>}
        confirmLabel={t.participant.session.doneConfirm}
        tone="default"
        onConfirm={onDone}
      />
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.participant.session.deleteTitle}</AlertDialogTitle>
            <AlertDialogDescription>{t.participant.session.deleteBody}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t.app.cancel}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
              onClick={() => {
                onDelete();
              }}
            >
              {t.participant.session.deleteConfirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
