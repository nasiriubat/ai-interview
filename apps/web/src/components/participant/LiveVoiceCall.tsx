"use client";

import { LoaderCircleIcon, MicIcon, PhoneIcon, PhoneOffIcon, SquareIcon, Volume2Icon } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { METER_STEPS, type LiveVoiceController, type LiveVoiceProblem } from "@/hooks/useLiveVoice";
import { recorderProblemMessage } from "@/hooks/useRecorder";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * The real-time call (FR-30a) as the participant sees it.
 *
 * Hands-free means there is no button to hold, so the screen has to say what the microphone is
 * doing: listening, thinking, or speaking. The word is the message and the meter only confirms it,
 * because a level bar tells a screen-reader user and a colour-blind user nothing. Ending the call
 * and dropping back to typing are always one visible, focusable button away — the spec's fallback
 * chain is not only about what the server can do.
 */

function problemMessage(problem: LiveVoiceProblem): string {
  return problem === "lost" ? t.participant.session.liveLost : recorderProblemMessage(problem);
}

/** Microphone loudness. Decorative: `aria-hidden`, because the status text already carries it. */
function LevelMeter({ level }: { level: number }): React.JSX.Element {
  const filled = Math.round(level * METER_STEPS);
  return (
    <span className="flex h-5 items-end gap-0.5" aria-hidden="true">
      {Array.from({ length: METER_STEPS }, (_, i) => (
        <span
          key={i}
          className={cn(
            "w-1 origin-bottom rounded-full motion-safe:transition-transform motion-safe:duration-100",
            // Height and colour both move, so the meter still reads with colours off.
            i < filled ? "bg-primary" : "bg-muted-foreground/25 scale-y-[0.3]",
          )}
          style={{ height: `${8 + i * 1.5}px` }}
        />
      ))}
    </span>
  );
}

export function LiveVoiceCall({
  live,
  disabled = false,
  onStart,
}: {
  live: LiveVoiceController;
  /** The interview cannot take a turn right now (busy elsewhere, or over). */
  disabled?: boolean;
  onStart: () => void;
}): React.JSX.Element {
  const s = t.participant.session;
  const { status } = live;
  const endRef = React.useRef<HTMLButtonElement>(null);
  const startRef = React.useRef<HTMLButtonElement>(null);

  // Focus follows the control that replaced the one just pressed, so a keyboard user is never
  // left on a button that no longer exists.
  const wasLive = React.useRef(false);
  const isLive = status !== "idle" && status !== "unavailable";
  React.useEffect(() => {
    if (isLive && !wasLive.current) endRef.current?.focus();
    else if (!isLive && wasLive.current) startRef.current?.focus();
    wasLive.current = isLive;
  }, [isLive]);

  if (status === "unavailable") {
    return (
      <p className="text-muted-foreground mb-2 text-sm" role="status">
        {s.liveUnavailable}
      </p>
    );
  }

  if (status === "idle") {
    return (
      <div className="mb-2 grid gap-1.5">
        <Button ref={startRef} type="button" className="min-h-11" disabled={disabled} onClick={onStart}>
          <PhoneIcon className="size-4" aria-hidden="true" />
          {s.liveStart}
        </Button>
        <p className="text-muted-foreground text-xs">{s.liveStartHint}</p>
        {live.problem ? (
          <p className="text-destructive text-xs" role="alert">
            {problemMessage(live.problem)}
          </p>
        ) : null}
      </div>
    );
  }

  const label =
    status === "connecting"
      ? s.liveConnecting
      : status === "speaking"
        ? s.liveSpeaking
        : status === "thinking"
          ? s.liveThinking
          : s.liveListening;
  const Icon = status === "speaking" ? Volume2Icon : status === "listening" ? MicIcon : LoaderCircleIcon;

  return (
    <div className="bg-muted mb-2 grid gap-2 rounded-2xl p-3">
      <div className="flex items-center gap-3">
        {/* role="status" announces every change of phase without a second, duplicated live region. */}
        <p role="status" className="flex flex-1 items-center gap-2 text-sm font-medium">
          <Icon
            className={cn(
              "size-4 shrink-0",
              status === "connecting" || status === "thinking" ? "motion-safe:animate-spin" : "",
            )}
            aria-hidden="true"
          />
          {label}
        </p>
        {status === "listening" ? <LevelMeter level={live.level} /> : null}
        {status === "speaking" ? (
          <Button type="button" size="sm" variant="outline" className="min-h-9" onClick={live.stopSpeaking}>
            <SquareIcon className="size-4" aria-hidden="true" />
            {s.liveStopSpeaking}
          </Button>
        ) : null}
        <Button
          ref={endRef}
          type="button"
          size="sm"
          variant="destructive"
          className="min-h-9"
          onClick={live.end}
        >
          <PhoneOffIcon className="size-4" aria-hidden="true" />
          {s.liveEnd}
        </Button>
      </div>
      {status === "listening" ? <p className="text-muted-foreground text-xs">{s.liveListeningHint}</p> : null}
      {live.notHeard ? (
        <p className="text-xs" role="status">
          {s.liveNotHeard}
        </p>
      ) : null}
      {live.textOnly ? (
        <p className="text-muted-foreground text-xs" role="status">
          {s.liveTextOnly}
        </p>
      ) : null}
      {!live.captions && status !== "connecting" ? (
        <p className="text-muted-foreground text-xs">{s.liveNoCaptions}</p>
      ) : null}
      {live.problem ? (
        <p className="text-destructive text-xs" role="alert">
          {problemMessage(live.problem)}
        </p>
      ) : null}
    </div>
  );
}
