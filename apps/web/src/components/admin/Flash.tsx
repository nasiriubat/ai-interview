"use client";

import { CircleAlertIcon } from "lucide-react";
import * as React from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { errorMessage } from "@/lib/api/errors";

export interface FlashState {
  kind: "success" | "error";
  text: string;
}

/**
 * The inline half of admin feedback: errors, shown next to the form that caused them and kept
 * until the next attempt. Success is a toast instead (see `useAction`), because a confirmation
 * does not need to stay on screen and an error does (D-78).
 */
export function Flash({ flash }: { flash: FlashState | null }): React.JSX.Element | null {
  if (flash?.kind !== "error") return null;
  return (
    <Alert variant="destructive" className="my-3">
      <CircleAlertIcon aria-hidden="true" />
      <AlertDescription>{flash.text}</AlertDescription>
    </Alert>
  );
}

export interface ActionRunner {
  busy: boolean;
  flash: FlashState | null;
  /** A success is shown as a toast; an error stays inline in `<Flash>`. */
  setFlash: (f: FlashState | null) => void;
  /** Runs an async action; toasts `success` on completion and shows the API error inline on failure. */
  run: (fn: () => Promise<void>, success?: string) => Promise<boolean>;
}

export function useAction(): ActionRunner {
  const [busy, setBusy] = React.useState(false);
  const [flash, setFlashState] = React.useState<FlashState | null>(null);
  const setFlash = React.useCallback((f: FlashState | null) => {
    if (f?.kind === "success") {
      toast.success(f.text);
      setFlashState(null);
      return;
    }
    setFlashState(f);
  }, []);
  const run = React.useCallback(
    async (fn: () => Promise<void>, success?: string): Promise<boolean> => {
      setBusy(true);
      setFlashState(null);
      try {
        await fn();
        if (success) setFlash({ kind: "success", text: success });
        return true;
      } catch (e) {
        setFlashState({ kind: "error", text: errorMessage(e, t.app.unknownError) });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [setFlash],
  );
  return { busy, flash, setFlash, run };
}
