"use client";

import { CheckCircle2Icon, MoreHorizontalIcon, PauseIcon, Trash2Icon } from "lucide-react";
import * as React from "react";
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

/** Pause, "I'm done" and "Delete my data": always one tap away. */
export function SessionMenu({
  onPause,
  onDone,
  onDelete,
  disabled,
}: {
  onPause: () => void;
  onDone: () => void;
  onDelete: () => void;
  disabled?: boolean;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="icon" aria-label={t.participant.session.menu}>
            <MoreHorizontalIcon />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-60 p-2">
          <p className="text-muted-foreground px-2 pb-2 text-xs">{t.participant.session.sessionMenuHint}</p>
          <div className="grid gap-1">
            <Button
              variant="ghost"
              className="justify-start"
              disabled={disabled}
              onClick={() => {
                setOpen(false);
                onPause();
              }}
            >
              <PauseIcon /> {t.participant.session.pause}
            </Button>
            <Button
              variant="ghost"
              className="justify-start"
              disabled={disabled}
              onClick={() => {
                setOpen(false);
                onDone();
              }}
            >
              <CheckCircle2Icon /> {t.participant.session.done}
            </Button>
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive justify-start"
              onClick={() => {
                setOpen(false);
                setConfirmDelete(true);
              }}
            >
              <Trash2Icon /> {t.participant.session.deleteData}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.participant.session.deleteTitle}</AlertDialogTitle>
            <AlertDialogDescription>{t.participant.session.deleteBody}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t.app.cancel}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90 text-white"
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
