"use client";

import {
  AlertCircleIcon,
  AudioLinesIcon,
  MicIcon,
  PaperclipIcon,
  SendHorizontalIcon,
  XIcon,
} from "lucide-react";
import * as React from "react";
import { LevelMeter } from "./LiveVoiceCall";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useCoarsePointer } from "@/hooks/useMediaQuery";
import { recorderProblemMessage, useRecorder } from "@/hooks/useRecorder";
import { t } from "@/i18n";
import { acceptFor, DEFAULT_ALLOWED_TYPES, formatClock } from "@/lib/attachments";

const HINT_KEY = "aidp.composerHintDismissed";

function hintDismissed(): boolean {
  try {
    return window.localStorage.getItem(HINT_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * The answer box: typing, a recording (FR-30) and a file (FR-31).
 *
 * Enter sends on a pointer-and-keyboard device, with Shift+Enter for a new line. On a touch device
 * the keyboard has no Shift+Enter, so Enter is the line break and only the Send button sends.
 *
 * The microphone and the paperclip appear only when the screen passes a handler for them, so the
 * owner-side requirements workspace — which has no such routes — keeps the plain composer.
 */
export function Composer({
  disabled,
  onSend,
  autoFocus = false,
  onVoice,
  onFile,
  accept,
  voiceFirst = false,
  focusToken = 0,
  sending = false,
  onTalk,
}: {
  disabled: boolean;
  /**
   * A turn is in flight. The box stays editable (so focus and the keyboard stay where they are and
   * the next answer can be drafted) but nothing more is sent until the interviewer has replied.
   */
  sending?: boolean;
  /** Starts the live spoken call. Absent hides Talk, as it is when the tenant has no live voice. */
  onTalk?: (() => void) | undefined;
  /**
   * Resolves `false` when the answer was not delivered; the text is then put back, so a failed
   * send never costs the person what they wrote.
   */
  onSend: (text: string) => Promise<boolean>;
  autoFocus?: boolean;
  /** Recorded voice. Absent hides the microphone — as it is when the tenant has voice off. */
  onVoice?: ((audio: Blob, durationMs: number) => void) | undefined;
  /** File attachments. Absent hides the paperclip. */
  onFile?: ((file: File) => void) | undefined;
  /** What the picker offers; defaults to the shipped types when the screen names none. */
  accept?: string | undefined;
  /** Voice mode: recording is the primary action, typing stays available beside it. */
  voiceFirst?: boolean;
  /** Changing to a new positive number moves focus into the answer box (the recap's Continue). */
  focusToken?: number;
}): React.JSX.Element {
  const s = t.participant.session;
  const [text, setText] = React.useState("");
  const [announcement, setAnnouncement] = React.useState("");
  const coarse = useCoarsePointer();
  const [hintOpen, setHintOpen] = React.useState(false);
  const id = React.useId();
  const hintId = `${id}-hint`;
  const fileRef = React.useRef<HTMLInputElement>(null);
  const micRef = React.useRef<HTMLButtonElement>(null);
  const stopRef = React.useRef<HTMLButtonElement>(null);
  const textRef = React.useRef<HTMLTextAreaElement>(null);
  React.useEffect(() => {
    if (focusToken > 0) textRef.current?.focus();
  }, [focusToken]);
  const canSend = !disabled && !sending && text.trim().length > 0;

  const recorder = useRecorder((audio, durationMs) => {
    setAnnouncement(s.recordingSending);
    onVoice?.(audio, durationMs);
  });
  const recording = recorder.status === "recording";

  // Focus follows the control that just appeared, and returns to the microphone when the recording
  // bar goes away, so a keyboard user is never left focused on a button that no longer exists.
  const wasRecording = React.useRef(false);
  React.useEffect(() => {
    if (recording) stopRef.current?.focus();
    else if (wasRecording.current) micRef.current?.focus();
    wasRecording.current = recording;
  }, [recording]);

  const submit = (): void => {
    if (!canSend) return;
    const sent = text.trim();
    const result: unknown = onSend(sent);
    setText("");
    // Focus stays in the box, so on a phone the keyboard stays up for the next answer.
    textRef.current?.focus();
    if (result instanceof Promise) {
      void result.then((delivered: unknown) => {
        // Only when nothing new was typed meanwhile: never overwrite what the person wrote next.
        if (delivered === false) setText((current) => (current === "" ? sent : current));
      });
    }
  };

  const showHint = (): void => {
    if (!coarse && !hintDismissed()) setHintOpen(true);
  };
  const dismissHint = (): void => {
    setHintOpen(false);
    try {
      window.localStorage.setItem(HINT_KEY, "1");
    } catch {
      // A per-viewer convenience: not being able to remember it is fine.
    }
  };

  const record = (): void => {
    setAnnouncement(s.recordingStarted);
    void recorder.start();
  };
  const discard = (): void => {
    setAnnouncement(s.recordingDiscarded);
    recorder.cancel();
  };

  const pick = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    // Cleared straight away so picking the same file twice in a row still fires a change event.
    e.target.value = "";
    if (file) onFile?.(file);
  };

  const clock = formatClock(recorder.elapsedMs);

  return (
    <div className="grid gap-1.5">
      {recording ? (
        <div className="flex items-center gap-2" data-recorder="">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-11 shrink-0"
            aria-label={s.recordCancel}
            onClick={discard}
          >
            <XIcon className="size-5" />
          </Button>
          <div className="bg-destructive-soft text-destructive-soft-foreground flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-xl px-3">
            <span
              aria-hidden="true"
              className="bg-destructive size-2.5 shrink-0 rounded-full motion-safe:animate-pulse"
            />
            <span className="hidden text-sm font-medium sm:inline">{s.recordingNow}</span>
            <span
              role="timer"
              aria-label={s.recordingElapsed(clock)}
              className="text-sm font-medium tabular-nums"
            >
              {clock}
            </span>
            <span className="ml-auto">
              <LevelMeter level={recorder.level} />
            </span>
          </div>
          <Button
            ref={stopRef}
            type="button"
            size="icon"
            className="size-11 shrink-0"
            aria-label={s.recordStop}
            onClick={recorder.stop}
          >
            <SendHorizontalIcon className="size-5" />
          </Button>
        </div>
      ) : (
        <form
          className="flex items-end gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label htmlFor={id} className="sr-only">
            {s.composerLabel}
          </label>
          {onFile ? (
            <>
              <input
                ref={fileRef}
                type="file"
                className="sr-only"
                accept={accept ?? acceptFor(DEFAULT_ALLOWED_TYPES)}
                tabIndex={-1}
                aria-hidden="true"
                onChange={pick}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-11 shrink-0"
                disabled={disabled}
                aria-label={s.attach}
                onClick={() => {
                  fileRef.current?.click();
                }}
              >
                <PaperclipIcon className="size-5" />
              </Button>
            </>
          ) : null}
          <Textarea
            id={id}
            ref={textRef}
            value={text}
            rows={1}
            autoFocus={autoFocus && !voiceFirst}
            placeholder={s.composerPlaceholder}
            className="max-h-40 min-h-11 min-w-0 flex-1 resize-none border-0 bg-transparent px-1 text-base placeholder:text-sm shadow-none hover:shadow-none focus-visible:shadow-none"
            enterKeyHint={coarse ? "enter" : "send"}
            aria-describedby={hintOpen ? hintId : undefined}
            disabled={disabled}
            onFocus={showHint}
            onChange={(e) => {
              setText(e.target.value);
              // Typing is the answer to "the microphone is blocked, or type your answer".
              if (recorder.problem) recorder.dismissProblem();
            }}
            onKeyDown={(e) => {
              // Touch keyboards keep Enter as a line break; only the Send button sends there.
              if (coarse) return;
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
          />
          {onVoice ? (
            <Button
              ref={micRef}
              type="button"
              variant={voiceFirst && !onTalk ? "default" : "outline"}
              size="icon"
              className="size-11 shrink-0"
              autoFocus={autoFocus && voiceFirst && !onTalk}
              disabled={disabled || recorder.status === "starting"}
              aria-label={s.recordStart}
              onClick={record}
            >
              <MicIcon className="size-5" />
            </Button>
          ) : null}
          {onTalk ? (
            <Button
              type="button"
              data-talk-button=""
              variant={voiceFirst ? "default" : "outline"}
              className="h-11 shrink-0 px-3"
              aria-label={s.talk}
              title={s.talkHint}
              disabled={disabled || recorder.status === "starting"}
              onClick={onTalk}
            >
              <AudioLinesIcon className="size-5" aria-hidden="true" />
              <span aria-hidden="true" className="hidden sm:inline">
                {s.talk}
              </span>
            </Button>
          ) : null}
          <Button
            type="submit"
            size="icon"
            variant={voiceFirst && (onVoice || onTalk) ? "outline" : "default"}
            className="size-11 shrink-0"
            disabled={!canSend}
            aria-label={s.send}
          >
            <SendHorizontalIcon className="size-5" />
          </Button>
        </form>
      )}
      {hintOpen && !recording ? (
        <p id={hintId} className="text-muted-foreground flex items-center gap-2 px-1 text-xs">
          <span>{s.composerHint}</span>
          <button
            type="button"
            onClick={dismissHint}
            className="text-foreground rounded-sm underline underline-offset-2"
          >
            {s.composerHintDismiss}
          </button>
        </p>
      ) : null}
      {recorder.problem ? (
        <p
          className="bg-destructive-soft text-destructive-soft-foreground flex items-start gap-2 rounded-xl px-3 py-2.5 text-sm leading-snug"
          role="alert"
        >
          <AlertCircleIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span className="flex-1">{recorderProblemMessage(recorder.problem)}</span>
          <button
            type="button"
            onClick={recorder.dismissProblem}
            aria-label={t.app.close}
            className="-m-1 shrink-0 rounded-md p-1 opacity-80 hover:opacity-100"
          >
            <XIcon className="size-4" aria-hidden="true" />
          </button>
        </p>
      ) : null}
      {recorder.maxedOut ? (
        <p className="text-muted-foreground text-xs" role="status">
          {s.recordingMaxed}
        </p>
      ) : null}
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}
