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
import { Input } from "@/components/ui/input";
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
  confirmPhrase,
  pending = false,
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
  /**
   * For what cannot be taken back (deleting a tenant, wiping data): the person must type this
   * text, exactly, before the confirm button works. Shown in the dialog; case-sensitive.
   */
  confirmPhrase?: string | undefined;
  pending?: boolean;
}): React.JSX.Element {
  const [typed, setTyped] = React.useState("");
  const inputId = React.useId();
  React.useEffect(() => {
    if (!open) setTyped("");
  }, [open]);
  const blocked = confirmPhrase !== undefined && typed !== confirmPhrase;
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>{description}</div>
          </AlertDialogDescription>
          {confirmPhrase !== undefined ? (
            <div className="grid gap-1.5 pt-1">
              <label htmlFor={inputId} className="text-sm font-medium">
                {t.kit.form.typeToConfirm(confirmPhrase)}
              </label>
              <Input
                id={inputId}
                value={typed}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={typed !== "" && blocked ? true : undefined}
                onChange={(e) => {
                  setTyped(e.target.value);
                }}
              />
            </div>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelLabel ?? t.app.cancel}</AlertDialogCancel>
          <AlertDialogAction
            className={cn(tone === "destructive" && buttonVariants({ variant: "destructive" }))}
            disabled={blocked || pending}
            onClick={onConfirm}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
