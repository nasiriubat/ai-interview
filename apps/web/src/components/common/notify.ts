import { undoToast } from "@/components/common/undoToast";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { errorMessage } from "@/lib/api/errors";

/**
 * The one way UI code raises a toast (D-340). A thin layer over Sonner that fixes the rules, so
 * every page behaves the same:
 *
 * - success: 4 s, says what finished ("Campaign saved"); never carries an action the person must take;
 * - info: 5 s;
 * - error: 9 s, and a failed action offers Retry (`retry`), which keeps the toast until used or closed;
 * - loading: stays until the promise settles, then turns into the success or error toast in place;
 * - undo: 6 s, see `undoToast`.
 *
 * Toasts are stacked by the toaster (three visible, the rest queued) and announced once through its
 * live region. Anything the person must fix or read carefully stays inline, next to its cause.
 */
export const TOAST_MS = { success: 4000, info: 5000, error: 9000 } as const;

export interface NotifyOptions {
  description?: string;
  /** Reuse an id to replace a toast instead of stacking a second. */
  id?: string | number;
}

export const notify = {
  success(text: string, options: NotifyOptions = {}): string | number {
    return toast.success(text, { duration: TOAST_MS.success, ...options });
  },

  info(text: string, options: NotifyOptions = {}): string | number {
    return toast.info(text, { duration: TOAST_MS.info, ...options });
  },

  /**
   * A failed action. `retry` re-runs it; the toast then offers "Try again" and is kept longer, because
   * the person may be looking elsewhere when it fails.
   */
  error(error: unknown, options: NotifyOptions & { retry?: () => void } = {}): string | number {
    const { retry, ...rest } = options;
    const text = typeof error === "string" ? error : errorMessage(error, t.app.unknownError);
    return toast.error(text, {
      duration: retry ? TOAST_MS.error * 2 : TOAST_MS.error,
      ...rest,
      ...(retry ? { action: { label: t.kit.toast.retry, onClick: retry } } : {}),
    });
  },

  /**
   * A toast that follows a promise: a spinner while it runs, then the success text or the error
   * (with Retry when `retry` is given). Resolves to the promise's own result.
   */
  async promise<T>(
    work: Promise<T>,
    text: { loading: string; success: string | ((value: T) => string) },
    options: { retry?: () => void } = {},
  ): Promise<T> {
    const id = toast.loading(text.loading);
    try {
      const value = await work;
      toast.success(typeof text.success === "function" ? text.success(value) : text.success, {
        id,
        duration: TOAST_MS.success,
      });
      return value;
    } catch (e) {
      toast.error(errorMessage(e, t.app.unknownError), {
        id,
        duration: options.retry ? TOAST_MS.error * 2 : TOAST_MS.error,
        ...(options.retry ? { action: { label: t.kit.toast.retry, onClick: options.retry } } : {}),
      });
      throw e;
    }
  },

  /** A finished action that can be reversed: see `undoToast`. */
  undo: undoToast,

  dismiss(id?: string | number): void {
    toast.dismiss(id);
  },
};
