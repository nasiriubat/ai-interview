"use client";

import * as React from "react";
import { undoToast, UNDO_MS } from "@/components/common/undoToast";
import { t } from "@/i18n";
import { isApiError } from "@/lib/api/errors";
import type { ParticipantApi } from "@/lib/api/participant";
import type { Attachment, SessionCapabilities } from "@/lib/api/schemas";
import { acceptFor, isAllowedAttachment, isTooLarge } from "@/lib/attachments";

/** How often a still-unread attachment is asked about. Ingestion is a job, so it takes seconds. */
export const ATTACHMENT_POLL_MS = 3000;

export interface AttachmentsOptions {
  /** The session's own attachments, so the first render needs no request of its own. */
  initial: Attachment[];
  capabilities: SessionCapabilities;
  enabled: boolean;
}

export interface AttachmentsController {
  items: Attachment[];
  uploading: boolean;
  /** 0 to 100 while a file is being sent; null when idle or when the browser cannot measure it. */
  progress: number | null;
  /** Stops the upload in progress; the file is not kept. */
  cancelUpload: () => void;
  error: string | null;
  /** The `accept` attribute for the picker, from the types this session actually allows. */
  accept: string;
  /** Adds a picked file. The wrong type or an oversized file is refused before the upload. */
  upload: (file: File) => void;
  remove: (attachmentId: string) => void;
  bytes: (attachmentId: string) => Promise<Blob>;
  /** Re-reads the list, for attachments the server made on its own (a recorded turn's audio). */
  refresh: () => void;
  clearError: () => void;
}

/** The API's rejection codes, said in the participant's words rather than the server's. */
function uploadMessage(e: unknown): string {
  const s = t.participant.session;
  if (!isApiError(e)) return s.attachFailed;
  switch (e.code) {
    case "too_large":
      return s.attachTooLarge;
    case "storage_full":
      return s.attachStorageFull;
    case "forbidden":
      return s.attachForbidden;
    case "validation":
      return s.attachTypeRejected;
    default:
      return s.attachFailed;
  }
}

/**
 * The session's attachments: uploading, removing, playing back, and watching a pending one
 * become readable. Type and size are checked here against the capabilities in force, so a file
 * that was never going to be accepted costs no upload — but the API checks again, because a
 * setting can change between opening the page and picking the file.
 */
export function useAttachments(api: ParticipantApi, options: AttachmentsOptions): AttachmentsController {
  const { capabilities, enabled } = options;
  const [items, setItems] = React.useState<Attachment[]>(options.initial);
  const [uploading, setUploading] = React.useState(false);
  const [progress, setProgress] = React.useState<number | null>(null);
  const controller = React.useRef<AbortController | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const reload = React.useCallback((): void => {
    api
      .listAttachments()
      .then(setItems)
      .catch(() => {
        // Transient failure: what is on screen stays, and the next attempt tries again.
      });
  }, [api]);

  const waiting = items.some((a) => a.status === "pending");
  React.useEffect(() => {
    if (!enabled || !waiting) return;
    const id = setInterval(reload, ATTACHMENT_POLL_MS);
    return () => {
      clearInterval(id);
    };
  }, [enabled, reload, waiting]);

  const upload = React.useCallback(
    (file: File): void => {
      if (!isAllowedAttachment(file, capabilities.allowedTypes)) {
        setError(t.participant.session.attachTypeRejected);
        return;
      }
      if (isTooLarge(file, capabilities.maxSizeMb)) {
        setError(t.participant.session.attachTooLargeLimit(capabilities.maxSizeMb));
        return;
      }
      setError(null);
      setUploading(true);
      setProgress(0);
      const abort = new AbortController();
      controller.current = abort;
      api
        .uploadAttachment(file, undefined, { signal: abort.signal, onProgress: setProgress })
        .then((created) => {
          setItems((list) => [...list.filter((a) => a.id !== created.id), created]);
        })
        .catch((e: unknown) => {
          if (abort.signal.aborted) return;
          setError(uploadMessage(e));
        })
        .finally(() => {
          if (controller.current === abort) controller.current = null;
          setUploading(false);
          setProgress(null);
        });
    },
    [api, capabilities.allowedTypes, capabilities.maxSizeMb],
  );

  /**
   * Removal is deferred, not undone afterwards: the row leaves the list at once and the DELETE is
   * sent only when the Undo offer lapses (six seconds, or the toast being closed). A file that was
   * pulled by mistake is therefore never gone from the server, which has no way to give it back.
   * Anything still waiting when the screen goes away is sent then, so leaving never un-removes.
   */
  const pending = React.useRef(new Map<string, () => void>());
  const remove = React.useCallback(
    (attachmentId: string): void => {
      const index = items.findIndex((a) => a.id === attachmentId);
      const item = items[index];
      if (!item || pending.current.has(attachmentId)) return;
      setItems((list) => list.filter((a) => a.id !== attachmentId));

      const commit = (): void => {
        pending.current.delete(attachmentId);
        api.deleteAttachment(attachmentId).catch(() => {
          // The server still has it: show it again rather than pretend it is gone.
          setItems((list) => (list.some((a) => a.id === item.id) ? list : [...list, item]));
          setError(t.app.unknownError);
        });
      };
      const timer = setTimeout(commit, UNDO_MS);
      const settle = (): void => {
        clearTimeout(timer);
        if (pending.current.has(attachmentId)) commit();
      };
      pending.current.set(attachmentId, settle);
      const name = item.kind === "audio" ? t.participant.session.attachmentRecording : item.filename;
      undoToast(
        t.participant.session.attachmentRemoved(name),
        () => {
          clearTimeout(timer);
          pending.current.delete(attachmentId);
          setItems((list) =>
            list.some((a) => a.id === item.id) ? list : [...list.slice(0, index), item, ...list.slice(index)],
          );
        },
        { onClose: settle },
      );
    },
    [api, items],
  );
  React.useEffect(() => {
    const waiting = pending.current;
    return () => {
      for (const settle of [...waiting.values()]) settle();
    };
  }, []);

  const bytes = React.useCallback(
    (attachmentId: string): Promise<Blob> => api.attachmentBytes(attachmentId),
    [api],
  );
  const cancelUpload = React.useCallback((): void => {
    controller.current?.abort();
  }, []);
  const clearError = React.useCallback((): void => {
    setError(null);
  }, []);

  return {
    items,
    uploading,
    progress,
    cancelUpload,
    error,
    accept: acceptFor(capabilities.allowedTypes),
    upload,
    remove,
    bytes,
    refresh: reload,
    clearError,
  };
}
