"use client";

import * as React from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { t } from "@/i18n";
import { errorMessage } from "@/lib/api/errors";

export interface FlashState {
  kind: "success" | "error";
  text: string;
}

/** Inline status message for admin panels, announced to assistive tech. */
export function Flash({ flash }: { flash: FlashState | null }): React.JSX.Element | null {
  if (!flash) return null;
  return (
    <Alert variant={flash.kind === "error" ? "destructive" : "default"} role="status" className="my-3">
      <AlertDescription>{flash.text}</AlertDescription>
    </Alert>
  );
}

export interface ActionRunner {
  busy: boolean;
  flash: FlashState | null;
  setFlash: (f: FlashState | null) => void;
  /** Runs an async action; shows `success` on completion and the API error message on failure. */
  run: (fn: () => Promise<void>, success?: string) => Promise<boolean>;
}

export function useAction(): ActionRunner {
  const [busy, setBusy] = React.useState(false);
  const [flash, setFlash] = React.useState<FlashState | null>(null);
  const run = React.useCallback(async (fn: () => Promise<void>, success?: string): Promise<boolean> => {
    setBusy(true);
    setFlash(null);
    try {
      await fn();
      if (success) setFlash({ kind: "success", text: success });
      return true;
    } catch (e) {
      setFlash({ kind: "error", text: errorMessage(e, t.app.unknownError) });
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, flash, setFlash, run };
}
