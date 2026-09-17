"use client";

import { MicIcon, PaperclipIcon, SendHorizontalIcon, SquareIcon, XIcon } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { recorderProblemMessage, useRecorder } from "@/hooks/useRecorder";
import { t } from "@/i18n";
import { acceptFor, DEFAULT_ALLOWED_TYPES, formatClock } from "@/lib/attachments";

/**
 * The answer box: typing, a recording (FR-30) and a file (FR-31).
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
}: {
  disabled: boolean;
  onSend: (text: string) => void;
  autoFocus?: boolean;
  /** Recorded voice. Absent hides the microphone — as it is when the tenant has voice off. */
  onVoice?: ((audio: Blob, durationMs: number) => void) | undefined;
  /** File attachments. Absent hides the paperclip. */
  onFile?: ((file: File) => void) | undefined;
  /** What the picker offers; defaults to the shipped types when the screen names none. */
  accept?: string | undefined;
  /** Voice mode: recording is the primary action, typing stays available beside it. */
  voiceFirst?: boolean;
}): React.JSX.Element {
  const s = t.participant.session;
  const [text, setText] = React.useState("");
  const [announcement, setAnnouncement] = React.useState("");
  const id = React.useId();
  const fileRef = React.useRef<HTMLInputElement>(null);
  const micRef = React.useRef<HTMLButtonElement>(null);
  const stopRef = React.useRef<HTMLButtonElement>(null);
  const canSend = !disabled && text.trim().length > 0;

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
    onSend(text.trim());
    setText("");
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
        <div className="flex items-center gap-2">
          <div className="bg-muted flex min-h-11 flex-1 items-center gap-2 rounded-md px-3">
            <span
              aria-hidden="true"
              className="bg-destructive size-2.5 shrink-0 rounded-full motion-safe:animate-pulse"
            />
            <span className="text-sm font-medium">{s.recordingNow}</span>
            <span
              role="timer"
              aria-label={s.recordingElapsed(clock)}
              className="text-muted-foreground text-sm tabular-nums"
            >
              {clock}
            </span>
          </div>
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
          <Button
            ref={stopRef}
            type="button"
            size="icon"
            className="size-11 shrink-0"
            aria-label={s.recordStop}
            onClick={recorder.stop}
          >
            <SquareIcon className="size-5" />
          </Button>
        </div>
      ) : (
        <form
          className="flex items-end gap-2"
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
            value={text}
            rows={1}
            autoFocus={autoFocus && !voiceFirst}
            placeholder={s.composerPlaceholder}
            className="max-h-40 min-h-11 flex-1 resize-none text-base"
            enterKeyHint="send"
            disabled={disabled}
            onChange={(e) => {
              setText(e.target.value);
            }}
            onKeyDown={(e) => {
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
              variant={voiceFirst ? "default" : "outline"}
              size="icon"
              className="size-11 shrink-0"
              autoFocus={autoFocus && voiceFirst}
              disabled={disabled || recorder.status === "starting"}
              aria-label={s.recordStart}
              onClick={record}
            >
              <MicIcon className="size-5" />
            </Button>
          ) : null}
          <Button
            type="submit"
            size="icon"
            variant={voiceFirst ? "outline" : "default"}
            className="size-11 shrink-0"
            disabled={!canSend}
            aria-label={s.send}
          >
            <SendHorizontalIcon className="size-5" />
          </Button>
        </form>
      )}
      {recorder.problem ? (
        <p className="text-destructive text-xs" role="alert">
          {recorderProblemMessage(recorder.problem)}
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
