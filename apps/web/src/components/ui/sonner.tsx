"use client";

import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";
import * as React from "react";
import { Toaster as Sonner, toast } from "sonner";
// The library injected this as a <style> element at runtime, which a nonce-only style-src blocks;
// the package is patched not to (patches/sonner.patch) and the same CSS is served as a file (D-264).
import "sonner/dist/styles.css";

/**
 * Toasts confirm that something finished ("Saved", "Invitation sent") (D-78). They are the wrong
 * place for anything the person has to act on: a toast disappears, and a validation error that
 * vanished before it was read is worse than none. Field and form errors stay inline, next to what
 * caused them. Sonner renders into an `aria-live` region, so screen readers hear each toast once.
 */
export function Toaster(): React.JSX.Element {
  return (
    <Sonner
      position="bottom-right"
      closeButton
      visibleToasts={3}
      duration={4000}
      offset={{ bottom: 16, right: 16 }}
      mobileOffset={{ bottom: 12, left: 12, right: 12 }}
      icons={{
        success: <CircleCheckIcon className="text-success size-4" aria-hidden="true" />,
        error: <CircleAlertIcon className="text-destructive size-4" aria-hidden="true" />,
        warning: <TriangleAlertIcon className="text-warning size-4" aria-hidden="true" />,
        info: <InfoIcon className="text-primary size-4" aria-hidden="true" />,
      }}
      toastOptions={{
        classNames: {
          toast:
            "!bg-card !text-foreground !border-0 !shadow-raised !rounded-lg !font-sans !text-sm !gap-2.5 !py-3 !px-4",
          description: "!text-muted-foreground",
          closeButton: "!bg-card !border-border !text-muted-foreground hover:!text-foreground",
        },
      }}
    />
  );
}

export { toast };
