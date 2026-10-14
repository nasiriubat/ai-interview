"use client";

import {
  FileTextIcon,
  ImageIcon,
  Loader2Icon,
  MicIcon,
  PauseIcon,
  PlayIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Inset } from "@/components/ui/inset";
import { t } from "@/i18n";
import type { Attachment } from "@/lib/api/schemas";
import { formatBytes, formatClock } from "@/lib/attachments";
import { cn } from "@/lib/utils";

const ICONS: Record<Attachment["kind"], typeof FileTextIcon> = {
  audio: MicIcon,
  image: ImageIcon,
  document: FileTextIcon,
};

/**
 * Plays a stored recording. The bytes are fetched through the proxy and played from a blob URL,
 * which is revoked as soon as the element is gone: an object URL that is never revoked keeps the
 * whole recording in memory for the life of the tab.
 */
function PlayButton({
  attachment,
  label,
  fetchBytes,
}: {
  attachment: Attachment;
  label: string;
  fetchBytes: (attachmentId: string) => Promise<Blob>;
}): React.JSX.Element {
  const [playing, setPlaying] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const urlRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
      if (urlRef.current !== null) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    };
  }, []);

  const toggle = async (): Promise<void> => {
    if (playing) {
      audioRef.current?.pause();
      setPlaying(false);
      return;
    }
    setFailed(false);
    try {
      if (!audioRef.current) {
        setLoading(true);
        const blob = await fetchBytes(attachment.id);
        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        const audio = new Audio(url);
        audio.onended = (): void => {
          setPlaying(false);
        };
        audioRef.current = audio;
      }
      await audioRef.current.play();
      setPlaying(true);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };

  const s = t.participant.session;
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-11 shrink-0"
        disabled={loading}
        aria-label={playing ? s.attachmentPause(label) : s.attachmentPlay(label)}
        onClick={() => {
          void toggle();
        }}
      >
        {loading ? (
          <Loader2Icon className="size-4 motion-safe:animate-spin" />
        ) : playing ? (
          <PauseIcon className="size-4" />
        ) : (
          <PlayIcon className="size-4" />
        )}
      </Button>
      {failed ? <span className="text-destructive text-xs">{s.attachFailed}</span> : null}
    </>
  );
}

function statusLine(a: Attachment): string {
  const s = t.participant.session;
  if (a.status === "pending") return s.attachmentPending;
  if (a.status === "failed") return a.error ?? s.attachmentFailed;
  return s.attachmentReady;
}

/**
 * The files and recordings attached to this session, above the composer. Every row says what the
 * file is doing — being read, ready, or refused and why — because an attachment the interviewer
 * cannot use yet is worth knowing about before the next question is answered.
 */
export function AttachmentList({
  items,
  uploading,
  progress = null,
  onCancel,
  error,
  onRemove,
  fetchBytes,
}: {
  items: Attachment[];
  uploading: boolean;
  progress?: number | null;
  onCancel?: (() => void) | undefined;
  error: string | null;
  onRemove: (attachmentId: string) => void;
  fetchBytes: (attachmentId: string) => Promise<Blob>;
}): React.JSX.Element | null {
  const s = t.participant.session;
  if (items.length === 0 && !uploading && error === null) return null;

  return (
    <div className="mb-2 grid gap-1">
      {error !== null ? (
        <p className="text-destructive flex items-center gap-1.5 text-xs" role="alert">
          <TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden="true" />
          {error}
        </p>
      ) : null}
      {items.length > 0 ? (
        <ul aria-label={s.attachmentsLabel} className="grid gap-1">
          {items.map((a) => {
            const Icon = ICONS[a.kind];
            const label = a.kind === "audio" ? s.attachmentRecording : a.filename;
            const size =
              a.kind === "audio" && a.durationMs != null
                ? formatClock(a.durationMs)
                : formatBytes(a.sizeBytes);
            return (
              <Inset as="li" key={a.id} className="flex items-center gap-2 py-0.5 pr-0.5 pl-3">
                <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
                <div className="min-w-0 flex-1 py-1">
                  <p className="truncate text-sm">{label}</p>
                  <p
                    className={cn(
                      "text-muted-foreground text-xs",
                      a.status === "failed" && "text-destructive",
                    )}
                  >
                    {size} · {statusLine(a)}
                  </p>
                </div>
                {a.kind === "audio" && a.status !== "failed" ? (
                  <PlayButton attachment={a} label={label} fetchBytes={fetchBytes} />
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-11 shrink-0"
                  aria-label={s.attachmentRemove(label)}
                  onClick={() => {
                    onRemove(a.id);
                  }}
                >
                  <XIcon className="size-4" />
                </Button>
              </Inset>
            );
          })}
        </ul>
      ) : null}
      {uploading ? (
        <div className="grid gap-1">
          <div className="flex items-center gap-2">
            <p className="text-muted-foreground flex flex-1 items-center gap-1.5 text-xs" role="status">
              <Loader2Icon className="size-3.5 shrink-0 motion-safe:animate-spin" aria-hidden="true" />
              {s.attachUploading}
              {progress !== null && progress > 0 ? ` ${String(progress)} %` : ""}
            </p>
            {onCancel ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-9 shrink-0"
                aria-label={s.attachCancel}
                onClick={onCancel}
              >
                <XIcon className="size-4" />
              </Button>
            ) : null}
          </div>
          <div
            role="progressbar"
            aria-label={s.attachUploading}
            aria-valuemin={0}
            aria-valuemax={100}
            {...(progress !== null ? { "aria-valuenow": progress } : {})}
            className="bg-muted h-1.5 overflow-hidden rounded-full"
          >
            <div
              className="bg-primary h-full rounded-full transition-[width] duration-150"
              style={{ width: `${String(Math.max(progress ?? 0, 6))}%` }}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
