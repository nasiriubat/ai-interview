"use client";

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
import { buttonVariants } from "@/components/ui/button";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * The confirmation of an action that affects another person, destroys data or cannot be undone on
 * the same screen (the policy table in D-111). The title asks the question, the body names the
 * consequence, and the confirm button repeats the verb: "Close campaign", never "OK".
 *
 * Controlled, so a row of a table can open it for the row that was clicked. The action runs after
 * the dialog has closed; focus returns to whatever opened it (Radix).
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  tone = "destructive",
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  /** Defaults to "Cancel"; a question about leaving reads better as "Stay on this page". */
  cancelLabel?: string | undefined;
  tone?: "destructive" | "default";
  onConfirm: () => void;
}): React.JSX.Element {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelLabel ?? t.app.cancel}</AlertDialogCancel>
          <AlertDialogAction
            className={cn(tone === "destructive" && buttonVariants({ variant: "destructive" }))}
            onClick={onConfirm}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
