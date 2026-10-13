import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";

/** How long the Undo stays on offer. Long enough to read and reach, short enough to be forgotten. */
export const UNDO_MS = 6000;

/**
 * A reversible action with an Undo (the policy table in D-111): the action has already been sent,
 * and Undo sends the inverse. The toast sits in Sonner's live region, so a screen reader hears
 * the text once; the Undo button is reachable with the toaster hotkey (Alt+T).
 *
 * Returns the toast id so a caller can dismiss it (for instance when the thing it refers to went
 * away).
 */
export function undoToast(
  text: string,
  onUndo: () => void | Promise<void>,
  options: {
    /**
     * Called when the toast goes away without Undo having been pressed (timed out, or closed by the
     * person). For work that was deferred until the offer lapsed.
     */
    onClose?: () => void;
  } = {},
): string | number {
  let undone = false;
  const close = (): void => {
    if (!undone) options.onClose?.();
  };
  return toast(text, {
    duration: UNDO_MS,
    action: {
      label: t.app.undo,
      onClick: () => {
        undone = true;
        void onUndo();
      },
    },
    onDismiss: close,
    onAutoClose: close,
  });
}
