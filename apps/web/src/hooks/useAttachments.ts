"use client";

import * as React from "react";
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
      api
        .uploadAttachment(file)
        .then((created) => {
          setItems((list) => [...list.filter((a) => a.id !== created.id), created]);
        })
        .catch((e: unknown) => {
          setError(uploadMessage(e));
        })
        .finally(() => {
          setUploading(false);
        });
    },
    [api, capabilities.allowedTypes, capabilities.maxSizeMb],
  );

  const remove = React.useCallback(
    (attachmentId: string): void => {
      // Removed from the list first: the participant asked for it to be gone, and a failed
      // delete that only the server knows about is recovered by the next load.
      setItems((list) => list.filter((a) => a.id !== attachmentId));
      api.deleteAttachment(attachmentId).catch(() => {
        setError(t.app.unknownError);
      });
    },
    [api],
  );

  const bytes = React.useCallback(
    (attachmentId: string): Promise<Blob> => api.attachmentBytes(attachmentId),
    [api],
  );
  const clearError = React.useCallback((): void => {
    setError(null);
  }, []);

  return {
    items,
    uploading,
    error,
    accept: acceptFor(capabilities.allowedTypes),
    upload,
    remove,
    bytes,
    refresh: reload,
    clearError,
  };
}
