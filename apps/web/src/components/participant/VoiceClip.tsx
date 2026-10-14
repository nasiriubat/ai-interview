"use client";

import { Loader2Icon, MicIcon, PauseIcon, PlayIcon, RotateCcwIcon } from "lucide-react";
import * as React from "react";
import { t } from "@/i18n";
import type { Attachment } from "@/lib/api/schemas";
import { formatClock } from "@/lib/attachments";
import { cn } from "@/lib/utils";

/**
 * Plays a stored recording. The bytes are fetched through the proxy and played from a blob URL,
 * which is revoked as soon as the element is gone: an object URL that is never revoked keeps the
 * whole recording in memory for the life of the tab.
 */
export function useClipPlayer(
  attachmentId: string,
  fetchBytes: ((attachmentId: string) => Promise<Blob>) | undefined,
): { playing: boolean; loading: boolean; failed: boolean; toggle: () => void } {
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

  const toggle = (): void => {
    void (async () => {
      if (playing) {
        audioRef.current?.pause();
        setPlaying(false);
        return;
      }
      if (!fetchBytes) return;
      setFailed(false);
      try {
        if (!audioRef.current) {
          setLoading(true);
          const blob = await fetchBytes(attachmentId);
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
    })();
  };
  return { playing, loading, failed, toggle };
}

/** A fixed pattern of bar heights from the id, so one clip always looks like itself. Decorative. */
function barsFor(id: string): number[] {
  let h = 7;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Array.from({ length: 22 }, (_, i) => {
    h = (Math.imul(h, 1103515245) + 12345) | 0;
    const wave = 0.5 + 0.3 * Math.sin(i / 2.6);
    const jitter = ((h >>> 8) % 30) / 100 - 0.15;
    return Math.round(5 + 15 * Math.min(1, Math.max(0.15, wave + jitter)));
  });
}

export interface ClipSource {
  attachment: Attachment;
  fetchBytes: (attachmentId: string) => Promise<Blob>;
}

/**
 * A spoken answer inside the participant's own bubble: play or pause, the length, and what was
 * heard written out underneath. Three states the bubble can be in: `sending` (the recording is on
 * its way), `failed` (with a retry right here, so the person does not have to find a banner) and
 * `ready`.
 */
export function VoiceClip({
  messageKey,
  source,
  transcript,
  state,
  onRetry,
}: {
  messageKey: string;
  source?: ClipSource | undefined;
  transcript: string;
  state: "sending" | "failed" | "ready";
  onRetry?: (() => void) | undefined;
}): React.JSX.Element {
  const s = t.participant.session;
  const bars = React.useMemo(() => barsFor(source?.attachment.id ?? messageKey), [source, messageKey]);
  const player = useClipPlayer(source?.attachment.id ?? "", source?.fetchBytes);
  const duration = source?.attachment.durationMs;
  const label = s.attachmentRecording;

  return (
    <div className="grid gap-1.5" data-voice-clip="">
      <div className="flex items-center gap-2.5">
        {source && state === "ready" ? (
          <button
            type="button"
            disabled={player.loading}
            aria-label={player.playing ? s.attachmentPause(label) : s.attachmentPlay(label)}
            onClick={player.toggle}
            className="bg-primary-foreground/20 hover:bg-primary-foreground/30 grid size-10 shrink-0 place-items-center rounded-full"
          >
            {player.loading ? (
              <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden="true" />
            ) : player.playing ? (
              <PauseIcon className="size-4" aria-hidden="true" />
            ) : (
              <PlayIcon className="size-4" aria-hidden="true" />
            )}
          </button>
        ) : (
          <span className="bg-primary-foreground/20 grid size-10 shrink-0 place-items-center rounded-full">
            {state === "sending" ? (
              <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden="true" />
            ) : (
              <MicIcon className="size-4" aria-hidden="true" />
            )}
          </span>
        )}
        <span aria-hidden="true" className="flex h-6 min-w-0 flex-1 items-center gap-[3px] overflow-hidden">
          {bars.map((h, i) => (
            <span
              key={i}
              style={{ height: `${String(h)}px` }}
              className={cn(
                "bg-primary-foreground/70 w-[3px] shrink-0 rounded-full",
                player.playing && "motion-safe:animate-pulse",
                state !== "ready" && "opacity-40",
              )}
            />
          ))}
        </span>
        <span className="text-xs tabular-nums">
          {state === "sending" ? "" : duration != null ? formatClock(duration) : ""}
        </span>
      </div>
      {state === "failed" ? (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span>{s.clipFailed}</span>
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex min-h-9 items-center gap-1.5 font-semibold underline underline-offset-2"
            >
              <RotateCcwIcon className="size-3.5" aria-hidden="true" />
              {t.app.retry}
            </button>
          ) : null}
        </p>
      ) : state === "sending" ? (
        <p className="text-sm">{s.clipTranscribing}</p>
      ) : transcript ? (
        <p className="text-base leading-relaxed">{transcript}</p>
      ) : (
        <p className="text-sm italic">{s.clipNoTranscript}</p>
      )}
      {player.failed ? <p className="text-xs">{s.attachFailed}</p> : null}
    </div>
  );
}
